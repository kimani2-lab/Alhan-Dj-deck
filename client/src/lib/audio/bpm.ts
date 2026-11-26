const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const BEATS_PER_ORBIT = 4;

export function orbitSpeedForBpm(
  bpm: number,
  beatsPerOrbit = BEATS_PER_ORBIT,
): number {
  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const safeBeats =
    Number.isFinite(beatsPerOrbit) && beatsPerOrbit > 0 ? beatsPerOrbit : 4;
  return clamp(safeBpm / (60 * safeBeats), 0.08, 0.9);
}

export function detectBpm(buffer: AudioBuffer): number {
  const sampleRate = buffer.sampleRate;
  const duration = buffer.duration;
  const channels = Math.min(buffer.numberOfChannels || 1, 2);
  if (
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    return 120;
  }

  const analyzeSeconds = Math.min(duration, 45);
  const start =
    duration > 20 ? Math.min(duration * 0.08, 8) : 0;
  const startSample = Math.floor(start * sampleRate);
  const endSample = Math.floor(
    Math.min(duration, start + analyzeSeconds) * sampleRate,
  );
  const frameSize = 1024;
  const hopSize = 512;
  const frameCount = Math.floor(
    (endSample - startSample - frameSize) / hopSize,
  );
  if (frameCount < 24) return 120;

  const channelData: Float32Array[] = [];
  for (let channel = 0; channel < channels; channel += 1) {
    channelData.push(buffer.getChannelData(channel));
  }

  const energy = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = startSample + frame * hopSize;
    let sum = 0;
    for (let index = 0; index < frameSize; index += 1) {
      let sample = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        sample += channelData[channel][offset + index] ?? 0;
      }
      sample /= channels;
      sum += sample * sample;
    }
    energy[frame] = Math.sqrt(sum / frameSize);
  }

  const onset = new Float32Array(frameCount);
  for (let frame = 1; frame < frameCount; frame += 1) {
    onset[frame] = Math.max(0, energy[frame] - energy[frame - 1]);
  }

  const hopSeconds = hopSize / sampleRate;
  const minBpm = 60;
  const maxBpm = 200;
  const minLag = Math.max(1, Math.floor(60 / maxBpm / hopSeconds));
  const maxLag = Math.min(
    frameCount - 1,
    Math.ceil(60 / minBpm / hopSeconds),
  );
  if (maxLag <= minLag) return 120;

  let bestLag = 0;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let score = 0;
    for (let frame = lag; frame < frameCount; frame += 1) {
      score += onset[frame] * onset[frame - lag];
    }
    score /= frameCount - lag;

    const candidate = 60 / (lag * hopSeconds);
    const octaveDistance = Math.log2(candidate / 120);
    const prior = Math.exp(
      -(octaveDistance * octaveDistance) / (2 * 0.85 * 0.85),
    );
    score *= prior;

    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  if (bestLag === 0 || bestScore <= 0) return 120;

  const bpm = 60 / (bestLag * hopSeconds);
  return Math.round(clamp(bpm, 60, 200));
}

export class LiveBpmTracker {
  private previousSpectrum: Uint8Array | null = null;
  private readonly fluxHistory: number[] = [];
  private readonly onsetTimes: number[] = [];
  private lastOnsetAt = Number.NEGATIVE_INFINITY;

  reset(): void {
    this.previousSpectrum = null;
    this.fluxHistory.length = 0;
    this.onsetTimes.length = 0;
    this.lastOnsetAt = Number.NEGATIVE_INFINITY;
  }

  update(analyser: AnalyserNode, timeSeconds: number): number | null {
    const binCount = analyser.frequencyBinCount;
    if (
      binCount < 2 ||
      typeof analyser.getByteFrequencyData !== "function" ||
      !Number.isFinite(timeSeconds)
    ) {
      return null;
    }

    const spectrum = new Uint8Array(binCount);
    analyser.getByteFrequencyData(spectrum);
    const binHz = analyser.context.sampleRate / analyser.fftSize;
    const firstBin = Math.max(1, Math.floor(35 / binHz));
    const lastBin = Math.min(binCount - 1, Math.ceil(160 / binHz));
    let flux = 0;
    for (let bin = firstBin; bin <= lastBin; bin += 1) {
      flux += Math.max(
        0,
        spectrum[bin] - (this.previousSpectrum?.[bin] ?? 0),
      );
    }

    const baseline =
      this.fluxHistory.length === 0
        ? 0
        : this.fluxHistory.reduce((sum, value) => sum + value, 0) /
          this.fluxHistory.length;
    const isOnset =
      flux > Math.max(4, baseline * 1.5) &&
      timeSeconds - this.lastOnsetAt >= 0.28;
    this.fluxHistory.push(flux);
    if (this.fluxHistory.length > 20) this.fluxHistory.shift();
    this.previousSpectrum = spectrum;

    if (isOnset) {
      this.lastOnsetAt = timeSeconds;
      this.onsetTimes.push(timeSeconds);
      if (this.onsetTimes.length > 10) this.onsetTimes.shift();
    }
    if (this.onsetTimes.length < 4) return null;

    const intervals = this.onsetTimes
      .slice(1)
      .map((time, index) => time - (this.onsetTimes[index] ?? time))
      .filter((interval) => interval >= 0.28 && interval <= 1.1)
      .sort((left, right) => left - right);
    if (intervals.length < 3) return null;

    const median = intervals[Math.floor(intervals.length / 2)];
    return Math.round(clamp(60 / median, 60, 200));
  }
}
