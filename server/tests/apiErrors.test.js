import assert from "node:assert/strict";
import test from "node:test";
import { classifyAudioError } from "../src/apiErrors.js";

test("classifies track, timeout, rate-limit, download, and request failures", () => {
  const cases = [
    ["Requested format is not available", 422, "TRACK_UNAVAILABLE", false],
    ["This video is unavailable", 422, "TRACK_UNAVAILABLE", false],
    ["yt-dlp request timed out", 504, "UPSTREAM_TIMEOUT", true],
    ["Sign in to confirm you’re not a bot", 503, "UPSTREAM_RATE_LIMITED", true],
    ["ffmpeg exited with status 1", 502, "DOWNLOAD_FAILED", true],
    ["", 400, "INVALID_REQUEST", false, { code: "INVALID_REQUEST" }],
  ];

  for (const [message, status, code, retryable, overrides] of cases) {
    const classified = classifyAudioError(
      Object.assign(new Error(message), overrides),
    );
    assert.equal(classified.status, status);
    assert.deepEqual(classified.body, {
      ok: false,
      error: {
        code,
        message: classified.body.error.message,
        retryable,
      },
    });
    assert.ok(classified.body.error.message.length > 0);
  }
});

test("classifies unknown failures as safe retryable internal errors", () => {
  const classified = classifyAudioError(new Error("raw stderr and stack details"));
  assert.equal(classified.status, 500);
  assert.deepEqual(classified.body.error, {
    code: "INTERNAL_ERROR",
    message: "Something went wrong on the audio server. Please try again.",
    retryable: true,
  });
});
