import { Deck, type DeckId } from "./Deck";
import { fetchAudioBuffer } from "./loadAudioBuffer";

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export class MixerEngine {
  readonly context: AudioContext;
  readonly deckA: Deck;
  readonly deckB: Deck;
  readonly padBus: GainNode;
  readonly masterInput: GainNode;

  private readonly master: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly crossfadeA: GainNode;
  private readonly crossfadeB: GainNode;
  private crossfaderPosition = 0;
  private masterVolume = 0.82;

  constructor(context?: AudioContext) {
    this.context =
      context ??
      new AudioContext({
        latencyHint: "interactive",
      });
    this.master = this.context.createGain();
    this.masterInput = this.master;
    this.limiter = this.context.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 8;
    this.limiter.ratio.value = 3;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;
    this.crossfadeA = this.context.createGain();
    this.crossfadeB = this.context.createGain();
    this.padBus = this.context.createGain();
    this.deckA = new Deck(this.context, "A");
    this.deckB = new Deck(this.context, "B");

    this.deckA.output.disconnect();
    this.deckB.output.disconnect();
    this.deckA.output.connect(this.deckA.analyser);
    this.deckB.output.connect(this.deckB.analyser);
    this.deckA.analyser.connect(this.crossfadeA);
    this.deckB.analyser.connect(this.crossfadeB);
    this.crossfadeA.connect(this.master);
    this.crossfadeB.connect(this.master);
    this.padBus.connect(this.master);
    this.master.connect(this.limiter);
    this.limiter.connect(this.context.destination);
    this.setCrossfader(0);
    this.setMasterVolume(this.masterVolume);
  }

  async resume(): Promise<void> {
    if (this.context.state === "suspended") await this.context.resume();
  }

  getDeck(id: DeckId): Deck {
    return id === "A" ? this.deckA : this.deckB;
  }

  setCrossfader(position: number): void {
    this.crossfaderPosition = clamp(position, -1, 1);
    const angle = ((this.crossfaderPosition + 1) * Math.PI) / 4;
    this.crossfadeA.gain.setTargetAtTime(
      Math.cos(angle),
      this.context.currentTime,
      0.015,
    );
    this.crossfadeB.gain.setTargetAtTime(
      Math.sin(angle),
      this.context.currentTime,
      0.015,
    );
  }

  setMasterVolume(value: number): void {
    this.masterVolume = clamp(value, 0, 1);
    this.master.gain.setTargetAtTime(
      this.masterVolume,
      this.context.currentTime,
      0.02,
    );
  }

  getCrossfader(): number {
    return this.crossfaderPosition;
  }

  getMasterVolume(): number {
    return this.masterVolume;
  }

  syncDeck(id: DeckId): void {
    const target = id === "A" ? this.deckA : this.deckB;
    const reference = id === "A" ? this.deckB : this.deckA;
    const desiredRate = reference.getBpm() / target.getBpm();
    target.setTempo((desiredRate - 1) * 100);
  }

  async loadFile(id: DeckId, file: File): Promise<void> {
    const buffer = await this.context.decodeAudioData(
      await file.arrayBuffer(),
    );
    await this.getDeck(id).load(buffer, file.name);
  }

  async loadUrl(
    id: DeckId,
    url: string,
    title: string,
    metadata?: { id: string; channelTitle: string; thumbnail: string },
  ): Promise<void> {
    const buffer = await fetchAudioBuffer(this.context, url);
    await this.getDeck(id).load(buffer, title, metadata);
  }

  dispose(): void {
    this.deckA.dispose();
    this.deckB.dispose();
    this.crossfadeA.disconnect();
    this.crossfadeB.disconnect();
    this.padBus.disconnect();
    this.master.disconnect();
    this.limiter.disconnect();
    void this.context.close();
  }
}
