import assert from "node:assert/strict";
import test from "node:test";
import { apiRequest, ApiRequestError } from "../src/lib/api.ts";

test("normalizes HTML gateway pages and retries a retryable gateway once", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response("<html>Bad Gateway</html>", {
      status: 504,
      headers: { "content-type": "text/html" },
    });
  };

  try {
    await assert.rejects(
      apiRequest("/api/search?q=test", undefined, {
        retryGateway: true,
        fallbackMessage: "Search failed.",
      }),
      (error) => {
        assert.ok(error instanceof ApiRequestError);
        assert.equal(error.code, "SERVER_WAKING_UP");
        assert.equal(
          error.message,
          "Audio server is warming up. Please try again in a few seconds.",
        );
        assert.equal(error.retryable, true);
        return true;
      },
    );
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not retry 503 gateway pages and never surfaces their HTML body", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response("<html>private gateway details</html>", {
      status: 503,
      headers: { "content-type": "text/html" },
    });
  };

  try {
    await assert.rejects(
      apiRequest("/api/stream/prefetch", undefined, {
        retryGateway: true,
        fallbackMessage: "Prefetch failed.",
      }),
      (error) => {
        assert.ok(error instanceof ApiRequestError);
        assert.equal(error.code, "SERVER_WAKING_UP");
        assert.equal(error.message.includes("private gateway details"), false);
        return true;
      },
    );
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
