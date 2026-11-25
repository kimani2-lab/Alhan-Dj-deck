import assert from "node:assert/strict";
import test from "node:test";
import { createHallImpulseResponse } from "../src/lib/audio/Deck.ts";

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
