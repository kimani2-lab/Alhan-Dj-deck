import type { TrackResult } from "../lib/tracks";
import {
  genreMatchesTrack,
  scoreTrackTaste,
  type GenreId,
  type TasteProfile,
} from "./tasteProfile.ts";

export type EcosystemQueueSnapshot = {
  seed: TrackResult | null;
  upNextQueue: TrackResult[];
  playedHistory: string[];
  activeId: string | null;
  hasPrevious: boolean;
};

const clean = (value: string) =>
  value
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\b(official|audio|video|lyrics?|visuali[sz]er|hd|4k|topic)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

function songTitle(track: TrackResult): string {
  let cleaned = track.title
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\s*[-|]\s*(?:official\s*)?(?:audio|video|lyrics?).*$/i, "")
    .trim();
  const artist = track.channelTitle
    .replace(/\s+-\s+Topic$/i, "")
    .replace(/\s+(?:official|VEVO)$/i, "")
    .trim();
  const escapedArtist = artist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  cleaned = cleaned
    .replace(new RegExp(`^${escapedArtist}\\s*[-–—:]\\s*`, "i"), "")
    .replace(new RegExp(`\\s*[-–—:]\\s*${escapedArtist}$`, "i"), "");
  return clean(cleaned);
}

export function getEcosystemArtist(track: TrackResult): string {
  const channel = track.channelTitle
    .replace(/\s+-\s+Topic$/i, "")
    .replace(/\s+(?:official|VEVO)$/i, "")
    .trim();
  if (channel && channel.toLowerCase() !== "youtube") return channel;
  const match = track.title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return match?.[1]?.trim() ?? "";
}

function scoreCandidate(seed: TrackResult, candidate: TrackResult): number {
  const artist = clean(getEcosystemArtist(seed));
  const candidateArtist = clean(candidate.channelTitle);
  const candidateText = clean(`${candidate.title} ${candidate.channelTitle}`);
  const query = clean(seed.ecosystemQuery);
  let score = 0;

  if (artist && candidateArtist.includes(artist)) score += 100;
  if (artist && candidateText.includes(artist)) score += 45;
  if (query && candidateText.includes(query.replace(/\bsongs?\b/g, "").trim())) {
    score += 10;
  }
  if (/\b(official|topic|vevo)\b/i.test(candidate.channelTitle)) score += 8;
  if (/\b(official audio|official music video|audio)\b/i.test(candidate.title)) {
    score += 5;
  }
  if (/\b(reaction|review|tutorial|interview|podcast|gameplay|explained|shorts?)\b/i.test(candidate.title)) {
    score -= 200;
  }
  return score;
}

export function buildEcosystemQueue(
  seed: TrackResult,
  candidates: TrackResult[],
  playedHistory: Iterable<string> = [],
  limit = 10,
  tasteProfile: TasteProfile | null = null,
): TrackResult[] {
  const played = new Set(playedHistory);
  const seedTitle = songTitle(seed);
  const seen = new Set<string>([seed.id, ...played]);

  return candidates
    .filter((candidate) => {
      if (!candidate.id || seen.has(candidate.id)) return false;
      if (seedTitle && songTitle(candidate) === seedTitle) return false;
      if (played.has(candidate.id)) return false;
      seen.add(candidate.id);
      return true;
    })
    .map((track) => ({
      track,
      score: scoreCandidate(seed, track) + scoreTrackTaste(track, tasteProfile),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.track.title.localeCompare(right.track.title),
    )
    .slice(0, Math.max(0, limit))
    .map(({ track }) => track);
}

export class EcosystemQueueManager {
  private seed: TrackResult | null = null;
  private upNextQueue: TrackResult[] = [];
  private playedHistory = new Set<string>();
  private history: TrackResult[] = [];
  private historyIndex = -1;
  private activeId: string | null = null;
  private tasteProfile: TasteProfile | null = null;

  setTasteProfile(profile: TasteProfile | null): void {
    this.tasteProfile = profile;
    if (this.seed) {
      this.upNextQueue = buildEcosystemQueue(
        this.seed,
        this.upNextQueue,
        this.playedHistory,
        10,
        this.tasteProfile,
      );
    }
  }

  setSeed(track: TrackResult): void {
    this.seed = track;
    this.upNextQueue = [];
  }

  markPlaying(track: TrackResult): void {
    this.activeId = track.id;
    this.playedHistory.add(track.id);
    const existingIndex = this.history.findIndex((played) => played.id === track.id);
    if (existingIndex >= 0) {
      this.historyIndex = existingIndex;
    } else {
      this.history = [...this.history.slice(0, this.historyIndex + 1), track];
      this.historyIndex = this.history.length - 1;
    }
    this.upNextQueue = this.upNextQueue.filter(
      (candidate) => candidate.id !== track.id,
    );
  }

  peekPrevious(): TrackResult | null {
    return this.historyIndex > 0 ? this.history[this.historyIndex - 1] : null;
  }

  addCandidates(candidates: TrackResult[]): void {
    if (!this.seed) return;
    const merged = [...this.upNextQueue, ...candidates];
    this.upNextQueue = buildEcosystemQueue(
      this.seed,
      merged,
      this.playedHistory,
      10,
      this.tasteProfile,
    );
  }

  enqueue(track: TrackResult): boolean {
    if (!track.id || track.id === this.activeId) return false;
    if (this.upNextQueue.some((candidate) => candidate.id === track.id)) {
      return false;
    }
    this.upNextQueue = [...this.upNextQueue, track];
    return true;
  }

  peekNext(genreFilter?: GenreId | null): TrackResult | null {
    const available = this.upNextQueue.filter(
      (track) =>
        track.id !== this.activeId && !this.playedHistory.has(track.id),
    );
    if (genreFilter) {
      const genreMatch = available.find((track) =>
        genreMatchesTrack(track, genreFilter),
      );
      if (genreMatch) return genreMatch;
    }
    return available[0] ?? null;
  }

  shouldRefill(): boolean {
    return this.seed !== null && this.upNextQueue.length < 3;
  }

  clear(): void {
    this.seed = null;
    this.upNextQueue = [];
  }

  getSnapshot(): EcosystemQueueSnapshot {
    return {
      seed: this.seed,
      upNextQueue: [...this.upNextQueue],
      playedHistory: [...this.playedHistory],
      activeId: this.activeId,
      hasPrevious: this.historyIndex > 0,
    };
  }
}
