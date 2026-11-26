import assert from "node:assert/strict";
import test from "node:test";
import {
  AUDIO_FALLBACK_FORMAT,
  AUDIO_FIRST_FORMAT,
  buildAudioFormatFallbackArgs,
  isRequestedFormatUnavailable,
  runWithAudioFormatFallback,
} from "../src/ytDlpFormats.js";

test("builds a broad retry while preserving cookies and other yt-dlp args", () => {
  const primaryArgs = [
    "--cookies",
    "/tmp/yt-cookies.txt",
    "-f",
    AUDIO_FIRST_FORMAT,
    "--get-url",
    "https://www.youtube.com/watch?v=abcdefghijk",
  ];

  assert.deepEqual(buildAudioFormatFallbackArgs(primaryArgs), [
    "--cookies",
    "/tmp/yt-cookies.txt",
    "--no-check-formats",
    "-f",
    AUDIO_FALLBACK_FORMAT,
    "--get-url",
    "https://www.youtube.com/watch?v=abcdefghijk",
  ]);
  assert.equal(primaryArgs[3], AUDIO_FIRST_FORMAT);
});

test("retries one time only when yt-dlp reports an unavailable format", async () => {
  const primaryArgs = ["-f", AUDIO_FIRST_FORMAT, "--get-url"];
  const attempts = [];
  let retryLogged = 0;

  const result = await runWithAudioFormatFallback(
    primaryArgs,
    async (args, isFallback) => {
      attempts.push({ args, isFallback });
      if (!isFallback) {
        throw new Error("ERROR: [youtube] Requested format is not available");
      }
      return "resolved";
    },
    () => {
      retryLogged += 1;
    },
  );

  assert.equal(result, "resolved");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].isFallback, true);
  assert.ok(attempts[1].args.includes("--no-check-formats"));
  assert.equal(attempts[1].args[2], AUDIO_FALLBACK_FORMAT);
  assert.equal(retryLogged, 1);
});

test("does not retry unrelated errors or retry a failed fallback again", async () => {
  let attempts = 0;
  await assert.rejects(
    runWithAudioFormatFallback(["-f", AUDIO_FIRST_FORMAT], async () => {
      attempts += 1;
      throw new Error("YouTube request timed out.");
    }),
    /timed out/,
  );
  assert.equal(attempts, 1);

  await assert.rejects(
    runWithAudioFormatFallback(["-f", AUDIO_FIRST_FORMAT], async (_args, fallback) => {
      attempts += 1;
      throw new Error(
        fallback
          ? "ERROR: [youtube] Requested format is not available"
          : "ERROR: [youtube] Requested format is not available",
      );
    }),
    /Requested format is not available/,
  );
  assert.equal(attempts, 3);
});

test("recognizes yt-dlp requested-format failures for the final API status", () => {
  assert.equal(
    isRequestedFormatUnavailable(
      new Error("ERROR: [youtube] Requested format is not available"),
    ),
    true,
  );
  assert.equal(isRequestedFormatUnavailable(new Error("network timeout")), false);
});
