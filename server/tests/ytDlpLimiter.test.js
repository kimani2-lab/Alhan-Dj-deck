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

test("runs higher-priority queued tasks first", async () => {
  const runLimited = createConcurrencyLimiter(1);
  const order = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const active = runLimited(async () => {
    await gate;
    order.push("active");
  });
  const background = runLimited(async () => {
    order.push("background");
  });
  const stream = runLimited(async () => {
    order.push("stream");
  }, { priority: 10 });

  release();
  await Promise.all([active, background, stream]);

  assert.deepEqual(order, ["active", "stream", "background"]);
});

test("rejects invalid concurrency limits", () => {
  assert.throws(() => createConcurrencyLimiter(0), /positive integer/);
  assert.throws(() => createConcurrencyLimiter(1.5), /positive integer/);
});
