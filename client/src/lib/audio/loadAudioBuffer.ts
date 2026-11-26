import { fetchApi } from "../api.ts";

async function readAudioError(response: Response): Promise<string> {
  const fallback = `Audio request failed (${response.status}).`;
  try {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const data = (await response.json()) as { error?: unknown };
      if (typeof data.error === "string" && data.error.trim()) {
        return data.error;
      }
      return fallback;
    }
    const text = (await response.text()).slice(0, 300).trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}

export async function fetchAudioBuffer(
  context: AudioContext,
  path: string,
): Promise<AudioBuffer> {
  const response = await fetchApi(path, { credentials: "omit" });
  if (!response.ok) {
    throw new Error(await readAudioError(response));
  }

  const contentType = response.headers.get("content-type") ?? "";
  const data = await response.arrayBuffer();

  if (data.byteLength === 0) {
    throw new Error(
      "The audio server returned an empty response. The track may be unavailable, or the server could not reach YouTube. Try another track.",
    );
  }

  if (
    contentType.includes("application/json") ||
    contentType.includes("text/html")
  ) {
    throw new Error(
      "The audio server returned an error page instead of audio. Check the backend deployment and YouTube access.",
    );
  }

  try {
    return await context.decodeAudioData(data);
  } catch {
    throw new Error(
      "The downloaded audio could not be decoded. Try another track, or update the backend's yt-dlp.",
    );
  }
}
