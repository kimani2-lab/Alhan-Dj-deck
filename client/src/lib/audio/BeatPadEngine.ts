export const BEAT_PAD_SOUNDS = [
  "kick",
  "snare",
  "clap",
  "closedHat",
  "openHat",
  "rim",
  "riser",
  "sub",
] as const;

export type BeatPadSound = (typeof BEAT_PAD_SOUNDS)[number];

export const BEAT_PAD_LABELS: Record<BeatPadSound, string> = {
  kick: "KICK",
  snare: "SNARE",
  clap: "CLAP",
  closedHat: "CLOSED HAT",
  openHat: "OPEN HAT",
  rim: "RIM / PERC",
  riser: "RISER HIT",
  sub: "SUB HIT",
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function makeNoise(seed: number) {
  let state = seed | 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x80000000 - 1;
  };
}

function createSynthBuffer(
  context: BaseAudioContext,
  duration: number,
  render: (time: number, index: number, random: () => number) => number,
  seed: number,
): AudioBuffer {
  const buffer = context.createBuffer(
    1,
    Math.ceil(duration * context.sampleRate),
    context.sampleRate,
  );
  const samples = buffer.getChannelData(0);
  const random = makeNoise(seed);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = render(index / context.sampleRate, index, random);
  }
  return buffer;
}

function createPadBuffers(context: BaseAudioContext): Record<BeatPadSound, AudioBuffer> {
  const sampleRate = context.sampleRate;
  let kickPhase = 0;
  let subPhase = 0;
  let rimPhase = 0;
  let snareNoise = 0;
  let hatNoise = 0;
  let openHatNoise = 0;

  return {
    kick: createSynthBuffer(
      context,
      0.24,
      (time, _index, random) => {
        const frequency = 43 + 125 * Math.exp(-time * 26);
        kickPhase += (2 * Math.PI * frequency) / sampleRate;
        const body = Math.sin(kickPhase) * Math.exp(-time * 15);
        const click = random() * Math.exp(-time * 180) * 0.17;
        return (body + click) * 0.92;
      },
      13,
    ),
    snare: createSynthBuffer(
      context,
      0.25,
      (time, _index, random) => {
        const noise = random();
        const highPass = noise - snareNoise;
        snareNoise = noise;
        const tone = Math.sin(2 * Math.PI * 185 * time) * Math.exp(-time * 25);
        return (highPass * Math.exp(-time * 23) * 0.72 + tone * 0.22) * 0.78;
      },
      29,
    ),
    clap: createSynthBuffer(
      context,
      0.28,
      (time, _index, random) => {
        const bursts = [0, 0.012, 0.027, 0.045].reduce((level, onset) => {
          const age = time - onset;
          return age >= 0 ? level + Math.exp(-age * 58) : level;
        }, 0);
        return random() * bursts * Math.exp(-time * 13) * 0.34;
      },
      47,
    ),
    closedHat: createSynthBuffer(
      context,
      0.075,
      (time, _index, random) => {
        const noise = random();
        const highPass = noise - hatNoise;
        hatNoise = noise;
        return highPass * Math.exp(-time * 92) * 0.42;
      },
      71,
    ),
    openHat: createSynthBuffer(
      context,
      0.42,
      (time, _index, random) => {
        const noise = random();
        const highPass = noise - openHatNoise;
        openHatNoise = noise;
        return highPass * Math.exp(-time * 11) * 0.28;
      },
      89,
    ),
    rim: createSynthBuffer(
      context,
      0.14,
      (time) => {
        rimPhase += (2 * Math.PI * (1_180 - time * 1_600)) / sampleRate;
        return Math.sin(rimPhase) * Math.exp(-time * 39) * 0.55;
      },
      101,
    ),
    riser: createSynthBuffer(
      context,
      0.76,
      (time, _index, random) => {
        const noise = random();
        const progress = Math.min(1, time / 0.58);
        const rise = noise * progress * progress * 0.24;
        const impactTime = Math.max(0, time - 0.58);
        const impact =
          Math.sin(2 * Math.PI * 72 * impactTime) *
            Math.exp(-impactTime * 18) *
            0.7 +
          noise * Math.exp(-impactTime * 34) * 0.22;
        return time < 0.58 ? rise : impact;
      },
      137,
    ),
    sub: createSynthBuffer(
      context,
      0.48,
      (time) => {
        const frequency = 48 + 18 * Math.exp(-time * 12);
        subPhase += (2 * Math.PI * frequency) / sampleRate;
        return Math.sin(subPhase) * Math.exp(-time * 8) * 0.68;
      },
      163,
    ),
  };
}

export class BeatPadEngine {
  private readonly context: BaseAudioContext;
  private readonly buffers: Record<BeatPadSound, AudioBuffer>;
  private readonly padGain: GainNode;
  private readonly directGain: GainNode;
  private readonly fxSendGain: GainNode;
  private readonly voices = new Map<AudioBufferSourceNode, GainNode>();
  private volume = 0.82;
  private fxDestination: AudioNode | null = null;

  constructor(context: BaseAudioContext, masterPadBus: AudioNode) {
    this.context = context;
    this.buffers = createPadBuffers(context);
    this.padGain = context.createGain();
    this.padGain.gain.value = this.volume;
    this.directGain = context.createGain();
    this.directGain.gain.value = 1;
    this.fxSendGain = context.createGain();
    this.fxSendGain.gain.value = 0;
    this.padGain.connect(this.directGain);
    this.directGain.connect(masterPadBus);
    this.padGain.connect(this.fxSendGain);
  }

  getVolume(): number {
    return this.volume;
  }

  setVolume(value: number): void {
    this.volume = clamp(value, 0, 1);
    this.padGain.gain.setTargetAtTime(
      this.volume,
      this.context.currentTime,
      0.015,
    );
  }

  setFxDestination(destination: AudioNode | null): void {
    if (this.fxDestination === destination) return;
    this.fxSendGain.disconnect();
    this.fxDestination = destination;
    if (destination) {
      this.fxSendGain.connect(destination);
    }
    const now = this.context.currentTime;
    this.directGain.gain.setTargetAtTime(destination ? 0 : 1, now, 0.02);
    this.fxSendGain.gain.setTargetAtTime(destination ? 0.85 : 0, now, 0.02);
  }

  trigger(sound: BeatPadSound, velocity = 0.85): void {
    const buffer = this.buffers[sound];
    if (!buffer) throw new Error(`Unknown beat pad sound: ${sound}`);

    const source = this.context.createBufferSource();
    const voiceGain = this.context.createGain();
    const now = this.context.currentTime;
    source.buffer = buffer;
    voiceGain.gain.setValueAtTime(clamp(velocity, 0, 1), now);
    source.connect(voiceGain);
    voiceGain.connect(this.padGain);
    source.onended = () => {
      this.voices.delete(source);
      source.disconnect();
      voiceGain.disconnect();
    };
    this.voices.set(source, voiceGain);
    source.start(now);
  }

  dispose(): void {
    for (const [source, voiceGain] of this.voices) {
      source.onended = null;
      source.stop();
      source.disconnect();
      voiceGain.disconnect();
    }
    this.voices.clear();
    this.fxSendGain.disconnect();
    this.directGain.disconnect();
    this.padGain.disconnect();
    this.fxDestination = null;
  }
}
