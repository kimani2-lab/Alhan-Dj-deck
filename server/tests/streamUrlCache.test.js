import assert from "node:assert/strict";
import test from "node:test";
import {
  getResolvedStreamMetadata,
  parseResolvedStreamUrl,
  StreamUrlCache,
} from "../src/streamUrlCache.js";

test("expires resolved stream URLs after the configured TTL", () => {
  const cache = new StreamUrlCache({ ttlMs: 100, maxEntries: 2 });
  cache.set(
    "abcdefghijk",
    {
      streamUrl: "https://rr1.googlevideo.com/videoplayback",
      mimeType: "audio/mp4",
      contentLength: 1000,
    },
    1000,
  );

  assert.ok(cache.get("abcdefghijk", 1099));
  assert.equal(cache.get("abcdefghijk", 1100), null);
});

test("evicts the least recently used entry when full", () => {
  const cache = new StreamUrlCache({ ttlMs: 1000, maxEntries: 2 });
  const entry = (id) => ({
    streamUrl: `https://${id}.googlevideo.com/videoplayback`,
    mimeType: "audio/webm",
    contentLength: null,
  });

  cache.set("first", entry("first"), 1000);
  cache.set("second", entry("second"), 1000);
  cache.get("first", 1001);
  cache.set("third", entry("third"), 1001);

  assert.ok(cache.get("first", 1002));
  assert.equal(cache.get("second", 1002), null);
  assert.ok(cache.get("third", 1002));
});

test("parses and validates one YouTube CDN audio URL", () => {
  const streamUrl =
    "https://rr1.googlevideo.com/videoplayback?mime=audio%2Fwebm&clen=2048";

  assert.equal(parseResolvedStreamUrl(`${streamUrl}\n`), streamUrl);
  assert.deepEqual(getResolvedStreamMetadata(streamUrl), {
    mimeType: "audio/webm",
    contentLength: 2048,
  });
  assert.deepEqual(
    getResolvedStreamMetadata(
      "https://rr1.googlevideo.com/videoplayback?mime=audio%2Fwebm",
    ),
    { mimeType: "audio/webm", contentLength: null },
  );
  assert.throws(
    () => parseResolvedStreamUrl("https://example.com/audio"),
    /unsupported audio stream host/,
  );
  assert.throws(
    () =>
      parseResolvedStreamUrl(
        `${streamUrl}\nhttps://rr2.googlevideo.com/videoplayback`,
      ),
    /exactly one audio stream URL/,
  );
});
