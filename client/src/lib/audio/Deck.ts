export type DeckId = "A" | "B";

export type DeckSnapshot = {
  id: DeckId;
  title: string;
  trackId: string | null;
  channelTitle: string | null;
  thumbnail: string | null;
  duration: number;
  position: number;
  isPlaying: boolean;
  tempo: number;
  bpm: number;
  volume: number;
  eq: { low: number; mid: number; high: number };
  filter: number;
  bassBoost: boolean;
  spatial: {
    enabled: boolean;
    speed: number;
    depth: number;
    room: number;
    phase: number;
    pan: number;
  };
  loop: { enabled: boolean; start: number | null; end: number | null };
  hotCues: Array<number | null>;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export class Deck {
  readonly id: DeckId;
  readonly output: GainNode;
  readonly analyser: AnalyserNode;

  private readonly context: AudioContext;
  private readonly low: BiquadFilterNode;
  private readonly mid: BiquadFilterNode;
  private readonly high: BiquadFilterNode;
  private readonly bassBoostFilter: BiquadFilterNode;
  private readonly filterNode: BiquadFilterNode;
  private readonly panner: StereoPannerNode;
  private readonly delay: DelayNode;
  private readonly feedback: GainNode;
  private readonly wet: GainNode;
  private readonly dry: GainNode;
  private readonly lfo: OscillatorNode;
  private readonly lfoDepth: GainNode;
  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;
  private title = "No track loaded";
  private trackId: string | null = null;
  private channelTitle: string | null = null;
  private thumbnail: string | null = null;
  private onEnded: (() => void) | null = null;
  private positionAtStart = 0;
  private startedAt = 0;
  private cuePosition = 0;
  private playing = false;
  private tempo = 0;
  private bpm = 120;
  private volume = 0.82;
  private filter = 0;
  private bassBoost = false;
  private eq = { low: 0, mid: 0, high: 0 };
  private spatialEnabled = false;
  private spatialSpeed = 0.15;
  private spatialDepth = 0.65;
  private room = 0.44;
  private lfoPhase = 0;
  private phaseUpdatedAt = 0;
  private loopEnabled = false;
  private loopStart: number | null = null;
  private loopEnd: number | null = null;
  private hotCues: Array<number | null> = [null, null, null, null];

  constructor(context: AudioContext, id: DeckId) {
    this.context = context;
    this.phaseUpdatedAt = context.currentTime;
    this.id = id;
    this.output = context.createGain();
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.82;

    this.low = context.createBiquadFilter();
    this.low.type = "lowshelf";
    this.low.frequency.value = 250;
    this.mid = context.createBiquadFilter();
    this.mid.type = "peaking";
    this.mid.frequency.value = 1000;
    this.mid.Q.value = 0.8;
    this.high = context.createBiquadFilter();
    this.high.type = "highshelf";
    this.high.frequency.value = 4000;
    this.bassBoostFilter = context.createBiquadFilter();
    this.bassBoostFilter.type = "lowshelf";
    this.bassBoostFilter.frequency.value = 120;
    this.bassBoostFilter.Q.value = 0.75;
    this.bassBoostFilter.gain.value = 0;
    this.filterNode = context.createBiquadFilter();
    this.filterNode.type = "lowpass";
    this.filterNode.frequency.value = 22000;
    this.filterNode.Q.value = 0.7;
    this.panner = context.createStereoPanner();
    this.delay = context.createDelay(0.5);
    this.delay.delayTime.value = 0.12;
    this.feedback = context.createGain();
    this.feedback.gain.value = 0.18;
    this.wet = context.createGain();
    this.wet.gain.value = 0;
    this.dry = context.createGain();
    this.dry.gain.value = 1;
    this.lfo = context.createOscillator();
    this.lfo.type = "sine";
    this.lfo.frequency.value = this.spatialSpeed;
    this.lfoDepth = context.createGain();
    this.lfoDepth.gain.value = 0;

    this.low.connect(this.mid);
    this.mid.connect(this.high);
    this.high.connect(this.bassBoostFilter);
    this.bassBoostFilter.connect(this.filterNode);
    this.filterNode.connect(this.panner);
    this.panner.connect(this.dry);
    this.dry.connect(this.output);
    this.panner.connect(this.delay);
    this.delay.connect(this.wet);
    this.wet.connect(this.output);
    this.delay.connect(this.feedback);
    this.feedback.connect(this.delay);
    this.output.connect(this.analyser);
    this.lfo.connect(this.lfoDepth);
    this.lfoDepth.connect(this.panner.pan);
    this.lfo.start();
    this.setVolume(this.volume);
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  get position(): number {
    if (!this.playing || !this.buffer) return this.positionAtStart;
    const elapsedPosition =
      this.positionAtStart +
      (this.context.currentTime - this.startedAt) * this.playbackRate;
    if (
      this.loopEnabled &&
      this.loopStart !== null &&
      this.loopEnd !== null &&
      elapsedPosition >= this.loopEnd
    ) {
      return (
        this.loopStart +
        ((elapsedPosition - this.loopStart) % (this.loopEnd - this.loopStart))
      );
    }
    return Math.min(this.buffer.duration, elapsedPosition);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get playbackRate(): number {
    return 1 + this.tempo / 100;
  }

  private readLfoPhase(now = this.context.currentTime): number {
    const elapsed = Math.max(0, now - this.phaseUpdatedAt);
    return (
      (this.lfoPhase + elapsed * 2 * Math.PI * this.spatialSpeed) %
      (2 * Math.PI)
    );
  }

  get audioBuffer(): AudioBuffer | null {
    return this.buffer;
  }

  async load(
    buffer: AudioBuffer,
    title: string,
    metadata?: { id: string; channelTitle: string; thumbnail: string },
  ): Promise<void> {
    this.pause();
    this.buffer = buffer;
    this.title = title;
    this.trackId = metadata?.id ?? null;
    this.channelTitle = metadata?.channelTitle ?? null;
    this.thumbnail = metadata?.thumbnail ?? null;
    this.positionAtStart = 0;
    this.cuePosition = 0;
    this.loopEnabled = false;
    this.loopStart = null;
    this.loopEnd = null;
    this.hotCues = [null, null, null, null];
  }

  play(): void {
    if (!this.buffer || this.playing) return;
    if (this.positionAtStart >= this.buffer.duration) this.positionAtStart = 0;

    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = this.playbackRate;
    if (
      this.loopStart !== null &&
      this.loopEnd !== null &&
      this.loopStart < this.loopEnd
    ) {
      source.loop = this.loopEnabled;
      source.loopStart = this.loopStart;
      source.loopEnd = this.loopEnd;
    }
    source.connect(this.low);
    source.onended = () => {
      if (this.source !== source) return;
      this.source = null;
      this.playing = false;
      this.positionAtStart = 0;
      source.disconnect();
      this.onEnded?.();
    };
    this.source = source;
    this.startedAt = this.context.currentTime;
    this.playing = true;
    source.start(0, this.positionAtStart);
  }

  pause(): void {
    if (!this.playing || !this.source) return;
    this.positionAtStart = this.position;
    const source = this.source;
    this.source = null;
    this.playing = false;
    source.onended = null;
    source.stop();
    source.disconnect();
  }

  togglePlayback(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(seconds: number): void {
    if (!this.buffer) return;
    const wasPlaying = this.playing;
    this.pause();
    this.positionAtStart = clamp(seconds, 0, this.buffer.duration);
    if (wasPlaying) this.play();
  }

  setCue(): void {
    this.cuePosition = this.position;
  }

  returnToCue(): void {
    this.seek(this.cuePosition);
  }

  setHotCue(index: number): void {
    if (index < 0 || index >= this.hotCues.length || !this.buffer) return;
    this.hotCues[index] = this.position;
  }

  triggerHotCue(index: number): void {
    const cue = this.hotCues[index];
    if (cue !== null && cue !== undefined) this.seek(cue);
  }

  setTempo(percent: number): void {
    if (this.playing) {
      this.positionAtStart = this.position;
      this.startedAt = this.context.currentTime;
    }
    this.tempo = clamp(percent, -16, 16);
    if (this.source) {
      this.source.playbackRate.setTargetAtTime(
        this.playbackRate,
        this.context.currentTime,
        0.015,
      );
    }
  }

  setBpm(bpm: number): void {
    if (Number.isFinite(bpm) && bpm > 0) this.bpm = clamp(bpm, 40, 240);
  }

  getBpm(): number {
    return this.bpm;
  }

  setLoopIn(): void {
    if (!this.buffer) return;
    this.loopStart = this.position;
    if (this.source) this.source.loopStart = this.loopStart;
    if (this.loopEnd !== null && this.loopEnd <= this.loopStart) {
      this.loopEnd = null;
      this.setLoopEnabled(false);
    }
  }

  setLoopOut(): void {
    if (
      !this.buffer ||
      this.loopStart === null ||
      this.position <= this.loopStart
    ) {
      return;
    }
    this.loopEnd = this.position;
    if (this.source) this.source.loopEnd = this.loopEnd;
  }

  setLoopEnabled(enabled: boolean): void {
    if (
      enabled &&
      (this.loopStart === null ||
        this.loopEnd === null ||
        this.loopStart >= this.loopEnd)
    ) {
      return;
    }
    this.loopEnabled = enabled;
    if (this.source) this.source.loop = enabled;
  }

  getTempo(): number {
    return this.tempo;
  }

  setOnEnded(handler: (() => void) | null): void {
    this.onEnded = handler;
  }

  setVolume(value: number): void {
    this.volume = clamp(value, 0, 1);
    this.output.gain.setTargetAtTime(
      this.volume,
      this.context.currentTime,
      0.02,
    );
  }

  setEq(band: keyof DeckSnapshot["eq"], value: number): void {
    const node = { low: this.low, mid: this.mid, high: this.high }[band];
    this.eq[band] = clamp(value, -24, 12);
    node.gain.setTargetAtTime(this.eq[band], this.context.currentTime, 0.025);
  }

  setFilter(value: number): void {
    this.filter = clamp(value, -1, 1);
    const frequency =
      this.filter < 0
        ? 22000 * Math.pow(180 / 22000, -this.filter)
        : 180 * Math.pow(22000 / 180, this.filter);
    this.filterNode.type = this.filter <= 0 ? "lowpass" : "highpass";
    this.filterNode.frequency.setTargetAtTime(
      this.filter === 0 ? 22000 : frequency,
      this.context.currentTime,
      0.035,
    );
  }

  setBassBoost(enabled: boolean): void {
    this.bassBoost = enabled;
    this.bassBoostFilter.gain.setTargetAtTime(
      enabled ? 6 : 0,
      this.context.currentTime,
      0.08,
    );
  }

  setSpatialEnabled(enabled: boolean): void {
    this.spatialEnabled = enabled;
    this.lfoDepth.gain.setTargetAtTime(
      enabled ? this.spatialDepth : 0,
      this.context.currentTime,
      0.08,
    );
    this.wet.gain.setTargetAtTime(
      enabled ? this.room * 0.5 : 0,
      this.context.currentTime,
      0.08,
    );
  }

  setSpatialSpeed(hertz: number): void {
    const now = this.context.currentTime;
    this.lfoPhase = this.readLfoPhase(now);
    this.phaseUpdatedAt = now;
    this.spatialSpeed = clamp(hertz, 0.05, 0.5);
    this.lfo.frequency.setTargetAtTime(
      this.spatialSpeed,
      now,
      0.03,
    );
  }

  setSpatialDepth(depth: number): void {
    this.spatialDepth = clamp(depth, 0, 1);
    if (this.spatialEnabled) {
      this.lfoDepth.gain.setTargetAtTime(
        this.spatialDepth,
        this.context.currentTime,
        0.03,
      );
    }
  }

  setRoom(value: number): void {
    this.room = clamp(value, 0, 1);
    if (this.spatialEnabled) {
      this.wet.gain.setTargetAtTime(
        this.room * 0.5,
        this.context.currentTime,
        0.04,
      );
    }
  }

  getSnapshot(): DeckSnapshot {
    return {
      id: this.id,
      title: this.title,
      trackId: this.trackId,
      channelTitle: this.channelTitle,
      thumbnail: this.thumbnail,
      duration: this.duration,
      position: this.position,
      isPlaying: this.playing,
      tempo: this.tempo,
      bpm: this.bpm,
      volume: this.volume,
      eq: { ...this.eq },
      filter: this.filter,
      bassBoost: this.bassBoost,
      spatial: {
        enabled: this.spatialEnabled,
        speed: this.spatialSpeed,
        depth: this.spatialDepth,
        room: this.room,
        phase: this.readLfoPhase(),
        pan: this.spatialEnabled
          ? Math.sin(this.readLfoPhase()) * this.spatialDepth
          : 0,
      },
      loop: {
        enabled: this.loopEnabled,
        start: this.loopStart,
        end: this.loopEnd,
      },
      hotCues: [...this.hotCues],
    };
  }

  dispose(): void {
    this.pause();
    this.lfo.stop();
    this.lfo.disconnect();
    this.lfoDepth.disconnect();
    this.low.disconnect();
    this.mid.disconnect();
    this.high.disconnect();
    this.bassBoostFilter.disconnect();
    this.filterNode.disconnect();
    this.panner.disconnect();
    this.delay.disconnect();
    this.feedback.disconnect();
    this.wet.disconnect();
    this.dry.disconnect();
    this.output.disconnect();
    this.analyser.disconnect();
  }
}
