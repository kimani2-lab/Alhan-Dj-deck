import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEcosystemQueue,
  EcosystemQueueManager,
} from "../src/utils/ecosystemQueue.ts";
import { getThumbnailFallbacks, normalizeTrack } from "../src/lib/tracks.ts";

const track = (id, title, channelTitle = "Alan Walker - Topic") =>
  normalizeTrack({
    id,
    title,
    channelTitle,
    duration: 180,
  });

test("normalizes channel and ecosystem fields and provides official thumbnail fallbacks", () => {
  const faded = track("faded000001", "Faded (Official Audio)");

  assert.equal(faded.channelTitle, "Alan Walker - Topic");
  assert.equal(faded.ecosystemQuery, "Alan Walker - Topic songs");
  assert.equal(
    getThumbnailFallbacks(faded)[0],
    "https://i.ytimg.com/vi/faded000001/maxresdefault.jpg",
  );
  assert.equal(getThumbnailFallbacks(faded).at(-1), "https://i.ytimg.com/vi/faded000001/default.jpg");
});

test("filters the active song, title duplicates, played ids, and duplicate candidate ids", () => {
  const faded = track("faded000001", "Faded - Alan Walker");
  const queue = buildEcosystemQueue(
    faded,
    [
      faded,
      track("duplicate0001", "Faded (Official Video)"),
      track("played000001", "Alone"),
      track("alone000001", "Alone"),
      track("spectre00001", "The Spectre"),
    ],
    ["played000001"],
  );

  assert.deepEqual(queue.map(({ id }) => id), ["alone000001", "spectre00001"]);
});

test("ranks matching artist tracks and tracks active songs in played history", () => {
  const faded = track("faded000001", "Faded");
  const queue = new EcosystemQueueManager();
  queue.setSeed(faded);
  queue.addCandidates([
    track("random000001", "Unrelated Song", "Other Artist"),
    track("alan0000001", "The Spectre"),
    track("alan0000002", "Alan Walker reaction to Faded", "Reaction Channel"),
  ]);
  queue.markPlaying(faded);

  const state = queue.getSnapshot();
  assert.equal(state.activeId, faded.id);
  assert.ok(state.playedHistory.includes(faded.id));
  assert.deepEqual(
    state.upNextQueue.map(({ id }) => id),
    ["alan0000001", "random000001", "alan0000002"],
  );
  assert.equal(queue.peekNext()?.id, "alan0000001");
});

test("queue refill appends unique eligible songs and clear removes the seed", () => {
  const faded = track("faded000001", "Faded");
  const alone = track("alone000001", "Alone");
  const queue = new EcosystemQueueManager();
  queue.setSeed(faded);
  queue.addCandidates([alone]);
  queue.markPlaying(faded);
  queue.addCandidates([alone, track("spectre00001", "The Spectre")]);

  assert.deepEqual(
    queue.getSnapshot().upNextQueue.map(({ id }) => id),
    ["alone000001", "spectre00001"],
  );
  queue.clear();
  assert.equal(queue.getSnapshot().seed, null);
  assert.equal(queue.getSnapshot().upNextQueue.length, 0);
});

test("manually enqueues tracks without duplicates or the active track", () => {
  const faded = track("faded000001", "Faded");
  const alone = track("alone000001", "Alone");
  const queue = new EcosystemQueueManager();
  queue.setSeed(faded);
  queue.markPlaying(faded);

  assert.equal(queue.enqueue(alone), true);
  assert.equal(queue.enqueue(alone), false);
  assert.equal(queue.enqueue(faded), false);
  assert.deepEqual(
    queue.getSnapshot().upNextQueue.map(({ id }) => id),
    ["alone000001"],
  );
  assert.equal(queue.peekNext()?.id, "alone000001");
});
