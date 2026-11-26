import {
  LargeHall8DEngine,
  type HallSize,
} from "./LargeHall8DEngine.ts";
import {
  createBassEnhancement,
  type BassEnhancement,
} from "./bassEnhancement.ts";
import { detectBpm, orbitSpeedForBpm } from "./bpm.ts";
import { fetchAudioBuffer } from "./loadAudioBuffer.ts";

export type EightDMusicSnapshot = {
  title: string;
  trackId: string | null;
  channelTitle: string | null;
  thumbnail: string | null;
  duration: number;
  position: number;
  isPlaying: boolean;
  volume: number;
  bpm: number;
  bassBoost: boolean;
  trebleMuted: boolean;
  spatial: {
    enabled: boolean;
    beatSynced: boolean;
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
  private readonly trebleFilter: BiquadFilterNode;
  private readonly bassFilter: BiquadFilterNode;
  private readonly compressor: DynamicsCompressorNode;
  private readonly spatialEngine: LargeHall8DEngine;
  private readonly bassEnhancement: BassEnhancement;
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
  private trebleMuted = false;
  private volume = 0.82;
  private bpm = 120;
  private spatialEnabled = true;
  private spatialSpeed = 0.12;
  private spatialDepth = 0.75;
  private spatialBeatSync = true;
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
    this.trebleFilter = context.createBiquadFilter();
    this.trebleFilter.type = "highshelf";
    this.trebleFilter.frequency.value = 4_000;
    this.trebleFilter.gain.value = 0;
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
    this.spatialEngine.setEnabled(this.spatialEnabled);
    this.bassEnhancement = createBassEnhancement(
      context,
      this.bassFilter,
      this.spatialEngine.input,
    );

    this.sourceOutput.connect(this.trebleFilter);
    this.trebleFilter.connect(this.compressor);
    this.compressor.connect(this.bassFilter);
    this.bassFilter.connect(this.spatialEngine.input);
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
    const buffer = await fetchAudioBuffer(this.context, url);
    this.pause();
    this.buffer = buffer;
    this.bpm = detectBpm(buffer);
    this.spatialBeatSync = true;
    this.spatialSpeed = orbitSpeedForBpm(this.bpm);
    this.spatialEngine.setOrbitSpeed(this.spatialSpeed);
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
    this.spatialEngine.setEnabled(enabled);
  }

  setSpatialSpeed(value: number): void {
    this.spatialBeatSync = false;
    this.spatialSpeed = Math.min(1, Math.max(0.04, value));
    this.spatialEngine.setOrbitSpeed(this.spatialSpeed);
  }

  setSpatialSpeedManual(value: number): void {
    this.setSpatialSpeed(value);
  }

  setBpm(bpm: number): void {
    if (!Number.isFinite(bpm) || bpm <= 0) return;
    this.bpm = Math.min(200, Math.max(60, bpm));
    if (this.spatialBeatSync) {
      this.spatialSpeed = orbitSpeedForBpm(this.bpm);
      this.spatialEngine.setOrbitSpeed(this.spatialSpeed);
    }
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
    const now = this.context.currentTime;
    this.bassFilter.gain.setTargetAtTime(enabled ? 10 : 0, now, 0.02);
    this.bassEnhancement.subGain.gain.setTargetAtTime(
      enabled ? 1.4 : 0,
      now,
      0.05,
    );
    this.bassEnhancement.harmonicGain.gain.setTargetAtTime(
      enabled ? 0.65 : 0,
      now,
      0.05,
    );
  }

  setTrebleMuted(muted: boolean): void {
    this.trebleMuted = muted;
    this.trebleFilter.gain.setTargetAtTime(
      muted ? -24 : 0,
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
    this.phase = this.spatialEngine.phase;
    this.pan = this.spatialEnabled
      ? Math.sin(this.phase) * this.spatialDepth
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
      bpm: this.bpm,
      bassBoost: this.bassBoost,
      trebleMuted: this.trebleMuted,
      spatial: {
        enabled: this.spatialEnabled,
        beatSynced: this.spatialBeatSync,
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
    this.trebleFilter.disconnect();
    this.bassFilter.disconnect();
    this.bassEnhancement.dispose();
    this.compressor.disconnect();
    this.spatialEngine.dispose();
    this.analyser.disconnect();
  }
}
