import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
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

let ytDlpCookiesPath = process.env.YT_DLP_COOKIES_FILE?.trim() || null;

async function ensureCookiesFile() {
  if (ytDlpCookiesPath) return;
  const inline = process.env.YT_DLP_COOKIES?.trim();
  if (!inline) return;

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
  await writeFile(file, content, { mode: 0o600 });
  ytDlpCookiesPath = file;
  console.log("Loaded YouTube cookies for yt-dlp.");
}

function getYtDlpCommonArgs() {
  const args = [
    "--no-warnings",
    "--no-playlist",
    "--socket-timeout",
    "20",
    "--retries",
    "2",
    "--force-ipv4",
  ];
  const runtime = process.env.YT_DLP_JS_RUNTIME?.trim();
  if (runtime) args.push("--js-runtimes", runtime);
  if (ytDlpCookiesPath) args.push("--cookies", ytDlpCookiesPath);
  return args;
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

function runYtDlp(args, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    let child;
    let timedOut = false;
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      timedOut = true;
      child?.kill();
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
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(
            new Error(
              formatYtDlpError(
                Buffer.concat(stderr).toString("utf8").trim() ||
                  `yt-dlp exited with status ${code}.`,
              ),
            ),
          );
          return;
        }
        resolve(Buffer.concat(stdout).toString("utf8"));
      });
    }).catch((error) => {
      clearTimeout(timer);
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
    await runYtDlp(["--version"], 10_000);
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
      "--dump-single-json",
      "--no-warnings",
      "--socket-timeout",
      "20",
      "--retries",
      "2",
      ...(videoId ? [] : ["--flat-playlist"]),
      videoId
        ? `https://www.youtube.com/watch?v=${videoId}`
        : `ytsearch10:${query}`,
    ];
    let result;
    try {
      result = await runYtDlp(ytArgs);
    } catch (firstError) {
      if (!/timed out|status 429|too many requests/i.test(
        firstError instanceof Error ? firstError.message : "",
      )) throw firstError;
      result = await runYtDlp([
        "--dump-single-json",
        "--no-warnings",
        "--socket-timeout",
        "30",
        "--extractor-retries",
        "2",
        "--flat-playlist",
        `ytsearch10:${query}`,
      ], 120_000);
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
      finish(
        new Error(
          "YouTube did not send any audio before the request timed out. The video may be unavailable or the server IP may be blocked.",
        ),
      );
    }, 60_000);

    spawnYtDlp(args)
      .then((spawned) => {
        child = spawned;
        if (response.destroyed) {
          child.kill();
          finish(new Error("The client disconnected."));
          return;
        }

        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString("utf8");
          if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
        });
        child.on("error", (error) => finish(error));
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
          if (started) return;
          if (clientClosed) {
            finish(new Error("The client disconnected."));
            return;
          }
          finish(
            new Error(
              formatYtDlpError(
                stderr.trim() || `yt-dlp exited with status ${code}.`,
              ),
            ),
          );
        });
      })
      .catch((error) => finish(error));
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
        !/sign in to confirm|not a bot|requested format|http error 403|status 429|too many requests|timed out|no audio/i.test(
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
      );
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (
        !/sign in to confirm|not a bot|requested format|http error 403|status 429|too many requests|timed out/i.test(
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
