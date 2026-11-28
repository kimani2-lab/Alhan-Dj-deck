import {
  LargeHall8DEngine,
  type HallSize,
} from "./LargeHall8DEngine.ts";
import {
  createBassEnhancement,
  type BassEnhancement,
} from "./bassEnhancement.ts";
import { getMediaElementSource } from "./mediaElementSource.ts";
import { LiveBpmTracker, orbitSpeedForBpm } from "./bpm.ts";

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
  private readonly bpmTracker = new LiveBpmTracker();
  private mediaElement: HTMLAudioElement | null = null;
  private mediaElementSource: MediaElementAudioSourceNode | null = null;
  private directOutputFallback = false;
  private durationHint = 0;
  private title = "No track loaded";
  private trackId: string | null = null;
  private channelTitle: string | null = null;
  private thumbnail: string | null = null;
  private playing = false;
  private bassBoost = false;
  private trebleMuted = false;
  private volume = 1;
  private bpm = 120;
  private bpmManual = false;
  private spatialEnabled = true;
  private streaming = false;
  private spatialSpeed = 0.12;
  private spatialDepth = 0.75;
  private spatialBeatSync = true;
  private room = 0.44;
  private hallSize: HallSize = "hall";
  private phase = 0;
  private pan = 0;
  private onEnded: (() => void) | null = null;
  private onPlaybackError: ((error: Error) => void) | null = null;

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

  private createMediaElement(): HTMLAudioElement {
    if (this.mediaElement) return this.mediaElement;
    const element = new Audio();
    element.crossOrigin = "anonymous";
    element.preload = "auto";
    element.addEventListener("ended", () => {
      if (!this.streaming) return;
      this.playing = false;
      this.onEnded?.();
    });
    element.addEventListener("error", () => {
      if (!this.streaming || !element.error) return;
      this.playing = false;
      this.onPlaybackError?.(
        new Error(
          element.error.message ||
            `Audio streaming failed (media error ${element.error.code}).`,
        ),
      );
    });
    this.mediaElement = element;
    this.mediaElementSource = getMediaElementSource(this.context, element);
    this.mediaElementSource.connect(this.sourceOutput);
    this.ensureOutputRoute();
    return element;
  }

  private ensureOutputRoute(): void {
    if (
      this.spatialEngine.hasImpulseResponse ||
      this.directOutputFallback ||
      !this.mediaElementSource
    ) {
      return;
    }

    this.mediaElementSource.disconnect();
    this.mediaElementSource.connect(this.context.destination);
    this.directOutputFallback = true;
    if (this.mediaElement) this.mediaElement.volume = this.volume;
    console.warn(
      "[audio] Hall impulse response unavailable; routing audio directly to the output.",
    );
  }

  private clearMediaElement(): void {
    if (!this.mediaElement) return;
    this.mediaElement.pause();
    this.mediaElement.removeAttribute("src");
    this.mediaElement.load();
  }

  async loadUrl(
    url: string,
    title: string,
    metadata: {
      id: string;
      channelTitle: string;
      thumbnail: string;
      duration?: number;
    },
  ): Promise<void> {
    await this.resume();
    this.pause();
    this.streaming = false;
    this.clearMediaElement();
    const element = this.createMediaElement();
    element.src = url;
    element.load();
    this.streaming = true;
    this.durationHint =
      typeof metadata.duration === "number" && metadata.duration > 0
        ? metadata.duration
        : 0;
    this.bpm = 120;
    this.bpmManual = false;
    this.bpmTracker.reset();
    this.spatialBeatSync = true;
    this.spatialSpeed = orbitSpeedForBpm(this.bpm);
    this.spatialEngine.setOrbitSpeed(this.spatialSpeed);
    this.title = title;
    this.trackId = metadata.id;
    this.channelTitle = metadata.channelTitle;
    this.thumbnail = metadata.thumbnail;
  }

  play(): void {
    if (!this.streaming || !this.mediaElement || this.playing) return;
    this.ensureOutputRoute();
    if (this.duration > 0 && this.mediaElement.currentTime >= this.duration) {
      this.mediaElement.currentTime = 0;
    }
    this.playing = true;
    void this.mediaElement.play().catch((reason: unknown) => {
      this.playing = false;
      this.onPlaybackError?.(
        reason instanceof Error ? reason : new Error("Audio playback could not start."),
      );
    });
  }

  pause(): void {
    if (!this.mediaElement) return;
    this.mediaElement.pause();
    this.playing = false;
  }

  togglePlayback(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(position: number): void {
    if (!this.streaming || !this.mediaElement) return;
    const duration = this.duration;
    this.mediaElement.currentTime = Math.max(
      0,
      duration > 0 ? Math.min(position, duration) : position,
    );
  }

  setVolume(value: number): void {
    this.volume = Math.min(1, Math.max(0, value));
    if (this.directOutputFallback && this.mediaElement) {
      this.mediaElement.volume = this.volume;
      return;
    }
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
    this.bpmManual = true;
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

  setOnEnded(handler: (() => void) | null): void {
    this.onEnded = handler;
  }

  setOnPlaybackError(handler: ((error: Error) => void) | null): void {
    this.onPlaybackError = handler;
  }

  get position(): number {
    return this.streaming ? this.mediaElement?.currentTime ?? 0 : 0;
  }

  get duration(): number {
    if (!this.streaming) return 0;
    return Number.isFinite(this.mediaElement?.duration)
      ? this.mediaElement!.duration
      : this.durationHint;
  }

  getSnapshot(): EightDMusicSnapshot {
    if (
      this.streaming &&
      this.playing &&
      this.spatialBeatSync &&
      !this.bpmManual
    ) {
      const detectedBpm = this.bpmTracker.update(
        this.analyser,
        this.context.currentTime,
      );
      if (detectedBpm !== null && detectedBpm !== this.bpm) {
        this.bpm = detectedBpm;
        this.spatialSpeed = orbitSpeedForBpm(this.bpm);
        this.spatialEngine.setOrbitSpeed(this.spatialSpeed);
      }
    }
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
    this.streaming = false;
    this.clearMediaElement();
    this.mediaElementSource?.disconnect();
    this.mediaElementSource = null;
    this.mediaElement = null;
    this.sourceOutput.disconnect();
    this.trebleFilter.disconnect();
    this.bassEnhancement.dispose();
    this.bassFilter.disconnect();
    this.compressor.disconnect();
    this.spatialEngine.dispose();
    this.analyser.disconnect();
  }
}
