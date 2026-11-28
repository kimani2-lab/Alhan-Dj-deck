export type HallSize = "club" | "hall" | "arena";

export type HallPreset = {
  label: string;
  shortLabel: string;
  decay: number;
  earlyGain: number;
  wetGain: number;
};

export const HALL_SIZE_ORDER: HallSize[] = ["club", "hall", "arena"];

export const HALL_SIZE_PRESETS: Record<HallSize, HallPreset> = {
  club: {
    label: "Small Club",
    shortLabel: "CLUB",
    decay: 1.15,
    earlyGain: 0.14,
    wetGain: 0.12,
  },
  hall: {
    label: "Large Concert Hall",
    shortLabel: "HALL",
    decay: 2.5,
    earlyGain: 0.2,
    wetGain: 0.22,
  },
  arena: {
    label: "Massive Arena",
    shortLabel: "ARENA",
    decay: 3.8,
    earlyGain: 0.26,
    wetGain: 0.3,
  },
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function createHallImpulseResponse(
  context: BaseAudioContext,
  duration = 3.8,
  decayTime = 2.5,
): AudioBuffer {
  const sampleRate = context.sampleRate;
  const length = Math.ceil(sampleRate * duration);
  const impulse = context.createBuffer(2, length, sampleRate);
  const reflections = [
    [0.031, 0.52],
    [0.057, 0.39],
    [0.094, 0.31],
    [0.147, 0.22],
    [0.213, 0.15],
    [0.287, 0.1],
  ] as const;

  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const samples = impulse.getChannelData(channel);
    let seed = 0x6d2b79f5 ^ (channel * 0x9e3779b9);
    let filteredNoise = 0;
    for (let index = 0; index < length; index += 1) {
      const time = index / sampleRate;
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const noise = (seed >>> 0) / 0x80000000 - 1;
      const damping = 0.12 + 0.7 * Math.exp(-time / 1.4);
      filteredNoise += damping * (noise - filteredNoise);
      const decay = Math.pow(10, (-3 * time) / decayTime);
      samples[index] = filteredNoise * decay * 0.18;
    }

    for (const [reflectionIndex, [delay, gain]] of reflections.entries()) {
      const channelOffset = channel === 0 ? 0 : 0.006 + reflectionIndex * 0.0015;
      const index = Math.round((delay + channelOffset) * sampleRate);
      if (index < length) samples[index] += gain * (channel === 0 ? 1 : 0.88);
    }

    const fadeStart = Math.floor(length * 0.96);
    for (let index = fadeStart; index < length; index += 1) {
      samples[index] *= (length - index) / (length - fadeStart);
    }
  }

  return impulse;
}

export class LargeHall8DEngine {
  readonly input: GainNode;
  readonly output: GainNode;

  private readonly context: AudioContext;
  private readonly mixBus: GainNode;
  private readonly safetyLimiter: DynamicsCompressorNode;
  private readonly subsonicFilter: BiquadFilterNode;
  private readonly bypassGain: GainNode;
  private readonly subFilter: BiquadFilterNode;
  private readonly subGain: GainNode;
  private readonly orbitFilter: BiquadFilterNode;
  private readonly orbitToneLow: BiquadFilterNode;
  private readonly orbitTonePresence: BiquadFilterNode;
  private readonly orbitToneAir: BiquadFilterNode;
  private readonly panner: PannerNode;
  private readonly orbitStereoPanner: StereoPannerNode;
  private readonly orbitPanDepth: GainNode;
  private readonly orbitDryGain: GainNode;
  private readonly preDelay: DelayNode;
  private readonly earlyLeft: DelayNode;
  private readonly earlyRight: DelayNode;
  private readonly earlyLeftPan: StereoPannerNode;
  private readonly earlyRightPan: StereoPannerNode;
  private readonly earlyGain: GainNode;
  private readonly convolver: ConvolverNode;
  private readonly hallHighpass: BiquadFilterNode;
  private readonly hallLowpass: BiquadFilterNode;
  private readonly wetGain: GainNode;
  private readonly lfoX: OscillatorNode;
  private readonly lfoZ: OscillatorNode;
  private readonly lfoXDepth: GainNode;
  private readonly lfoZDepth: GainNode;
  private impulseResponseAvailable = false;
  private enabled = false;
  private width = 0.75;
  private speed = 0.12;
  private room = 0.75;
  private hallSize: HallSize = "hall";
  private lfoPhase = 0;
  private phaseUpdatedAt: number;

  constructor(context: AudioContext) {
    this.context = context;
    this.phaseUpdatedAt = context.currentTime;
    this.input = context.createGain();
    this.output = context.createGain();
    this.mixBus = context.createGain();
    this.safetyLimiter = context.createDynamicsCompressor();
    this.safetyLimiter.threshold.value = -6;
    this.safetyLimiter.knee.value = 10;
    this.safetyLimiter.ratio.value = 2;
    this.safetyLimiter.attack.value = 0.006;
    this.safetyLimiter.release.value = 0.2;

    this.subsonicFilter = context.createBiquadFilter();
    this.subsonicFilter.type = "highpass";
    this.subsonicFilter.frequency.value = 30;
    this.subsonicFilter.Q.value = 0.7;

    this.bypassGain = context.createGain();
    this.bypassGain.gain.value = 1;

    this.subFilter = context.createBiquadFilter();
    this.subFilter.type = "lowpass";
    this.subFilter.frequency.value = 120;
    this.subFilter.Q.value = 0.6;
    this.subGain = context.createGain();
    this.subGain.gain.value = 0;

    this.orbitFilter = context.createBiquadFilter();
    this.orbitFilter.type = "highpass";
    this.orbitFilter.frequency.value = 120;
    this.orbitFilter.Q.value = 0.7;
    this.orbitToneLow = context.createBiquadFilter();
    this.orbitToneLow.type = "lowshelf";
    this.orbitToneLow.frequency.value = 220;
    this.orbitToneLow.gain.value = -1.8;
    this.orbitTonePresence = context.createBiquadFilter();
    this.orbitTonePresence.type = "peaking";
    this.orbitTonePresence.frequency.value = 2800;
    this.orbitTonePresence.Q.value = 0.85;
    this.orbitTonePresence.gain.value = 1.3;
    this.orbitToneAir = context.createBiquadFilter();
    this.orbitToneAir.type = "highshelf";
    this.orbitToneAir.frequency.value = 9500;
    this.orbitToneAir.gain.value = 1;

    this.panner = context.createPanner();
    this.panner.panningModel = "HRTF";
    this.panner.distanceModel = "linear";
    this.panner.refDistance = 1;
    this.panner.maxDistance = 30;
    this.panner.rolloffFactor = 0;
    this.panner.positionX.value = 0;
    this.panner.positionY.value = 0;
    this.panner.positionZ.value = -0.95;

    this.orbitStereoPanner = context.createStereoPanner();
    this.orbitPanDepth = context.createGain();
    this.orbitPanDepth.gain.value = 0;
    this.orbitDryGain = context.createGain();
    this.orbitDryGain.gain.value = 0;

    this.preDelay = context.createDelay(0.25);
    this.preDelay.delayTime.value = 0.045;

    this.earlyLeft = context.createDelay(0.25);
    this.earlyLeft.delayTime.value = 0.023;
    this.earlyRight = context.createDelay(0.25);
    this.earlyRight.delayTime.value = 0.037;
    this.earlyLeftPan = context.createStereoPanner();
    this.earlyLeftPan.pan.value = -0.85;
    this.earlyRightPan = context.createStereoPanner();
    this.earlyRightPan.pan.value = 0.85;
    this.earlyGain = context.createGain();
    this.earlyGain.gain.value = 0;

    this.convolver = context.createConvolver();
    this.hallHighpass = context.createBiquadFilter();
    this.hallHighpass.type = "highpass";
    this.hallHighpass.frequency.value = 180;
    this.hallHighpass.Q.value = 0.7;
    this.hallLowpass = context.createBiquadFilter();
    this.hallLowpass.type = "lowpass";
    this.hallLowpass.frequency.value = 5400;
    this.hallLowpass.Q.value = 0.7;
    this.wetGain = context.createGain();
    this.wetGain.gain.value = 0;

    this.lfoX = context.createOscillator();
    this.lfoX.type = "sine";
    this.lfoZ = context.createOscillator();
    this.lfoZ.setPeriodicWave(
      context.createPeriodicWave(
        new Float32Array([0, 1]),
        new Float32Array([0, 0]),
        { disableNormalization: true },
      ),
    );
    this.lfoX.frequency.value = this.speed;
    this.lfoZ.frequency.value = this.speed;
    this.lfoXDepth = context.createGain();
    this.lfoXDepth.gain.value = 0;
    this.lfoZDepth = context.createGain();
    this.lfoZDepth.gain.value = 0;

    this.input.connect(this.subsonicFilter);

    this.subsonicFilter.connect(this.bypassGain);
    this.bypassGain.connect(this.output);

    this.subsonicFilter.connect(this.subFilter);
    this.subFilter.connect(this.subGain);
    this.subGain.connect(this.mixBus);

    this.subsonicFilter.connect(this.orbitFilter);
    this.orbitFilter.connect(this.orbitToneLow);
    this.orbitToneLow.connect(this.orbitTonePresence);
    this.orbitTonePresence.connect(this.orbitToneAir);
    this.orbitToneAir.connect(this.panner);
    this.panner.connect(this.orbitStereoPanner);
    this.orbitStereoPanner.connect(this.orbitDryGain);
    this.orbitDryGain.connect(this.mixBus);
    this.panner.connect(this.preDelay);

    this.preDelay.connect(this.earlyLeft);
    this.earlyLeft.connect(this.earlyLeftPan);
    this.earlyLeftPan.connect(this.earlyGain);
    this.earlyGain.connect(this.mixBus);

    this.preDelay.connect(this.earlyRight);
    this.earlyRight.connect(this.earlyRightPan);
    this.earlyRightPan.connect(this.earlyGain);

    this.preDelay.connect(this.convolver);
    this.convolver.connect(this.hallHighpass);
    this.hallHighpass.connect(this.hallLowpass);
    this.hallLowpass.connect(this.wetGain);
    this.wetGain.connect(this.mixBus);

    this.mixBus.connect(this.safetyLimiter);
    this.safetyLimiter.connect(this.output);

    this.lfoX.connect(this.lfoXDepth);
    this.lfoXDepth.connect(this.panner.positionX);
    this.lfoX.connect(this.orbitPanDepth);
    this.orbitPanDepth.connect(this.orbitStereoPanner.pan);
    this.lfoZ.connect(this.lfoZDepth);
    this.lfoZDepth.connect(this.panner.positionZ);
    this.lfoX.start();
    this.lfoZ.start();

    try {
      this.convolver.buffer = createHallImpulseResponse(
        context,
        3.8,
        HALL_SIZE_PRESETS[this.hallSize].decay,
      );
      this.impulseResponseAvailable = true;
    } catch (error) {
      console.error(
        "[audio] Could not create the hall impulse response; enabling direct-output fallback.",
        error,
      );
    }
    this.updateOrbit(this.context.currentTime);
    this.updateMix(this.context.currentTime);
  }

  get hasImpulseResponse(): boolean {
    return this.impulseResponseAvailable;
  }

  get phase(): number {
    return this.readLfoPhase();
  }

  get currentHallSize(): HallSize {
    return this.hallSize;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    const now = this.context.currentTime;
    this.bypassGain.gain.setTargetAtTime(enabled ? 0 : 1, now, 0.12);
    this.subGain.gain.setTargetAtTime(enabled ? 0.8 : 0, now, 0.12);
    this.orbitDryGain.gain.setTargetAtTime(enabled ? 1 : 0, now, 0.12);
    this.updateOrbit(now);
    this.updateMix(now);
  }

  setWidth(width: number): void {
    this.width = clamp(width, 0, 1);
    this.updateOrbit(this.context.currentTime);
  }

  setOrbitSpeed(hertz: number): void {
    const now = this.context.currentTime;
    this.lfoPhase = this.readLfoPhase(now);
    this.phaseUpdatedAt = now;
    this.speed = clamp(hertz, 0.04, 1);
    this.lfoX.frequency.setTargetAtTime(this.speed, now, 0.03);
    this.lfoZ.frequency.setTargetAtTime(this.speed, now, 0.03);
  }

  setHallSize(size: HallSize): void {
    if (!HALL_SIZE_PRESETS[size] || size === this.hallSize) return;
    this.hallSize = size;
    try {
      this.convolver.buffer = createHallImpulseResponse(
        this.context,
        3.8,
        HALL_SIZE_PRESETS[size].decay,
      );
      this.impulseResponseAvailable = true;
    } catch (error) {
      this.impulseResponseAvailable = false;
      console.error(
        "[audio] Could not update the hall impulse response; enabling direct-output fallback.",
        error,
      );
    }
    this.updateMix(this.context.currentTime);
  }

  setRoom(value: number): void {
    this.room = clamp(value, 0, 1);
    this.updateMix(this.context.currentTime);
  }

  private intensity(): number {
    return 0.5 + this.room * 0.9;
  }

  private updateMix(now: number): void {
    const preset = HALL_SIZE_PRESETS[this.hallSize];
    const intensity = this.intensity();
    this.earlyGain.gain.setTargetAtTime(
      this.enabled ? preset.earlyGain * intensity : 0,
      now,
      0.08,
    );
    this.wetGain.gain.setTargetAtTime(
      this.enabled ? preset.wetGain * intensity : 0,
      now,
      0.08,
    );
  }

  private updateOrbit(now: number): void {
    const radius = this.enabled ? this.width * 2.2 : 0;
    const depth = this.enabled ? this.width * 0.16 : 0;
    this.lfoXDepth.gain.setTargetAtTime(radius, now, 0.12);
    this.orbitPanDepth.gain.setTargetAtTime(
      this.enabled ? this.width : 0,
      now,
      0.12,
    );
    this.lfoZDepth.gain.setTargetAtTime(-depth, now, 0.12);
  }

  private readLfoPhase(now = this.context.currentTime): number {
    const elapsed = Math.max(0, now - this.phaseUpdatedAt);
    return (
      (this.lfoPhase + elapsed * 2 * Math.PI * this.speed) % (2 * Math.PI)
    );
  }

  dispose(): void {
    this.lfoX.stop();
    this.lfoX.disconnect();
    this.lfoZ.stop();
    this.lfoZ.disconnect();
    this.lfoXDepth.disconnect();
    this.lfoZDepth.disconnect();
    this.input.disconnect();
    this.subsonicFilter.disconnect();
    this.bypassGain.disconnect();
    this.subFilter.disconnect();
    this.subGain.disconnect();
    this.orbitFilter.disconnect();
    this.orbitToneLow.disconnect();
    this.orbitTonePresence.disconnect();
    this.orbitToneAir.disconnect();
    this.panner.disconnect();
    this.orbitStereoPanner.disconnect();
    this.orbitPanDepth.disconnect();
    this.orbitDryGain.disconnect();
    this.preDelay.disconnect();
    this.earlyLeft.disconnect();
    this.earlyRight.disconnect();
    this.earlyLeftPan.disconnect();
    this.earlyRightPan.disconnect();
    this.earlyGain.disconnect();
    this.convolver.disconnect();
    this.hallHighpass.disconnect();
    this.hallLowpass.disconnect();
    this.wetGain.disconnect();
    this.mixBus.disconnect();
    this.safetyLimiter.disconnect();
    this.output.disconnect();
  }
}
