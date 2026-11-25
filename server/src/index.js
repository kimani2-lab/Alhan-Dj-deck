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
const allowedOrigins = [
  "http://localhost:3000",
  "https://alhan-dj-deck.vercel.app",
  "https://alhan-dj.vercel.app",
  "https://alhan-8d-music.co.ke",
  "https://www.alhan-8d-music.co.ke",
  ...(frontendUrl ? frontendUrl.split(",").map((origin) => origin.trim()).filter(Boolean) : []),
];

app.use(
  cors({
    origin: (origin, callback) => {
      const vercelPreview =
        /^https:\/\/[^/]+\.vercel\.app$/i.test(origin ?? "");
      callback(
        null,
        !origin ||
          allowedOrigins.includes(origin) ||
          vercelPreview,
      );
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

function setStreamCorsHeaders(request, response) {
  const origin = request.headers.origin;
  if (!origin || allowedOrigins.includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin || "*");
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

app.get("/api/search", async (request, response) => {
  const query = String(request.query.q ?? "").trim();
  if (!query || query.length > 200) {
    response.status(400).json({ error: "Enter a search query (up to 200 characters)." });
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
    response.json({ tracks });
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : "YouTube search failed.",
    });
  }
});

function streamYtDlp(response, videoId, args, download = false) {
  let timedOut = false;
  let process;
  let timeout;
  let responseStarted = false;
  let stderr = "";

  const onClose = () => {
    clearTimeout(timeout);
    if (process && !process.killed) process.kill();
  };
  response.on("close", () => {
    onClose();
  });

  spawnYtDlp(args).then((child) => {
    process = child;
    if (response.destroyed) {
      process.kill();
      return;
    }

    timeout = setTimeout(() => {
      timedOut = true;
      process.kill();
    }, 120_000);

    process.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    process.on("error", (error) => {
      clearTimeout(timeout);
      if (!response.headersSent) {
        response.status(502).json({
          error: formatYtDlpError(error.message),
        });
      } else {
        response.destroy(error);
      }
    });
    process.stdout.once("data", () => {
      responseStarted = true;
      response.setHeader("Content-Type", download ? "audio/mpeg" : "application/octet-stream");
      response.setHeader("Cache-Control", "no-store");
      if (download) {
        response.setHeader(
          "Content-Disposition",
          `attachment; filename="alhan-${videoId}.mp3"`,
        );
      }
    });
    process.stdout.pipe(response);
    process.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && !responseStarted && !response.headersSent) {
        response.status(502).json({
          error: timedOut
            ? "yt-dlp audio request timed out."
            : formatYtDlpError(
                stderr.trim() || `yt-dlp exited with status ${code}.`,
              ),
        });
      }
    });
  }).catch((error) => {
    clearTimeout(timeout);
    if (!response.headersSent) {
      response.status(502).json({
        error: error instanceof Error ? error.message : "Could not start yt-dlp.",
      });
    }
  });
}

app.get("/api/stream/:videoId", (request, response) => {
  const { videoId } = request.params;
  if (!/^[\w-]{11}$/.test(videoId)) {
    response.status(400).json({ error: "A valid YouTube video ID is required." });
    return;
  }

  setStreamCorsHeaders(request, response);
  streamYtDlp(
    response,
    videoId,
    [
      "--quiet",
      "--no-warnings",
      "--no-playlist",
      "-f",
      "bestaudio[ext=m4a]/bestaudio",
      "-o",
      "-",
      `https://www.youtube.com/watch?v=${videoId}`,
    ],
  );
});

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
      const output = await runYtDlp([
        "--quiet",
        "--no-warnings",
        "--no-playlist",
        "--extract-audio",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "0",
        "-o",
        outputTemplate,
        `https://www.youtube.com/watch?v=${videoId}`,
      ], 180_000);
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

void ensureYtDlp()
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
