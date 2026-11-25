import type { TrackResult } from "./tracks";

export type AiStage = "build" | "peak" | "drive" | "lift";

export type AiPlayRequestAction = {
  type: "play_request";
  query: string;
  enable8d: boolean;
  bassBoost: boolean;
};

export type AiSetStep = {
  order: number;
  track: string;
  stage: AiStage;
  energy: number;
  vibe: string;
  tip: string;
  transition: string;
  enable8d: boolean;
  bassBoost: boolean;
  bridge: string;
  followUp: string;
};

export type AiHighVibeSetAction = {
  type: "high_vibe_set";
  title: string;
  vibe: string;
  steps: AiSetStep[];
};

export type AiDjAction = AiPlayRequestAction | AiHighVibeSetAction;

export type AiDjResponse = {
  action: AiDjAction;
  reply: string;
  meta?: {
    source?: string;
    model?: string | null;
    degraded?: boolean;
    workflow?: string;
  };
};

export type AiSetQueueItem = {
  track: TrackResult;
  step: AiSetStep;
};

export type DeckFx = {
  enable8d?: boolean;
  bassBoost?: boolean;
};

export const STAGE_LABELS: Record<AiStage, string> = {
  build: "Build",
  peak: "Peak",
  drive: "Drive",
  lift: "Lift",
};

export function isAiStage(value: string): value is AiStage {
  return value === "build" || value === "peak" || value === "drive" || value === "lift";
}
