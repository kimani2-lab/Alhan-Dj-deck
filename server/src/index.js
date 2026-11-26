import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile, chmod, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import cors from "cors";
import express from "express";
import { registerAiDjRoutes } from "./aiDj.js";

const app = express();
const port = Number(process.env.PORT ?? 5000);
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

async function ensureYtDlp() {
  if (process.env.YT_DLP_PATH?.trim()) return;
  if (process.platform === "win32") return;
  const executable = path.join(os.tmpdir(), process.platform === "win32" ? "alhan-yt-dlp.exe" : "alhan-yt-dlp");
  try {
    const metadata = await stat(executable);
    if (metadata.isFile() && metadata.size > 100_000) {
      process.env.YT_DLP_PATH = executable;
      return;
    }
  } catch {
    // Download below.
  }

  const response = await fetch(
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp",
  );
  if (!response.ok) {
    throw new Error(`Could not download yt-dlp (${response.status}).`);
  }
  const bytes = await response.arrayBuffer();
  await writeFile(executable, Buffer.from(bytes), { mode: 0o755 });
  await chmod(executable, 0o755);
  process.env.YT_DLP_PATH = executable;
  console.log("Downloaded yt-dlp runtime.");
}

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

function getYtDlpBaseArgs() {
  const args = ["--no-warnings", "--sleep-requests", "1"];
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
  console.info(
    `[yt-dlp] ${operation} attempt; --cookies ${
      args.includes("--cookies") ? "passed" : "not passed"
    }; player_client=${client}.`,
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

function runYtDlp(args, timeoutMs = 90_000, operation = "command") {
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
      logYtDlpFailure(operation, Buffer.concat(stderr).toString("utf8"));
      reject(new Error("yt-dlp request timed out."));
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
          reject(
            new Error(
              formatYtDlpError(
                stderrText.trim() || `yt-dlp exited with status ${code}.`,
              ),
            ),
          );
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
  try {
    await runYtDlp([...getYtDlpBaseArgs(), "--version"], 10_000, "status");
    response.json({ status: "ok", ytDlp: "available" });
  } catch (error) {
    response.status(503).json({
      status: "degraded",
      ytDlp: "unavailable",
      error: error instanceof Error ? error.message : "yt-dlp unavailable",
    });
  }
});

const searchCache = new Map();
const SEARCH_CACHE_TTL_MS = 30 * 60 * 1000;

app.get("/api/search", async (request, response) => {
  const query = String(request.query.q ?? "").trim();
  if (!query || query.length > 200) {
    response.status(400).json({ error: "Enter a search query (up to 200 characters)." });
    return;
  }

  const cacheKey = query.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < SEARCH_CACHE_TTL_MS) {
    response.setHeader("Cache-Control", "public, max-age=300");
    response.json(cached.value);
    return;
  }

  try {
    const videoId = getYouTubeVideoId(query);
    const isUrl = /^https?:\/\//i.test(query);
    if (isUrl && !videoId) {
      response.status(400).json({ error: "Paste a valid YouTube video URL." });
      return;
    }
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
      result = await runYtDlp(ytArgs, 90_000, "search");
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
      ], 120_000, "search-timeout-retry");
    }
    const data = JSON.parse(result);
    const entries = Array.isArray(data.entries) ? data.entries : [data];
    const tracks = entries
      .filter((entry) => entry.id && entry.title)
      .map(normalizeTrack);
    const value = { tracks };
    searchCache.set(cacheKey, { createdAt: Date.now(), value });
    if (searchCache.size > 200) {
      const oldestKey = searchCache.keys().next().value;
      if (oldestKey) searchCache.delete(oldestKey);
    }
    response.setHeader("Cache-Control", "public, max-age=300");
    response.json(value);
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : "YouTube search failed.",
    });
  }
});

const PLAYER_CLIENTS = [null, "android", "ios", "tv", "mweb"];

function buildAudioArgs(videoId, client) {
  return [
    ...getYtDlpBaseArgs(),
    ...getYtDlpCommonArgs(),
    "--quiet",
    "-f",
    "bestaudio[ext=m4a]/bestaudio/best",
    "-o",
    "-",
    ...(client ? ["--extractor-args", `youtube:player_client=${client}`] : []),
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
}

function sniffAudioContentType(chunk) {
  if (chunk.length >= 8 && chunk.toString("ascii", 4, 8) === "ftyp") {
    return "audio/mp4";
  }
  if (
    chunk.length >= 4 &&
    chunk[0] === 0x1a &&
    chunk[1] === 0x45 &&
    chunk[2] === 0xdf &&
    chunk[3] === 0xa3
  ) {
    return "audio/webm";
  }
  if (chunk.length >= 3 && chunk.toString("ascii", 0, 3) === "ID3") {
    return "audio/mpeg";
  }
  if (chunk.length >= 2 && chunk[0] === 0xff && (chunk[1] & 0xe0) === 0xe0) {
    return "audio/mpeg";
  }
  return null;
}

function attemptStream(response, videoId, args, download) {
  return new Promise((resolve, reject) => {
    let child = null;
    let settled = false;
    let started = false;
    let clientClosed = false;
    let stderr = "";
    let timer = null;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      response.removeListener("close", onClientClose);
      if (error) reject(error);
      else resolve();
    };

    const onClientClose = () => {
      clientClosed = true;
      if (child && !child.killed) child.kill();
    };
    response.once("close", onClientClose);

    timer = setTimeout(() => {
      if (started) return;
      if (child && !child.killed) child.kill();
      logYtDlpFailure("stream", stderr);
      finish(
        new Error(
          "YouTube did not send any audio before the request timed out. The video may be unavailable or the server IP may be blocked.",
        ),
      );
    }, 60_000);

    logYtDlpAttempt("stream", args);
    spawnYtDlp(args)
      .then((spawned) => {
        child = spawned;
        if (response.destroyed) {
          child.kill();
          finish(new Error("The client disconnected."));
          return;
        }
        if (settled) {
          child.kill();
          return;
        }

        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", (error) => {
          logYtDlpFailure("stream", stderr);
          finish(error);
        });
        child.stdout.once("data", (firstChunk) => {
          if (started || settled) return;
          if (response.destroyed) {
            child.kill();
            finish(new Error("The client disconnected."));
            return;
          }
          started = true;
          if (timer) clearTimeout(timer);
          settled = true;

          const contentType = download
            ? "audio/mpeg"
            : sniffAudioContentType(firstChunk) ?? "audio/mp4";
          response.setHeader("Content-Type", contentType);
          response.setHeader("Cache-Control", "no-store");
          if (download) {
            response.setHeader(
              "Content-Disposition",
              `attachment; filename="alhan-${videoId}.mp3"`,
            );
          }

          response.write(firstChunk);
          child.stdout.pause();
          child.stdout.pipe(response);
          resolve();
        });
        child.on("close", (code) => {
          if (started) {
            if (code !== 0) logYtDlpFailure("stream", stderr);
            return;
          }
          if (settled) return;
          if (clientClosed) {
            finish(new Error("The client disconnected."));
            return;
          }
          logYtDlpFailure("stream", stderr);
          finish(
            new Error(
              formatYtDlpError(
                stderr.trim() || `yt-dlp exited with status ${code}.`,
              ),
            ),
          );
        });
      })
      .catch((error) => {
        logYtDlpFailure("stream", "");
        finish(error);
      });
  });
}

async function streamYtDlp(response, videoId, download = false) {
  let lastError = null;
  for (const client of PLAYER_CLIENTS) {
    if (response.destroyed || response.headersSent) return;
    try {
      await attemptStream(response, videoId, buildAudioArgs(videoId, client), download);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (response.destroyed || response.headersSent) return;
      if (
        /sign in to confirm|not a bot|http error 403|status 429|too many requests/i.test(
          lastError.message,
        )
      ) {
        console.warn(
          "[yt-dlp] Stream bot-check/rate-limit response; stopping player-client retries.",
        );
        break;
      }
      if (
        !/requested format|timed out|no audio/i.test(
          lastError.message,
        )
      ) {
        break;
      }
    }
  }

  if (!response.headersSent && !response.destroyed) {
    response.status(502).json({
      error:
        lastError?.message ||
        "Could not start the audio stream. The track may be unavailable or YouTube is blocking the server.",
    });
  }
}

app.get("/api/stream/:videoId", (request, response) => {
  const { videoId } = request.params;
  if (!/^[\w-]{11}$/.test(videoId)) {
    response.status(400).json({ error: "A valid YouTube video ID is required." });
    return;
  }

  setStreamCorsHeaders(request, response);
  void streamYtDlp(response, videoId);
});

async function runYtDlpWithClientFallback(videoId, outputTemplate) {
  let lastError = null;
  for (const client of PLAYER_CLIENTS) {
    try {
      return await runYtDlp(
        [
          ...getYtDlpBaseArgs(),
          ...getYtDlpCommonArgs(),
          "--quiet",
          "--extract-audio",
          "--audio-format",
          "mp3",
          "--audio-quality",
          "0",
          ...(client
            ? ["--extractor-args", `youtube:player_client=${client}`]
            : []),
          "-o",
          outputTemplate,
          `https://www.youtube.com/watch?v=${videoId}`,
        ],
        180_000,
        "download",
      );
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (
        /sign in to confirm|not a bot|http error 403|status 429|too many requests/i.test(
          lastError.message,
        )
      ) {
        console.warn(
          "[yt-dlp] Download bot-check/rate-limit response; stopping player-client retries.",
        );
        break;
      }
      if (
        !/requested format|timed out/i.test(
          lastError.message,
        )
      ) {
        throw lastError;
      }
    }
  }
  throw lastError ?? new Error("yt-dlp could not create the MP3 download.");
}

app.get("/api/download", (request, response) => {
  const videoId = String(request.query.id ?? "");
  if (!/^[\w-]{11}$/.test(videoId)) {
    response.status(400).json({ error: "A valid YouTube video ID is required." });
    return;
  }

  setStreamCorsHeaders(request, response);
  void (async () => {
    let tempDirectory = "";
    try {
      tempDirectory = await mkdtemp(path.join(os.tmpdir(), "alhan-dj-"));
      const outputTemplate = path.join(tempDirectory, "%(id)s.%(ext)s");
      const output = await runYtDlpWithClientFallback(videoId, outputTemplate);
      void output;

      const files = await readdir(tempDirectory);
      const mp3File = files.find((file) => file.toLowerCase().endsWith(".mp3"));
      if (!mp3File) {
        throw new Error("yt-dlp did not create an MP3 file.");
      }

      const filePath = path.join(tempDirectory, mp3File);
      response.setHeader("Content-Type", "audio/mpeg");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="alhan-${videoId}.mp3"`,
      );

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        void rm(tempDirectory, { recursive: true, force: true });
      };
      response.once("finish", cleanup);
      response.once("close", cleanup);
      createReadStream(filePath).pipe(response);
    } catch (error) {
      if (tempDirectory) {
        await rm(tempDirectory, { recursive: true, force: true });
      }
      if (!response.headersSent) {
        response.status(502).json({
          error: error instanceof Error ? error.message : "Could not create the MP3 download.",
        });
      } else {
        response.destroy(error instanceof Error ? error : new Error("MP3 download failed."));
      }
    }
  })();
});

registerAiDjRoutes(app);

void Promise.all([ensureYtDlp(), ensureCookiesFile()])
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
