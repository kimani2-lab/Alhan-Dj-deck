import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile, chmod, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import cors from "cors";
import express from "express";
import {
  audioErrorMiddleware,
  createAudioError,
} from "./apiErrors.js";
import { registerAiDjRoutes } from "./aiDj.js";
import {
  getResolvedStreamMetadata,
  parseResolvedStreamUrl,
  StreamUrlCache,
} from "./streamUrlCache.js";
import {
  AUDIO_FALLBACK_FORMAT,
  AUDIO_FIRST_FORMAT,
  runWithAudioFormatFallback,
} from "./ytDlpFormats.js";
import { createConcurrencyLimiter } from "./ytDlpLimiter.js";

const app = express();
const port = Number(process.env.PORT ?? 5000);
const STREAM_PLAYER_CLIENTS = "web_safari,ios,tv_embedded,default";
const runWithYtDlpSlot = createConcurrencyLimiter(2);
const frontendUrl = process.env.FRONTEND_URL?.trim();
const normalizeOrigin = (origin) => origin.trim().replace(/\/+$/, "");
const allowedOrigins = new Set(
  [
    "http://localhost:3000",
    "https://alhan-dj-deck.vercel.app",
    "https://alhan-dj.vercel.app",
    "https://alhan-dj-deck-kimani2-labs-projects.vercel.app",
    "https://alhan-8d-music.co.ke",
    "https://www.alhan-8d-music.co.ke",
    ...(frontendUrl
      ? frontendUrl.split(",").map(normalizeOrigin).filter(Boolean)
      : []),
  ].map(normalizeOrigin),
);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  return (
    allowedOrigins.has(normalized) ||
    /^https?:\/\/(?:localhost|127\.0\.0\.1):\d+$/i.test(normalized) ||
    /^https:\/\/[^/]+\.vercel\.app$/i.test(normalized)
  );
}

app.use(
  cors({
    origin: (origin, callback) => {
      callback(null, isAllowedOrigin(origin));
    },
  }),
);
app.use(express.json({ limit: "32kb" }));

const youtubeCookiesPath =
  process.platform === "win32"
    ? path.join(os.tmpdir(), "yt-cookies.txt")
    : "/tmp/yt-cookies.txt";
let ytDlpCookiesPath = null;

function decodeBase64Cookies(encoded) {
  const compact = encoded.replace(/\s+/g, "");
  const unpadded = compact.replace(/=+$/, "");
  const padding = compact.length - unpadded.length;
  const expectedPadding = (4 - (unpadded.length % 4)) % 4;

  if (
    !unpadded ||
    !/^[A-Za-z0-9+/]+$/.test(unpadded) ||
    padding > 2 ||
    (padding > 0 && compact.length % 4 !== 0) ||
    (padding > 0 && padding !== expectedPadding) ||
    unpadded.length % 4 === 1
  ) {
    throw new Error("YOUTUBE_COOKIES_BASE64 is not valid Base64.");
  }

  const contents = Buffer.from(compact, "base64");
  if (
    contents.length === 0 ||
    contents.toString("base64").replace(/=+$/, "") !== unpadded
  ) {
    throw new Error("YOUTUBE_COOKIES_BASE64 is not valid Base64.");
  }
  return contents;
}

async function ensureCookiesFile() {
  const encoded = process.env.YOUTUBE_COOKIES_BASE64;
  if (encoded !== undefined) {
    try {
      const contents = decodeBase64Cookies(encoded);
      await writeFile(youtubeCookiesPath, contents, { mode: 0o600 });
      await chmod(youtubeCookiesPath, 0o600);
      ytDlpCookiesPath = youtubeCookiesPath;
      console.info(
        `[startup] YouTube cookies loaded from YOUTUBE_COOKIES_BASE64 to ${youtubeCookiesPath} (mode 0600).`,
      );
    } catch (error) {
      ytDlpCookiesPath = null;
      console.error(
        `[startup] YouTube cookies failed to load from YOUTUBE_COOKIES_BASE64: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
    return;
  }

  const configuredFile = process.env.YT_DLP_COOKIES_FILE?.trim();
  if (configuredFile) {
    try {
      const metadata = await stat(configuredFile);
      if (!metadata.isFile()) throw new Error("Configured cookie path is not a file.");
      ytDlpCookiesPath = configuredFile;
      console.info("[startup] YouTube cookies loaded from YT_DLP_COOKIES_FILE.");
    } catch (error) {
      ytDlpCookiesPath = null;
      console.error(
        `[startup] YouTube cookies failed to load from YT_DLP_COOKIES_FILE: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
    return;
  }

  const inline = process.env.YT_DLP_COOKIES?.trim();
  if (!inline) {
    console.info(
      "[startup] YouTube cookies are not configured; yt-dlp will run without --cookies.",
    );
    return;
  }

  let content = inline;
  const looksLikeCookies = (value) =>
    /^#\s*HTTP Cookie File/im.test(value) || /^\S+\t\S*\t/m.test(value);
  if (!looksLikeCookies(content)) {
    try {
      const decoded = Buffer.from(inline, "base64").toString("utf8");
      if (looksLikeCookies(decoded)) content = decoded;
    } catch {
      // Not base64; use the raw value below.
    }
  }

  const file = path.join(os.tmpdir(), "alhan-yt-cookies.txt");
  try {
    await writeFile(file, content, { mode: 0o600 });
    await chmod(file, 0o600);
    ytDlpCookiesPath = file;
    console.info("[startup] YouTube cookies loaded from YT_DLP_COOKIES.");
  } catch (error) {
    ytDlpCookiesPath = null;
    console.error(
      `[startup] YouTube cookies failed to load from YT_DLP_COOKIES: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
}

function getYtDlpBaseArgs({ includeSleepRequests = true } = {}) {
  const args = ["--no-warnings"];
  if (includeSleepRequests) args.push("--sleep-requests", "1");
  if (ytDlpCookiesPath && existsSync(ytDlpCookiesPath)) {
    args.push("--cookies", ytDlpCookiesPath);
  }
  return args;
}

function getYtDlpCommonArgs() {
  const args = [
    "--no-playlist",
    "--socket-timeout",
    "20",
    "--extractor-retries",
    "1",
    "--retries",
    "1",
    "--force-ipv4",
  ];
  const runtime = process.env.YT_DLP_JS_RUNTIME?.trim();
  if (runtime) args.push("--js-runtimes", runtime);
  return args;
}

function logYtDlpAttempt(operation, args) {
  const extractorArgsIndex = args.indexOf("--extractor-args");
  const clientSetting =
    extractorArgsIndex >= 0 ? args[extractorArgsIndex + 1] : null;
  const client = clientSetting?.match(/player_client=([^&]+)/)?.[1] ?? "default";
  const formatIndex = args.findIndex(
    (argument) => argument === "-f" || argument === "--format",
  );
  const format = formatIndex >= 0 ? args[formatIndex + 1] : "default";
  console.info(
    `[yt-dlp] ${operation} attempt; --cookies ${
      args.includes("--cookies") ? "passed" : "not passed"
    }; player_client=${client}; format=${format}.`,
  );
}

function logYtDlpFailure(operation, stderr) {
  console.error(
    `[yt-dlp] ${operation} failed; exact stderr follows:\n${
      stderr || "(empty stderr)"
    }`,
  );
}

function setStreamCorsHeaders(request, response) {
  const origin = request.headers.origin;
  if (isAllowedOrigin(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin || "*");
    if (origin) response.setHeader("Vary", "Origin");
  }
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  response.setHeader("Accept-Ranges", "none");
  response.setHeader(
    "Access-Control-Expose-Headers",
    "Accept-Ranges, Content-Range, Content-Length, Content-Type",
  );
}

function spawnYtDlp(args) {
  const configuredPath = process.env.YT_DLP_PATH?.trim();
  const candidates = configuredPath
    ? [{ command: configuredPath, args }]
    : [
        { command: "yt-dlp", args },
        ...(process.platform === "win32"
          ? [{ command: "py", args: ["-m", "yt_dlp", ...args] }]
          : [
              { command: "python3", args: ["-m", "yt_dlp", ...args] },
              { command: "python", args: ["-m", "yt_dlp", ...args] },
            ]),
      ];

  return new Promise((resolve, reject) => {
    let candidateIndex = 0;
    let lastError;
    const launch = () => {
      const candidate = candidates[candidateIndex++];
      if (!candidate) {
        reject(
          lastError instanceof Error
            ? lastError
            : new Error(
                "yt-dlp is not installed. Install it with `py -m pip install --upgrade yt-dlp` on Windows.",
              ),
        );
        return;
      }
      const child = spawn(candidate.command, candidate.args, {
        windowsHide: true,
      });
      const handleError = (error) => {
        lastError = error;
        if (candidateIndex < candidates.length) {
          launch();
          return;
        }
        reject(
          error.code === "ENOENT"
            ? new Error(
                "yt-dlp is not installed. Install it with `py -m pip install --upgrade yt-dlp` on Windows, or set YT_DLP_PATH to its executable.",
              )
            : error,
        );
      };
      child.once("spawn", () => {
        child.removeListener("error", handleError);
        resolve(child);
      });
      child.once("error", handleError);
    };
    launch();
  });
}

function formatYtDlpError(message) {
  if (/No module named ['"]?yt_dlp|ModuleNotFoundError.*yt_dlp/i.test(message)) {
    return "yt-dlp is not installed. Install it with `py -m pip install --upgrade yt-dlp` on Windows, or set YT_DLP_PATH to its executable.";
  }
  return message;
}

function runYtDlpProcess(args, timeoutMs = 50_000, operation = "command") {
  logYtDlpAttempt(operation, args);
  return new Promise((resolve, reject) => {
    let child;
    let timedOut = false;
    let settled = false;
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      settled = true;
      child?.kill();
      const stderrText = Buffer.concat(stderr).toString("utf8");
      logYtDlpFailure(operation, stderrText);
      const error = new Error("yt-dlp request timed out.");
      error.stderr = stderrText;
      reject(error);
    }, timeoutMs);

    spawnYtDlp(args).then((spawned) => {
      child = spawned;
      if (timedOut) {
        child.kill();
        return;
      }
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        logYtDlpFailure(operation, "");
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          const stderrText = Buffer.concat(stderr).toString("utf8");
          logYtDlpFailure(operation, stderrText);
          const error = new Error(
            formatYtDlpError(
              stderrText.trim() || `yt-dlp exited with status ${code}.`,
            ),
          );
          error.stderr = stderrText;
          reject(error);
          return;
        }
        resolve(Buffer.concat(stdout).toString("utf8"));
      });
    }).catch((error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logYtDlpFailure(operation, "");
      reject(error);
    });
  });
}

const YT_DLP_PRIORITY = {
  stream: 10,
  background: 0,
};

function runYtDlp(
  args,
  timeoutMs = 50_000,
  operation = "command",
  priority = YT_DLP_PRIORITY.background,
) {
  return runWithYtDlpSlot(
    () => runYtDlpProcess(args, timeoutMs, operation),
    { priority },
  );
}

function getYouTubeVideoId(value) {
  if (/^[\w-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com"
    ) {
      const pathId = url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/);
      const id = url.searchParams.get("v") ?? pathId?.[1];
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }
  } catch {
    return null;
  }
  return null;
}

function getBestThumbnail(entry) {
  const thumbnails = Array.isArray(entry.thumbnails)
    ? [...entry.thumbnails]
    : [];
  if (
    thumbnails.length === 0 &&
    typeof entry.thumbnail === "string" &&
    /maxresdefault/i.test(entry.thumbnail)
  ) {
    return entry.thumbnail;
  }

  const usable = thumbnails
    .filter((thumbnail) => typeof thumbnail.url === "string")
    .sort((left, right) => {
      const score = (thumbnail) => {
        const url = thumbnail.url.toLowerCase();
        const quality = url.includes("maxres")
          ? 5
          : url.includes("sddefault")
            ? 4
            : url.includes("hqdefault")
              ? 3
              : url.includes("mqdefault")
                ? 2
                : 1;
        return quality * 1_000_000 + (thumbnail.width ?? 0) * (thumbnail.height ?? 0);
      };
      return score(right) - score(left);
    });

  return (
    usable[0]?.url ??
    `https://i.ytimg.com/vi/${entry.id}/maxresdefault.jpg`
  );
}

function getTrackTitle(title) {
  return title
    .replace(/\s*[\[(](?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?|visuali[sz]er|4k|hd)[^\])]*[\])]/gi, "")
    .replace(/\s*[-|]\s*(?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?)(?:\s|$).*$/i, "")
    .trim();
}

function getTrackArtist(entry, cleanTitle) {
  const channelTitle = String(entry.channel ?? entry.channelTitle ?? entry.uploader ?? "")
    .replace(/\s+-\s+Topic$/i, "")
    .replace(/\s+(?:official|VEVO)$/i, "")
    .trim();
  if (channelTitle && !/^(?:youtube|unknown)$/i.test(channelTitle)) {
    return channelTitle;
  }

  const separator = cleanTitle.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return separator ? separator[1].trim() : "";
}

function normalizeTrack(entry) {
  const title = String(entry.title ?? "").trim();
  const cleanTitle = getTrackTitle(title);
  const channelTitle =
    String(entry.channel ?? entry.channelTitle ?? entry.uploader ?? "").trim() ||
    getTrackArtist(entry, cleanTitle) ||
    "YouTube";
  const artist = channelTitle
    .replace(/\s+-\s+Topic$/i, "")
    .replace(/\s+(?:official|VEVO)$/i, "")
    .trim();
  return {
    id: String(entry.id),
    title,
    channelTitle,
    duration: Number.isFinite(entry.duration) ? entry.duration : null,
    thumbnail: getBestThumbnail(entry),
    ecosystemQuery:
      artist === "YouTube"
        ? `${cleanTitle} similar songs`
        : `${artist} songs`,
  };
}

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.get("/api/status", async (_request, response) => {
  await runYtDlp([...getYtDlpBaseArgs(), "--version"], 10_000, "status");
  response.json({ status: "ok", ytDlp: "available" });
});

const searchCache = new Map();
const searchResolutions = new Map();
const SEARCH_CACHE_TTL_MS = 30 * 60 * 1000;
const SEARCH_CACHE_MAX_ENTRIES = 200;

app.get("/api/search", async (request, response) => {
  const query = String(request.query.q ?? "").trim();
  if (!query || query.length > 200) {
    throw createAudioError("INVALID_REQUEST");
  }

  const videoId = getYouTubeVideoId(query);
  const isUrl = /^https?:\/\//i.test(query);
  if (isUrl && !videoId) {
    throw createAudioError("INVALID_REQUEST");
  }

  const cacheKey = query.replace(/\s+/g, " ").toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < SEARCH_CACHE_TTL_MS) {
    response.setHeader("Cache-Control", "public, max-age=300");
    response.setHeader("X-Search-Cache", "hit");
    response.json(cached.value);
    return;
  }
  if (cached) searchCache.delete(cacheKey);

  let pending = searchResolutions.get(cacheKey);
  const deduped = Boolean(pending);
  if (!pending) {
    pending = (async () => {
      const ytArgs = [
        ...getYtDlpBaseArgs(),
        ...getYtDlpCommonArgs(),
        "--dump-single-json",
        ...(videoId ? [] : ["--flat-playlist"]),
        videoId
          ? `https://www.youtube.com/watch?v=${videoId}`
          : `ytsearch10:${query}`,
      ];
      let result;
      try {
        result = await runYtDlp(ytArgs, 50_000, "search");
      } catch (firstError) {
        if (!/timed out/i.test(
          firstError instanceof Error ? firstError.message : "",
        )) throw firstError;
        result = await runYtDlp([
          ...getYtDlpBaseArgs(),
          ...getYtDlpCommonArgs(),
          "--dump-single-json",
          "--extractor-retries",
          "1",
          "--flat-playlist",
          `ytsearch10:${query}`,
        ], 50_000, "search-timeout-retry");
      }
      const data = JSON.parse(result);
      const entries = Array.isArray(data.entries) ? data.entries : [data];
      const tracks = entries
        .filter((entry) => entry.id && entry.title)
        .map(normalizeTrack);
      const value = { tracks };
      searchCache.set(cacheKey, { createdAt: Date.now(), value });
      while (searchCache.size > SEARCH_CACHE_MAX_ENTRIES) {
        const oldestKey = searchCache.keys().next().value;
        if (oldestKey === undefined) break;
        searchCache.delete(oldestKey);
      }
      return value;
    })();

    searchResolutions.set(cacheKey, pending);
    void pending
      .catch(() => {})
      .finally(() => {
        if (searchResolutions.get(cacheKey) === pending) {
          searchResolutions.delete(cacheKey);
        }
      });
  }

  const value = await pending;
  response.setHeader("Cache-Control", "public, max-age=300");
  response.setHeader("X-Search-Cache", deduped ? "deduped" : "miss");
  response.json(value);
});

const streamUrlCache = new StreamUrlCache();
const streamUrlResolutions = new Map();

async function resolveStreamUrl(videoId) {
  const startedAt = Date.now();
  const cached = streamUrlCache.get(videoId);
  if (cached) {
    const resolveMs = Date.now() - startedAt;
    console.info(
      `[stream] resolve ${videoId}; cacheHit=true; resolveMs=${resolveMs}.`,
    );
    return { ...cached, cacheHit: true, resolveMs };
  }

  const pending = streamUrlResolutions.get(videoId);
  if (pending) {
    try {
      const resolved = await pending;
      const resolveMs = Date.now() - startedAt;
      console.info(
        `[stream] resolve ${videoId}; cacheHit=false; deduped=true; resolveMs=${resolveMs}.`,
      );
      return { ...resolved, cacheHit: false, resolveMs };
    } catch (error) {
      console.error(
        `[stream] resolve ${videoId} failed; cacheHit=false; deduped=true; resolveMs=${
          Date.now() - startedAt
        }; error=${error instanceof Error ? error.message : "unknown error"}.`,
      );
      throw error;
    }
  }

  const resolution = (async () => {
    const args = [
      ...getYtDlpBaseArgs({ includeSleepRequests: false }),
      "--no-playlist",
      "--no-check-certificates",
      "-f",
      AUDIO_FIRST_FORMAT,
      "--extractor-args",
      `youtube:player_client=${STREAM_PLAYER_CLIENTS}`,
      "--get-url",
      `https://www.youtube.com/watch?v=${videoId}`,
    ];
    let formatFallbackUsed = false;
    const output = await runWithAudioFormatFallback(
      args,
      (attemptArgs, isFallback) =>
        runYtDlp(
          attemptArgs,
          50_000,
          isFallback ? "stream-resolve-format-fallback" : "stream-resolve",
          YT_DLP_PRIORITY.stream,
        ),
      () => {
        formatFallbackUsed = true;
        console.warn(
          `[yt-dlp] stream-resolve format unavailable for ${videoId}; retry=1/1; selector=${AUDIO_FALLBACK_FORMAT}; --no-check-formats enabled.`,
        );
      },
    );
    const streamUrl = parseResolvedStreamUrl(output);
    const metadata = getResolvedStreamMetadata(streamUrl);
    const resolvedUrlHost = new URL(streamUrl).hostname;
    const extension =
      metadata.mimeType === "audio/webm"
        ? "webm"
        : metadata.mimeType === "audio/mp4"
          ? "m4a"
          : metadata.mimeType === "audio/mpeg"
            ? "mp3"
            : "unknown";
    console.info(
      `[yt-dlp] stream-resolve succeeded; player_client=${STREAM_PLAYER_CLIENTS}; resolved_url_host=${resolvedUrlHost}; format=${
        formatFallbackUsed ? AUDIO_FALLBACK_FORMAT : AUDIO_FIRST_FORMAT
      }; extension=${extension}; mime=${metadata.mimeType}; retry=${formatFallbackUsed ? "fallback" : "none"}.`,
    );
    const entry = streamUrlCache.set(videoId, {
      streamUrl,
      ...metadata,
    });
    const resolveMs = Date.now() - startedAt;
    console.info(
      `[stream] resolve ${videoId}; cacheHit=false; resolveMs=${resolveMs}.`,
    );
    return { ...entry, cacheHit: false, resolveMs };
  })();

  streamUrlResolutions.set(videoId, resolution);
  try {
    return await resolution;
  } catch (error) {
    console.error(
      `[stream] resolve ${videoId} failed; cacheHit=false; resolveMs=${
        Date.now() - startedAt
      }; error=${error instanceof Error ? error.message : "unknown error"}.`,
    );
    throw error;
  } finally {
    streamUrlResolutions.delete(videoId);
  }
}

function updateStreamMetadata(videoId, streamUrl, upstream) {
  const rangeTotal = upstream.headers
    .get("content-range")
    ?.match(/\/(\d+)$/)?.[1];
  const rawContentLength =
    rangeTotal ??
    (upstream.status === 206 ? null : upstream.headers.get("content-length"));
  const contentLength =
    rawContentLength === null ? null : Number(rawContentLength);
  streamUrlCache.updateMetadata(videoId, streamUrl, {
    mimeType: upstream.headers.get("content-type")?.split(";")[0] ?? null,
    contentLength:
      Number.isSafeInteger(contentLength) && contentLength >= 0
        ? contentLength
        : null,
  });
}

async function proxyStreamRequest(request, response, videoId, retryExpiredUrl = true) {
  const resolved = await resolveStreamUrl(videoId);
  const controller = new AbortController();
  const abortOnDisconnect = () => {
    if (!response.writableEnded) controller.abort();
  };
  response.once("close", abortOnDisconnect);

  let upstream;
  try {
    const headers = {
      "User-Agent":
        request.headers["user-agent"] ??
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
      "Accept-Encoding": "identity",
      Referer: "https://www.youtube.com/",
    };
    if (request.headers.range) headers.Range = request.headers.range;
    upstream = await fetch(resolved.streamUrl, {
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (error) {
    response.removeListener("close", abortOnDisconnect);
    throw error;
  }

  if (
    retryExpiredUrl &&
    (upstream.status === 403 || upstream.status === 410)
  ) {
    await upstream.body?.cancel();
    response.removeListener("close", abortOnDisconnect);
    streamUrlCache.delete(videoId);
    return proxyStreamRequest(request, response, videoId, false);
  }

  if (!upstream.ok && upstream.status !== 206 && upstream.status !== 416) {
    await upstream.body?.cancel();
    response.removeListener("close", abortOnDisconnect);
    const error = new Error(
      `The upstream audio request failed with HTTP ${upstream.status}.`,
    );
    error.videoId = videoId;
    if (upstream.status >= 500) error.code = "DOWNLOAD_FAILED";
    throw error;
  }

  updateStreamMetadata(videoId, resolved.streamUrl, upstream);
  response.status(upstream.status);
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Cache-Control", "no-store");
  for (const header of ["content-range", "etag", "last-modified"]) {
    const value = upstream.headers.get(header);
    if (value) response.setHeader(header, value);
  }
  const contentType = upstream.headers.get("content-type") ?? resolved.mimeType;
  if (contentType) response.setHeader("content-type", contentType);
  const contentRange = upstream.headers.get("content-range");
  const rangeBounds = contentRange?.match(/^bytes (\d+)-(\d+)\/(?:\d+|\*)$/);
  const rangeLength = rangeBounds
    ? Number(rangeBounds[2]) - Number(rangeBounds[1]) + 1
    : null;
  const contentLength =
    upstream.headers.get("content-length") ??
    (rangeLength !== null
      ? String(rangeLength)
      : upstream.status === 200 && resolved.contentLength !== null
        ? String(resolved.contentLength)
        : null);
  if (contentLength) response.setHeader("content-length", contentLength);

  try {
    if (upstream.body) {
      await pipeline(Readable.fromWeb(upstream.body), response);
    } else {
      response.end();
    }
  } finally {
    response.removeListener("close", abortOnDisconnect);
  }
}

app.post("/api/stream/prefetch", async (request, response) => {
  const videoId = String(request.body?.videoId ?? request.body?.id ?? "");
  if (!/^[\w-]{11}$/.test(videoId)) {
    throw createAudioError("INVALID_REQUEST");
  }

  const cached = streamUrlCache.get(videoId);
  console.info(
    `[stream] prefetch attempt for ${videoId}; URL cache ${
      cached ? "hit" : "miss"
    }; --cookies ${
      cached
        ? "not needed (cached URL)"
        : ytDlpCookiesPath && existsSync(ytDlpCookiesPath)
          ? "will be passed"
          : "not configured"
    }.`,
  );
  const { mimeType, expiresAt } = await resolveStreamUrl(videoId);
  response.setHeader("Cache-Control", "no-store");
  response.json({ status: "cached", videoId, mimeType, expiresAt });
});

app.get("/api/stream/:videoId", async (request, response) => {
  const { videoId } = request.params;
  if (!/^[\w-]{11}$/.test(videoId)) {
    throw createAudioError("INVALID_REQUEST");
  }

  const cached = streamUrlCache.get(videoId);
  console.info(
    `[stream] request for ${videoId}; URL cache ${
      cached ? "hit" : "miss"
    }; --cookies ${
      cached
        ? "not needed (cached URL)"
        : ytDlpCookiesPath && existsSync(ytDlpCookiesPath)
          ? "will be passed"
          : "not configured"
    }.`,
  );
  setStreamCorsHeaders(request, response);
  response.setHeader("Accept-Ranges", "bytes");
  await proxyStreamRequest(request, response, videoId);
});

function sanitizeDownloadFilename(title, videoId) {
  const fallback = `alhan-${videoId}`;
  const cleaned = String(title ?? "")
    .normalize("NFKD")
    .replace(/[^\w\s.-]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
  return `${cleaned || fallback}.mp3`;
}

function findCachedTrackTitle(videoId) {
  for (const entry of searchCache.values()) {
    const track = entry?.value?.find((item) => item.id === videoId);
    if (track?.title) return track.title;
  }
  return null;
}

app.get("/api/download", (request, response, next) => {
  const videoId = String(request.query.id ?? "");
  if (!/^[\w-]{11}$/.test(videoId)) {
    next(createAudioError("INVALID_REQUEST"));
    return;
  }

  const title = findCachedTrackTitle(videoId) ?? request.query.title;
  const filename = sanitizeDownloadFilename(title, videoId);
  setStreamCorsHeaders(request, response);

  void (async () => {
    let child;
    let settled = false;
    let stderr = "";

    const cleanup = () => {
      response.removeListener("close", onResponseClose);
      if (child && !child.killed && child.exitCode === null) {
        try {
          child.kill("SIGTERM");
        } catch {
          // The process may already have exited.
        }
      }
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      const failure =
        error instanceof Error ? error : new Error("MP3 download failed.");
      failure.videoId = videoId;
      failure.code = "DOWNLOAD_FAILED";
      if (stderr) failure.stderr = stderr;
      if (!response.headersSent) {
        next(failure);
      } else {
        console.error("[download] Stream failed after headers were sent.", {
          videoId,
          error: failure,
          stderr,
        });
        if (!response.destroyed) response.destroy(failure);
      }
    };

    const onResponseClose = () => {
      if (response.writableEnded) {
        cleanup();
        return;
      }
      settled = true;
      cleanup();
    };

    response.once("close", onResponseClose);

    try {
      const { streamUrl } = await resolveStreamUrl(videoId);
      if (settled || response.destroyed) return;

      const ffmpegHeaders =
        "Referer: https://www.youtube.com/\r\nAccept-Encoding: identity\r\n";
      child = spawn(
        process.env.FFMPEG_PATH?.trim() || "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-user_agent",
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "-headers",
          ffmpegHeaders,
          "-i",
          streamUrl,
          "-vn",
          "-acodec",
          "libmp3lame",
          "-b:a",
          "128k",
          "-f",
          "mp3",
          "pipe:1",
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );

      const started = new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      const closed = new Promise((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
      });

      await started;
      if (settled || response.destroyed) return;

      response.status(200);
      response.setHeader("Content-Type", "audio/mpeg");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      if (typeof response.flushHeaders === "function") response.flushHeaders();

      await new Promise((resolve, reject) => {
        child.stdout.once("end", resolve);
        child.stdout.once("error", reject);
        child.stdout.pipe(response, { end: false });
      });

      const { code, signal } = await closed;
      if (response.destroyed) return;
      if (code !== 0) {
        throw new Error(
          stderr.trim() || `ffmpeg exited with status ${code ?? signal ?? "unknown"}.`,
        );
      }
      settled = true;
      cleanup();
      response.end();
    } catch (error) {
      fail(error);
    } finally {
      if (response.writableEnded || response.destroyed) cleanup();
    }
  })();
});

registerAiDjRoutes(app);
app.use("/api", (_request, _response, next) => {
  next(createAudioError("INVALID_REQUEST"));
});
app.use(audioErrorMiddleware);

void ensureCookiesFile()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : "yt-dlp bootstrap failed.",
    );
  })
  .finally(() => {
    app.listen(port, () => {
      console.log(`DJ audio API listening on http://localhost:${port}`);
    });
  });
