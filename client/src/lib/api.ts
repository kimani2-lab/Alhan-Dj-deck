const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();

export const API_URL = (
  process.env.NODE_ENV === "production"
    ? ""
    : configuredApiUrl || "http://localhost:5000"
).replace(/\/$/, "");

export function apiUrl(path: string): string {
  return `${API_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

export type ApiErrorPayload = {
  code: string;
  message: string;
  retryable: boolean;
};

export class ApiRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;

  constructor(error: ApiErrorPayload, status: number) {
    super(error.message);
    this.name = "ApiRequestError";
    this.code = error.code;
    this.retryable = error.retryable;
    this.status = status;
  }
}

type ApiRequestOptions = {
  retryGateway?: boolean;
  responseType?: "json" | "blob" | "media";
  fallbackMessage?: string;
};

type ApiRequestResult<T> = {
  response: Response;
  data: T;
};

const SERVER_WAKING_UP: ApiErrorPayload = {
  code: "SERVER_WAKING_UP",
  message: "Audio server is warming up. Please try again in a few seconds.",
  retryable: true,
};

const OFFLINE_ERROR: ApiErrorPayload = {
  code: "SERVER_UNAVAILABLE",
  message: "Could not reach the audio server. Check your connection and try again.",
  retryable: true,
};

function isGatewayStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function getErrorPayload(
  body: unknown,
  fallbackMessage: string,
): ApiErrorPayload {
  if (!body || typeof body !== "object") {
    return {
      code: "REQUEST_FAILED",
      message: fallbackMessage,
      retryable: false,
    };
  }

  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") {
    return {
      code: "REQUEST_FAILED",
      message: fallbackMessage,
      retryable: false,
    };
  }

  const payload = error as Partial<ApiErrorPayload>;
  if (
    typeof payload.code !== "string" ||
    typeof payload.message !== "string" ||
    typeof payload.retryable !== "boolean"
  ) {
    return {
      code: "REQUEST_FAILED",
      message: fallbackMessage,
      retryable: false,
    };
  }
  return {
    code: payload.code,
    message: payload.message,
    retryable: payload.retryable,
  };
}

async function fetchResponse(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  const upstreamSignal = init?.signal;
  const abortUpstream = () => controller.abort();
  upstreamSignal?.addEventListener("abort", abortUpstream, { once: true });

  try {
    return await fetch(apiUrl(path), {
      ...init,
      signal: controller.signal,
    });
  } catch {
    if (upstreamSignal?.aborted) throw new DOMException("Aborted", "AbortError");
    throw new ApiRequestError(OFFLINE_ERROR, 0);
  } finally {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener("abort", abortUpstream);
  }
}

export async function apiRequest<T = unknown>(
  path: string,
  init?: RequestInit,
  options: ApiRequestOptions = {},
): Promise<ApiRequestResult<T>> {
  const responseType = options.responseType ?? "json";
  const fallbackMessage =
    options.fallbackMessage ?? "The request could not be completed. Please try again.";
  const maxAttempts = options.retryGateway ? 2 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetchResponse(path, init);
    const contentType = response.headers.get("content-type") ?? "";
    const isJson = contentType.toLowerCase().includes("application/json");

    if (!isJson) {
      if (isGatewayStatus(response.status)) {
        await response.body?.cancel();
        if (
          attempt + 1 < maxAttempts &&
          (response.status === 502 || response.status === 504)
        ) {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          continue;
        }
        throw new ApiRequestError(SERVER_WAKING_UP, response.status);
      }

      if (response.ok && responseType === "blob") {
        return { response, data: (await response.blob()) as T };
      }

      if (response.ok && responseType === "media") {
        await response.body?.cancel();
        return { response, data: null as T };
      }

      await response.body?.cancel();
      throw new ApiRequestError(
        {
          code: "INVALID_RESPONSE",
          message: fallbackMessage,
          retryable: false,
        },
        response.status,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiRequestError(
        {
          code: "INVALID_RESPONSE",
          message: fallbackMessage,
          retryable: false,
        },
        response.status,
      );
    }

    if (!response.ok) {
      const error = getErrorPayload(body, fallbackMessage);
      if (
        attempt + 1 < maxAttempts &&
        (response.status === 502 || response.status === 504) &&
        error.retryable
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        continue;
      }
      if (
        isGatewayStatus(response.status) &&
        !getErrorPayload(body, "").message
      ) {
        throw new ApiRequestError(SERVER_WAKING_UP, response.status);
      }
      throw new ApiRequestError(error, response.status);
    }

    if (responseType === "blob") {
      throw new ApiRequestError(
        {
          code: "INVALID_RESPONSE",
          message: fallbackMessage,
          retryable: false,
        },
        response.status,
      );
    }

    return { response, data: body as T };
  }

  throw new ApiRequestError(SERVER_WAKING_UP, 502);
}
