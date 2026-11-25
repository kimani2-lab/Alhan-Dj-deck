const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();

export const API_URL = (
  process.env.NODE_ENV === "production"
    ? ""
    : (configuredApiUrl || "http://localhost:5000")
).replace(/\/$/, "");

export function apiUrl(path: string): string {
  return `${API_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function fetchApi(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(apiUrl(path), init);
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
    throw new Error(
      text.trim()
        ? `${fallbackMessage} (${response.status}: ${text.trim().slice(0, 180)})`
        : fallbackMessage,
    );
  }

  try {
    return JSON.parse(text) as T & { error?: string };
  } catch {
    throw new Error(`${fallbackMessage}: unexpected JSON response.`);
  }
}
