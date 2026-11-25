const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();

export const API_URL = (
  configuredApiUrl ||
  (process.env.NODE_ENV === "production"
    ? "https://alhan-dj-deck-1.onrender.com"
    : "http://localhost:5000")
).replace(/\/$/, "");

export function apiUrl(path: string): string {
  return `${API_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function fetchApi(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  let lastReason: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 45_000);
    const upstreamSignal = init?.signal;
    const abortUpstream = () => controller.abort();
    upstreamSignal?.addEventListener("abort", abortUpstream, { once: true });

    try {
      const response = await fetch(apiUrl(path), {
        ...init,
        signal: controller.signal,
      });
      return response;
    } catch (reason) {
      lastReason = reason;
      if (attempt < 2) {
        await new Promise((resolve) => window.setTimeout(resolve, 750 * (attempt + 1)));
      }
    } finally {
      window.clearTimeout(timeout);
      upstreamSignal?.removeEventListener("abort", abortUpstream);
    }
  }

  if (lastReason instanceof DOMException && lastReason.name === "AbortError") {
    throw new Error(
      "The audio server is waking up or taking too long. Wait a few seconds and try again.",
    );
  }
  throw new Error(
    `Could not reach the audio server at ${API_URL}. Check internet access, CORS, and the Render service status.`,
  );
}

export async function readApiJson<T>(
  response: Response,
  fallbackMessage: string,
): Promise<T & { error?: string }> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();

  if (!contentType.includes("application/json")) {
    if (text.includes("DEPLOYMENT_NOT_FOUND")) {
      throw new Error("The live frontend deployment is unavailable.");
    }
    if (text.includes("<!DOCTYPE html") || text.includes("<html")) {
      throw new Error(
        "The live audio server returned a page instead of JSON. Check the NEXT_PUBLIC_API_URL deployment setting.",
      );
    }
    throw new Error(fallbackMessage);
  }

  try {
    return JSON.parse(text) as T & { error?: string };
  } catch {
    throw new Error(`${fallbackMessage}: unexpected JSON response.`);
  }
}
