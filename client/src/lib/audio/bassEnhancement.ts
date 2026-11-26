export function createSaturationCurve(drive = 4): Float32Array<ArrayBuffer> {
  const samples = 1024;
  const curve = new Float32Array(samples);
  const normalizer = Math.tanh(drive) || 1;
  for (let index = 0; index < samples; index += 1) {
    const x = (index * 2) / (samples - 1) - 1;
    curve[index] = Math.tanh(x * drive) / normalizer;
  }
  return curve;
}

export type BassEnhancement = {
  subGain: GainNode;
  harmonicGain: GainNode;
  dispose: () => void;
};

export function createBassEnhancement(
  context: AudioContext,
  input: AudioNode,
  output: AudioNode,
): BassEnhancement {
  const subFilter = context.createBiquadFilter();
  subFilter.type = "lowpass";
  subFilter.frequency.value = 80;
  subFilter.Q.value = 0.9;

  const subGain = context.createGain();
  subGain.gain.value = 0;

  const shaper =
    typeof context.createWaveShaper === "function"
      ? context.createWaveShaper()
      : null;
  if (shaper) {
    shaper.curve = createSaturationCurve(4);
    shaper.oversample = "2x";
  }

  const harmonicGain = context.createGain();
  harmonicGain.gain.value = 0;

  input.connect(subFilter);
  subFilter.connect(subGain);
  if (shaper) {
    subGain.connect(shaper);
    shaper.connect(harmonicGain);
  } else {
    subGain.connect(harmonicGain);
  }
  harmonicGain.connect(output);

  return {
    subGain,
    harmonicGain,
    dispose: () => {
      input.disconnect(subFilter);
      subFilter.disconnect();
      subGain.disconnect();
      shaper?.disconnect();
      harmonicGain.disconnect();
    },
  };
}
