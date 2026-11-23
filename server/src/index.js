import { spawn } from "node:child_process";
import cors from "cors";
import express from "express";

const app = express();
const port = Number(process.env.PORT ?? 4000);
const allowedOrigins = (process.env.CLIENT_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      const localDevelopmentOrigin =
        !process.env.CLIENT_ORIGIN &&
        /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin ?? "");
      callback(
        null,
        !origin || allowedOrigins.includes(origin) || localDevelopmentOrigin,
      );
    },
  }),
);
app.use(express.json({ limit: "32kb" }));

function runYtDlp(args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const process = spawn("yt-dlp", args, { windowsHide: true });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      process.kill();
      reject(new Error("yt-dlp request timed out."));
    }, timeoutMs);

    process.stdout.on("data", (chunk) => stdout.push(chunk));
    process.stderr.on("data", (chunk) => stderr.push(chunk));
    process.on("error", (error) => {
      clearTimeout(timer);
      reject(
        error.code === "ENOENT"
          ? new Error("yt-dlp is not installed or is not available on PATH.")
          : error,
      );
    });
    process.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            Buffer.concat(stderr).toString("utf8").trim() ||
              `yt-dlp exited with status ${code}.`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
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
    const result = await runYtDlp([
      "--dump-single-json",
      "--no-warnings",
      ...(videoId ? [] : ["--flat-playlist"]),
      videoId
        ? `https://www.youtube.com/watch?v=${videoId}`
        : `ytsearch10:${query}`,
    ]);
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
  const process = spawn(
    "yt-dlp",
    args,
    { windowsHide: true },
  );
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    process.kill();
  }, 120_000);
  let responseStarted = false;
  let stderr = "";

  process.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  process.on("error", (error) => {
    clearTimeout(timeout);
    if (!response.headersSent) {
      response.status(502).json({
        error:
          error.code === "ENOENT"
            ? "yt-dlp is not installed or is not available on PATH."
            : error.message,
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
          : stderr.trim() || `yt-dlp exited with status ${code}.`,
      });
    }
  });
  response.on("close", () => {
    clearTimeout(timeout);
    if (!process.killed) process.kill();
  });
}

app.get("/api/stream/:videoId", (request, response) => {
  const { videoId } = request.params;
  if (!/^[\w-]{11}$/.test(videoId)) {
    response.status(400).json({ error: "A valid YouTube video ID is required." });
    return;
  }

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

  streamYtDlp(
    response,
    videoId,
    [
      "--quiet",
      "--no-warnings",
      "--no-playlist",
      "--extract-audio",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
      "-o",
      "-",
      `https://www.youtube.com/watch?v=${videoId}`,
    ],
    true,
  );
});

app.listen(port, () => {
  console.log(`DJ audio API listening on http://localhost:${port}`);
});
