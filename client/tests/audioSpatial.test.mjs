import assert from "node:assert/strict";
import test from "node:test";
import { createHallImpulseResponse } from "../src/lib/audio/Deck.ts";
import { EightDMusicEngine } from "../src/lib/audio/EightDMusicEngine.ts";
import {
  detectBpm,
  LiveBpmTracker,
  orbitSpeedForBpm,
} from "../src/lib/audio/bpm.ts";
import { getMediaElementSource } from "../src/lib/audio/mediaElementSource.ts";

class FakeParam {
  value = 0;
  connections = [];
  setTargetAtTime(value) {
    this.value = value;
  }
}

class FakeNode {
  connections = [];
  connect(node) {
    this.connections.push(node);
  }
  disconnect(node) {
    if (node) {
      const connection = this.connections.indexOf(node);
      if (connection < 0) throw new Error("Audio node is not connected.");
      this.connections.splice(connection, 1);
      return;
    }
    this.connections = [];
  }
}

class FakeAudioContext {
  state = "suspended";
  currentTime = 0;
  sampleRate = 8_000;
  destination = new FakeNode();
  mediaElementSources = [];
  failConvolverBuffer = false;
  resumeCalls = 0;

  resume() {
    this.resumeCalls += 1;
    this.state = "running";
    return Promise.resolve();
  }

  close() {
    return Promise.resolve();
  }

  createGain() {
    return Object.assign(new FakeNode(), { gain: new FakeParam() });
  }

  createAnalyser() {
    return Object.assign(new FakeNode(), {
      fftSize: 0,
      smoothingTimeConstant: 0,
    });
  }

  createMediaElementSource(element) {
    const source = Object.assign(new FakeNode(), {
      context: this,
      mediaElement: element,
    });
    this.mediaElementSources.push(source);
    return source;
  }

  createBiquadFilter() {
    return Object.assign(new FakeNode(), {
      type: "",
      frequency: new FakeParam(),
      gain: new FakeParam(),
      Q: new FakeParam(),
    });
  }

  createDynamicsCompressor() {
    return Object.assign(new FakeNode(), {
      threshold: new FakeParam(),
      knee: new FakeParam(),
      ratio: new FakeParam(),
      attack: new FakeParam(),
      release: new FakeParam(),
    });
  }

  createPanner() {
    return Object.assign(new FakeNode(), {
      positionX: new FakeParam(),
      positionY: new FakeParam(),
      positionZ: new FakeParam(),
    });
  }

  createDelay() {
    return Object.assign(new FakeNode(), { delayTime: new FakeParam() });
  }

  createStereoPanner() {
    return Object.assign(new FakeNode(), { pan: new FakeParam() });
  }

  createWaveShaper() {
    return Object.assign(new FakeNode(), {
      curve: null,
      oversample: "none",
    });
  }

  createConvolver() {
    const shouldFail = () => this.failConvolverBuffer;
    let buffer = null;
    const convolver = new FakeNode();
    Object.defineProperty(convolver, "buffer", {
      get: () => buffer,
      set(value) {
        if (shouldFail()) {
          throw new Error("Convolver buffer assignment failed.");
        }
        buffer = value;
      },
    });
    return convolver;
  }

  createOscillator() {
    return Object.assign(new FakeNode(), {
      frequency: new FakeParam(),
      start() {},
      stop() {},
      setPeriodicWave() {},
    });
  }

  createPeriodicWave() {
    return {};
  }

  createBuffer(numberOfChannels, length, sampleRate) {
    const channels = Array.from(
      { length: numberOfChannels },
      () => new Float32Array(length),
    );
    return {
      numberOfChannels,
      length,
      sampleRate,
      getChannelData: (channel) => channels[channel],
    };
  }
}

class FakeAudioElement {
  crossOrigin = null;
  preload = "";
  src = "";
  currentTime = 0;
  duration = Number.NaN;
  playbackRate = 1;
  paused = true;
  error = null;
  listeners = new Map();
  volume = 1;

  addEventListener(name, callback) {
    const callbacks = this.listeners.get(name) ?? [];
    callbacks.push(callback);
    this.listeners.set(name, callbacks);
  }

  removeAttribute(name) {
    if (name === "src") this.src = "";
  }

  load() {}

  play() {
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }

  emit(name) {
    for (const callback of this.listeners.get(name) ?? []) callback();
  }
}

test("reuses each media element source within its AudioContext", () => {
  const context = new FakeAudioContext();
  const element = {};
  const first = getMediaElementSource(context, element);
  const second = getMediaElementSource(context, element);

  assert.equal(first, second);
  assert.equal(context.mediaElementSources.length, 1);
  assert.throws(
    () => getMediaElementSource(new FakeAudioContext(), element),
    /more than one AudioContext/,
  );
});

test("generates a stereo hall impulse with early reflections and a decaying tail", () => {
  const sampleRate = 8_000;
  const context = {
    sampleRate,
    createBuffer(numberOfChannels, length, rate) {
      const channels = Array.from(
        { length: numberOfChannels },
        () => new Float32Array(length),
      );
      return {
        numberOfChannels,
        length,
        sampleRate: rate,
        getChannelData: (channel) => channels[channel],
      };
    },
  };

  const impulse = createHallImpulseResponse(context);
  const left = impulse.getChannelData(0);
  const right = impulse.getChannelData(1);
  const firstReflection = Math.round(0.031 * sampleRate);
  const tailStart = Math.round(3.2 * sampleRate);
  const tailEnd = Math.round(3.6 * sampleRate);
  const tailPeak = Math.max(...left.slice(tailStart, tailEnd).map(Math.abs));

  assert.equal(impulse.numberOfChannels, 2);
  assert.equal(impulse.length, Math.ceil(sampleRate * 3.8));
  assert.ok(left[firstReflection] > 0.3);
  assert.notDeepEqual(left, right);
  assert.ok(tailPeak < left[firstReflection]);
});

test("keeps 8D, bass boost, and tweeter cut independently switchable", () => {
  const context = new FakeAudioContext();
  const engine = new EightDMusicEngine(context, new FakeNode());

  assert.equal(engine.getSnapshot().spatial.enabled, true);
  assert.equal(engine.spatialEngine.bypassGain.gain.value, 0);

  context.currentTime = 2.0833;
  assert.ok(engine.getSnapshot().spatial.pan > 0.7);
  context.currentTime = 6.25;
  assert.ok(engine.getSnapshot().spatial.pan < -0.7);
  context.currentTime = 8.3333;
  assert.ok(Math.abs(engine.getSnapshot().spatial.pan) < 0.02);
  assert.ok(
    engine.spatialEngine.lfoX.connections.includes(
      engine.spatialEngine.orbitPanDepth,
    ),
  );
  assert.ok(
    engine.spatialEngine.orbitPanDepth.connections.includes(
      engine.spatialEngine.orbitStereoPanner.pan,
    ),
  );
  assert.ok(engine.compressor.connections.includes(engine.bassFilter));
  assert.ok(engine.bassFilter.connections.includes(engine.spatialEngine.input));

  engine.setBpm(90);
  assert.equal(engine.getSnapshot().spatial.speed, orbitSpeedForBpm(90));
  engine.setBpm(160);
  assert.equal(engine.getSnapshot().spatial.speed, orbitSpeedForBpm(160));
  assert.equal(engine.getSnapshot().spatial.beatSynced, true);
  engine.setSpatialSpeed(0.44);
  assert.equal(engine.getSnapshot().spatial.speed, 0.44);
  assert.equal(engine.getSnapshot().spatial.beatSynced, false);
  engine.setBpm(90);
  assert.equal(engine.getSnapshot().spatial.speed, 0.44);

  engine.setSpatialEnabled(false);
  engine.setBassBoost(true);
  engine.setTrebleMuted(true);

  let snapshot = engine.getSnapshot();
  assert.equal(snapshot.spatial.enabled, false);
  assert.equal(snapshot.bassBoost, true);
  assert.equal(snapshot.trebleMuted, true);
  assert.equal(engine.spatialEngine.bypassGain.gain.value, 1);
  assert.equal(engine.bassFilter.gain.value, 10);
  assert.equal(engine.trebleFilter.gain.value, -24);
  assert.equal(engine.bassEnhancement.subGain.gain.value, 1.4);
  assert.equal(engine.bassEnhancement.harmonicGain.gain.value, 0.65);

  engine.setSpatialEnabled(true);
  snapshot = engine.getSnapshot();
  assert.equal(snapshot.spatial.enabled, true);
  assert.equal(snapshot.bassBoost, true);
  assert.equal(snapshot.trebleMuted, true);

  engine.setBassBoost(false);
  engine.setTrebleMuted(false);
  snapshot = engine.getSnapshot();
  assert.equal(snapshot.spatial.enabled, true);
  assert.equal(snapshot.bassBoost, false);
  assert.equal(snapshot.trebleMuted, false);
  assert.equal(engine.bassFilter.gain.value, 0);
  assert.equal(engine.bassEnhancement.subGain.gain.value, 0);
  assert.equal(engine.bassEnhancement.harmonicGain.gain.value, 0);

  engine.dispose();
});

test("detects tempo and maps faster beats to faster full orbits", () => {
  const sampleRate = 8_000;
  const duration = 20;
  const samples = new Float32Array(sampleRate * duration);
  for (let beat = 0; beat < duration; beat += 0.5) {
    const start = Math.round(beat * sampleRate);
    for (
      let index = 0;
      index < sampleRate * 0.12 && start + index < samples.length;
      index += 1
    ) {
      samples[start + index] +=
        0.8 *
        Math.sin((2 * Math.PI * 55 * index) / sampleRate) *
        Math.exp(-index / (sampleRate * 0.025));
    }
  }

  const buffer = {
    sampleRate,
    duration,
    numberOfChannels: 1,
    getChannelData: () => samples,
  };
  const bpm = detectBpm(buffer);

  assert.ok(Math.abs(bpm - 120) <= 8);
  assert.ok(orbitSpeedForBpm(160) > orbitSpeedForBpm(90));
});

test("tracks streamed beat onsets without decoding the full audio", () => {
  const tracker = new LiveBpmTracker();
  const spectrum = new Uint8Array(64);
  const analyser = {
    frequencyBinCount: spectrum.length,
    fftSize: 256,
    context: { sampleRate: 8_000 },
    getByteFrequencyData(target) {
      target.set(spectrum);
    },
  };
  let detectedBpm = null;

  for (let frame = 0; frame <= 100; frame += 1) {
    spectrum.fill(0);
    if (frame % 5 === 0) {
      for (let bin = 1; bin <= 6; bin += 1) spectrum[bin] = 120;
    }
    detectedBpm =
      tracker.update(analyser, frame / 10) ?? detectedBpm;
  }

  assert.equal(detectedBpm, 120);
});

test("loads a remote deck track through a progressive media element", async () => {
  const originalAudio = globalThis.Audio;
  globalThis.Audio = FakeAudioElement;
  try {
    const context = new FakeAudioContext();
    const { Deck } = await import("../src/lib/audio/Deck.ts");
    const deck = new Deck(context, "A");
    await deck.loadStream("/api/stream/abcdefghijk", "Streaming track", {
      id: "abcdefghijk",
      channelTitle: "Artist",
      thumbnail: "",
      duration: 210,
    });

    deck.play();
    await Promise.resolve();
    const element = context.mediaElementSources[0]?.mediaElement;
    assert.ok(element);
    assert.equal(element.crossOrigin, "anonymous");
    assert.equal(element.preload, "auto");
    assert.equal(element.src, "/api/stream/abcdefghijk");
    assert.equal(deck.audioBuffer, null);
    assert.equal(deck.getSnapshot().duration, 210);
    assert.equal(deck.getSnapshot().isPlaying, true);
    assert.ok(context.mediaElementSources[0].connections.includes(deck.low));

    element.duration = 180;
    assert.equal(deck.getSnapshot().duration, 180);
    element.currentTime = 12;
    deck.seek(42);
    deck.setTempo(5);
    assert.equal(element.currentTime, 42);
    assert.equal(element.playbackRate, 1.05);

    deck.seek(10);
    deck.setLoopIn();
    deck.seek(20);
    deck.setLoopOut();
    deck.setLoopEnabled(true);
    element.currentTime = 20;
    element.emit("timeupdate");
    assert.equal(element.currentTime, 10);

    await deck.loadStream("/api/stream/lmnopqrstuv", "Next track", {
      id: "lmnopqrstuv",
      channelTitle: "Artist",
      thumbnail: "",
      duration: 150,
    });
    assert.equal(context.mediaElementSources.length, 1);
    assert.equal(element.src, "/api/stream/lmnopqrstuv");
    const localBuffer = context.createBuffer(1, 8_000, 8_000);
    await deck.load(localBuffer, "Local file");
    assert.equal(deck.audioBuffer, localBuffer);
    assert.equal(element.src, "");

    deck.dispose();
  } finally {
    if (originalAudio === undefined) delete globalThis.Audio;
    else globalThis.Audio = originalAudio;
  }
});

test("routes 8D streaming through its existing effects graph", async () => {
  const originalAudio = globalThis.Audio;
  globalThis.Audio = FakeAudioElement;
  try {
    const context = new FakeAudioContext();
    const engine = new EightDMusicEngine(context, new FakeNode());
    assert.equal(engine.sourceOutput.gain.value, 1);
    await engine.loadUrl("/api/stream/abcdefghijk", "Streaming 8D track", {
      id: "abcdefghijk",
      channelTitle: "Artist",
      thumbnail: "",
      duration: 210,
    });
    engine.play();
    await Promise.resolve();

    const element = context.mediaElementSources[0]?.mediaElement;
    assert.ok(element);
    assert.equal(element.crossOrigin, "anonymous");
    assert.equal(element.preload, "auto");
    assert.equal(element.src, "/api/stream/abcdefghijk");
    assert.equal(engine.getSnapshot().duration, 210);
    assert.equal(context.resumeCalls, 1);
    element.duration = 180;
    assert.equal(engine.getSnapshot().duration, 180);
    assert.equal(engine.getSnapshot().isPlaying, true);
    assert.ok(context.mediaElementSources[0].connections.includes(engine.sourceOutput));
    assert.equal(engine.spatialEngine.orbitDryGain.gain.value, 1);
    assert.ok(engine.analyser.connections.length > 0);

    engine.dispose();
  } finally {
    if (originalAudio === undefined) delete globalThis.Audio;
    else globalThis.Audio = originalAudio;
  }
});

test("routes audio directly to the destination if the hall impulse fails", async () => {
  const originalAudio = globalThis.Audio;
  const originalConsoleError = console.error;
  globalThis.Audio = FakeAudioElement;
  console.error = () => {};
  try {
    const context = new FakeAudioContext();
    context.failConvolverBuffer = true;
    const engine = new EightDMusicEngine(context, new FakeNode());
    await engine.loadUrl("/api/stream/abcdefghijk", "Streaming 8D track", {
      id: "abcdefghijk",
      channelTitle: "Artist",
      thumbnail: "",
      duration: 210,
    });
    engine.setVolume(0.5);

    const element = context.mediaElementSources[0].mediaElement;
    assert.ok(
      context.mediaElementSources[0].connections.includes(context.destination),
    );
    assert.equal(element.volume, 0.5);
    assert.equal(engine.spatialEngine.hasImpulseResponse, false);

    engine.dispose();
  } finally {
    console.error = originalConsoleError;
    if (originalAudio === undefined) delete globalThis.Audio;
    else globalThis.Audio = originalAudio;
  }
});
