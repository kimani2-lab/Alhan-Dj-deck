const DEFAULT_TTL_MS = 25 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 200;

export class StreamUrlCache {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  get(videoId, now = Date.now()) {
    const entry = this.entries.get(videoId);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.entries.delete(videoId);
      return null;
    }

    this.entries.delete(videoId);
    this.entries.set(videoId, entry);
    return entry;
  }

  set(videoId, { streamUrl, mimeType, contentLength }, now = Date.now()) {
    this.entries.delete(videoId);
    this.entries.set(videoId, {
      streamUrl,
      mimeType,
      contentLength,
      expiresAt: now + this.ttlMs,
    });
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
    return this.entries.get(videoId);
  }

  updateMetadata(videoId, streamUrl, { mimeType, contentLength }) {
    const entry = this.entries.get(videoId);
    if (!entry || entry.streamUrl !== streamUrl) return;
    entry.mimeType = mimeType || entry.mimeType;
    if (Number.isSafeInteger(contentLength) && contentLength >= 0) {
      entry.contentLength = contentLength;
    }
  }

  delete(videoId) {
    this.entries.delete(videoId);
  }
}

export function parseResolvedStreamUrl(output) {
  const urls = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("https://"));
  if (urls.length !== 1) {
    throw new Error("yt-dlp did not return exactly one audio stream URL.");
  }

  let url;
  try {
    url = new URL(urls[0]);
  } catch {
    throw new Error("yt-dlp returned an invalid audio stream URL.");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname.toLowerCase().endsWith(".googlevideo.com")
  ) {
    throw new Error("yt-dlp returned an unsupported audio stream host.");
  }
  return url.toString();
}

export function getResolvedStreamMetadata(streamUrl) {
  const url = new URL(streamUrl);
  const requestedMimeType = url.searchParams.get("mime");
  const extensionMimeType = /\.webm(?:$|\?)/i.test(url.pathname)
    ? "audio/webm"
    : /\.m4a(?:$|\?)/i.test(url.pathname)
      ? "audio/mp4"
      : null;
  const mimeType =
    requestedMimeType?.startsWith("audio/")
      ? requestedMimeType
      : extensionMimeType ?? "audio/mp4";
  const rawContentLength = url.searchParams.get("clen");
  const contentLength =
    rawContentLength === null ? null : Number(rawContentLength);

  return {
    mimeType,
    contentLength:
      Number.isSafeInteger(contentLength) && contentLength >= 0
        ? contentLength
        : null,
  };
}
