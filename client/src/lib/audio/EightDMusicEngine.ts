import {
  LargeHall8DEngine,
  type HallSize,
} from "./LargeHall8DEngine";

export type EightDMusicSnapshot = {
  title: string;
  trackId: string | null;
  channelTitle: string | null;
  thumbnail: string | null;
  duration: number;
  position: number;
  isPlaying: boolean;
  volume: number;
  bassBoost: boolean;
  spatial: {
    enabled: boolean;
    speed: number;
    depth: number;
    room: number;
    hallSize: HallSize;
    phase: number;
    pan: number;
  };
};

export class EightDMusicEngine {
  readonly analyser: AnalyserNode;
  private readonly context: AudioContext;
  private readonly sourceOutput: GainNode;
  private readonly bassFilter: BiquadFilterNode;
  private readonly compressor: DynamicsCompressorNode;
  private readonly spatialEngine: LargeHall8DEngine;
  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;
  private title = "No track loaded";
  private trackId: string | null = null;
  private channelTitle: string | null = null;
  private thumbnail: string | null = null;
  private positionAtStart = 0;
  private startedAt = 0;
  private playing = false;
  private bassBoost = false;
  private volume = 0.82;
  private spatialEnabled = true;
  private spatialSpeed = 0.12;
  private spatialDepth = 0.75;
  private room = 0.44;
  private hallSize: HallSize = "hall";
  private phase = 0;
  private pan = 0;
  private onEnded: (() => void) | null = null;

  constructor(context: AudioContext, masterInput: AudioNode) {
    this.context = context;
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.82;
    this.sourceOutput = context.createGain();
    this.sourceOutput.gain.value = this.volume;
    this.bassFilter = context.createBiquadFilter();
    this.bassFilter.type = "lowshelf";
    this.bassFilter.frequency.value = 120;
    this.bassFilter.gain.value = 0;
    this.compressor = context.createDynamicsCompressor();
    this.compressor.threshold.value = -18;
    this.compressor.knee.value = 12;
    this.compressor.ratio.value = 3;
    this.compressor.attack.value = 0.01;
    this.compressor.release.value = 0.25;
    this.spatialEngine = new LargeHall8DEngine(context);
    this.spatialEngine.setWidth(this.spatialDepth);
    this.spatialEngine.setOrbitSpeed(this.spatialSpeed);
    this.spatialEngine.setRoom(this.room);
    this.spatialEngine.setHallSize(this.hallSize);

    this.sourceOutput.connect(this.bassFilter);
    this.bassFilter.connect(this.compressor);
    this.compressor.connect(this.spatialEngine.input);
    this.spatialEngine.output.connect(this.analyser);
    this.analyser.connect(masterInput);
  }

  async resume(): Promise<void> {
    if (this.context.state === "suspended") await this.context.resume();
  }

  async loadUrl(
    url: string,
    title: string,
    metadata: { id: string; channelTitle: string; thumbnail: string },
  ): Promise<void> {
    await this.resume();
    const response = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!response.ok) throw new Error(`Audio request failed (${response.status}).`);
    const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
    this.pause();
    this.buffer = buffer;
    this.title = title;
    this.trackId = metadata.id;
    this.channelTitle = metadata.channelTitle;
    this.thumbnail = metadata.thumbnail;
    this.positionAtStart = 0;
  }

  play(): void {
    if (!this.buffer || this.playing) return;
    if (this.positionAtStart >= this.buffer.duration) this.positionAtStart = 0;
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.sourceOutput);
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

  seek(position: number): void {
    if (!this.buffer) return;
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.positionAtStart = Math.min(
      Math.max(position, 0),
      this.buffer.duration,
    );
    if (wasPlaying) this.play();
  }

  setVolume(value: number): void {
    this.volume = Math.min(1, Math.max(0, value));
    this.sourceOutput.gain.setTargetAtTime(
      this.volume,
      this.context.currentTime,
      0.02,
    );
  }

  setSpatialEnabled(enabled: boolean): void {
    this.spatialEnabled = enabled;
  }

  setSpatialSpeed(value: number): void {
    this.spatialSpeed = Math.min(0.3, Math.max(0.04, value));
    this.spatialEngine.setOrbitSpeed(this.spatialSpeed);
  }

  setSpatialDepth(value: number): void {
    this.spatialDepth = Math.min(1, Math.max(0, value));
    this.spatialEngine.setWidth(this.spatialDepth);
  }

  setRoom(value: number): void {
    this.room = Math.min(1, Math.max(0, value));
    this.spatialEngine.setRoom(this.room);
  }

  setHallSize(size: HallSize): void {
    this.hallSize = size;
    this.spatialEngine.setHallSize(size);
  }

  setBassBoost(enabled: boolean): void {
    this.bassBoost = enabled;
    this.bassFilter.gain.setTargetAtTime(
      enabled ? 7 : 0,
      this.context.currentTime,
      0.02,
    );
  }

  setOnEnded(handler: () => void): void {
    this.onEnded = handler;
  }

  get position(): number {
    if (!this.buffer) return 0;
    if (!this.playing) return this.positionAtStart;
    return Math.min(
      this.buffer.duration,
      this.positionAtStart + (this.context.currentTime - this.startedAt),
    );
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  getSnapshot(): EightDMusicSnapshot {
    const elapsed = this.position;
    if (this.spatialEnabled) {
      this.phase += Math.min(0.02, (this.context.currentTime - this.startedAt) * 0.02);
    }
    this.pan = this.spatialEnabled
      ? Math.sin(this.phase * Math.PI * 2 * this.spatialSpeed) * this.spatialDepth
      : 0;
    return {
      title: this.title,
      trackId: this.trackId,
      channelTitle: this.channelTitle,
      thumbnail: this.thumbnail,
      duration: this.duration,
      position: elapsed,
      isPlaying: this.playing,
      volume: this.volume,
      bassBoost: this.bassBoost,
      spatial: {
        enabled: this.spatialEnabled,
        speed: this.spatialSpeed,
        depth: this.spatialDepth,
        room: this.room,
        hallSize: this.hallSize,
        phase: this.phase,
        pan: this.pan,
      },
    };
  }

  dispose(): void {
    this.pause();
    this.sourceOutput.disconnect();
    this.bassFilter.disconnect();
    this.compressor.disconnect();
    this.spatialEngine.dispose();
    this.analyser.disconnect();
  }
}
