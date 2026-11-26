import assert from "node:assert/strict";
import test from "node:test";
import { createConcurrencyLimiter } from "../src/ytDlpLimiter.js";

test("limits concurrent tasks and runs queued tasks after slots open", async () => {
  const runLimited = createConcurrencyLimiter(2);
  let active = 0;
  let maximumActive = 0;

  const results = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      runLimited(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return index;
      }),
    ),
  );

  assert.equal(maximumActive, 2);
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
});

test("rejects invalid concurrency limits", () => {
  assert.throws(() => createConcurrencyLimiter(0), /positive integer/);
  assert.throws(() => createConcurrencyLimiter(1.5), /positive integer/);
});
