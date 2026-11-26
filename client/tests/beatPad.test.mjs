import assert from "node:assert/strict";
import test from "node:test";
import { Deck } from "../src/lib/audio/Deck.ts";
import {
  BeatPadEngine,
  BEAT_PAD_SOUNDS,
} from "../src/lib/audio/BeatPadEngine.ts";

class FakeParam {
  value = 0;
  setTargetAtTime(value) {
    this.value = value;
  }
  setValueAtTime(value) {
    this.value = value;
  }
}

class FakeNode {
  connections = [];
  connect(node) {
    this.connections.push(node);
  }
  disconnect() {
    this.connections = [];
  }
}

class FakeAudioContext {
  sampleRate = 8_000;
  currentTime = 1;
  sources = [];
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      getChannelData: (channel) => data[channel],
    };
  }
  createGain() {
    return Object.assign(new FakeNode(), { gain: new FakeParam() });
  }
  createBufferSource() {
    const source = Object.assign(new FakeNode(), {
      buffer: null,
      onended: null,
      startTime: null,
      stopped: false,
      start(time) {
        this.startTime = time;
      },
      stop() {
        this.stopped = true;
      },
    });
    this.sources.push(source);
    return source;
  }
}

test("synthesizes every one-shot and allows overlapping pad triggers", () => {
  const context = new FakeAudioContext();
  const padEngine = new BeatPadEngine(context, new FakeNode());

  for (const sound of BEAT_PAD_SOUNDS) {
    padEngine.trigger(sound);
  }
  padEngine.trigger("kick", 0.4);
  padEngine.trigger("kick", 1);

  assert.equal(context.sources.length, BEAT_PAD_SOUNDS.length + 2);
  for (const source of context.sources) {
    const samples = source.buffer.getChannelData(0);
    assert.ok(samples.length > 0);
    assert.ok(Math.max(...samples.slice(0, 1000).map(Math.abs)) > 0);
    assert.equal(source.startTime, context.currentTime);
  }

  padEngine.dispose();
  assert.ok(context.sources.every((source) => source.stopped));
});

test("routes pad output through the selected deck FX chain when enabled", () => {
  const context = new FakeAudioContext();
  const padEngine = new BeatPadEngine(context, new FakeNode());
  const deckInput = new FakeNode();

  padEngine.setVolume(0.47);
  padEngine.setFxDestination(deckInput);
  assert.equal(padEngine.getVolume(), 0.47);
  assert.equal(padEngine.directGain.gain.value, 0);
  assert.equal(padEngine.fxSendGain.gain.value, 0.85);
  assert.deepEqual(padEngine.fxSendGain.connections, [deckInput]);

  padEngine.setFxDestination(null);
  assert.equal(padEngine.directGain.gain.value, 1);
  assert.equal(padEngine.fxSendGain.gain.value, 0);
  padEngine.dispose();
});

test("sets beat loops on the nearest beat and clamps them to track duration", () => {
  const deck = Object.create(Deck.prototype);
  Object.assign(deck, {
    buffer: { duration: 10 },
    bpm: 120,
    playing: false,
    positionAtStart: 3.34,
    loopStart: null,
    loopEnd: null,
    loopEnabled: false,
    source: null,
  });

  assert.equal(deck.setBeatLoop(2), true);
  assert.equal(deck.loopStart, 3);
  assert.equal(deck.loopEnd, 4);
  assert.equal(deck.loopEnabled, true);

  deck.positionAtStart = 9.9;
  assert.equal(deck.setBeatLoop(1), true);
  assert.equal(deck.loopStart, 9.5);
  assert.equal(deck.loopEnd, 10);

  deck.positionAtStart = 10;
  assert.equal(deck.setBeatLoop(1), false);
});

test("supports setting and triggering all eight hot cue slots", () => {
  const deck = Object.create(Deck.prototype);
  Object.assign(deck, {
    buffer: { duration: 12 },
    playing: false,
    positionAtStart: 7.25,
    hotCues: Array(8).fill(null),
    source: null,
  });

  deck.setHotCue(7);
  assert.equal(deck.hotCues[7], 7.25);
  deck.positionAtStart = 2;
  deck.triggerHotCue(7);
  assert.equal(deck.positionAtStart, 7.25);
});

test("resets all eight hot cue slots when loading a new deck track", async () => {
  const deck = Object.create(Deck.prototype);
  Object.assign(deck, {
    pause() {},
    hotCues: Array(4).fill(null),
    bpmTracker: { reset() {} },
  });

  await deck.load({ duration: 12 }, "New track");
  assert.equal(deck.hotCues.length, 8);
});
