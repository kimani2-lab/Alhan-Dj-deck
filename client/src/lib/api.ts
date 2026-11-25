const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();

export const API_URL = (
  configuredApiUrl ||
  (process.env.NODE_ENV === "production" ? "" : "http://localhost:5000")
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
