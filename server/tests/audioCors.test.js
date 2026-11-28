import assert from "node:assert/strict";
import test from "node:test";
import { setAudioCorsHeaders } from "../src/audioCors.js";

test("allows cross-origin audio and exposes byte-range headers", () => {
  const headers = new Map();
  const response = {
    setHeader(name, value) {
      headers.set(name, value);
    },
  };

  setAudioCorsHeaders(response);

  assert.equal(headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(
    headers.get("Access-Control-Expose-Headers"),
    "Content-Range, Accept-Ranges, Content-Length",
  );
});
