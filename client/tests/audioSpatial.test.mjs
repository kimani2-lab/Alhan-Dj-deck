import assert from "node:assert/strict";
import test from "node:test";
import { createHallImpulseResponse } from "../src/lib/audio/Deck.ts";
import { EightDMusicEngine } from "../src/lib/audio/EightDMusicEngine.ts";
import { detectBpm, orbitSpeedForBpm } from "../src/lib/audio/bpm.ts";

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
  disconnect() {
    this.connections = [];
  }
}

class FakeAudioContext {
  currentTime = 0;
  sampleRate = 8_000;

  createGain() {
    return Object.assign(new FakeNode(), { gain: new FakeParam() });
  }

  createAnalyser() {
    return Object.assign(new FakeNode(), {
      fftSize: 0,
      smoothingTimeConstant: 0,
    });
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
    return Object.assign(new FakeNode(), { buffer: null });
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
