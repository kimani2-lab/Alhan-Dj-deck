import {
  AudioWaveform,
  Disc3,
  Drum,
  Drumstick,
  Flame,
  Guitar,
  Heart,
  MicVocal,
  Music2,
  PartyPopper,
  Piano,
  Radio,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { GenreId } from "../utils/tasteProfile";

const GENRE_ICONS: Record<GenreId, LucideIcon> = {
  "hip-hop": MicVocal,
  afrobeats: Drum,
  "house-edm": AudioWaveform,
  rock: Guitar,
  "r-and-b": Heart,
  reggae: Radio,
  classical: Piano,
  jazz: Disc3,
  gengetone: PartyPopper,
  drill: Flame,
  amapiano: Drumstick,
  pop: Sparkles,
  "k-pop": Sparkles,
  country: Guitar,
  blues: AudioWaveform,
  gospel: MicVocal,
  soul: Heart,
  latin: PartyPopper,
  folk: Disc3,
  indie: Radio,
  metal: Flame,
  kwaito: Drum,
};

const GENRE_ACCENTS: Record<GenreId, string> = {
  "hip-hop": "#ff9a62",
  afrobeats: "#ffd166",
  "house-edm": "#4de1ff",
  rock: "#ff6b8b",
  "r-and-b": "#c79bff",
  reggae: "#5ee39a",
  classical: "#f3e7c8",
  jazz: "#7fb2ff",
  gengetone: "#ff8fd0",
  drill: "#ff5c5c",
  amapiano: "#5ad1c8",
  pop: "#ffb3f0",
  "k-pop": "#b5a0ff",
  country: "#f2c078",
  blues: "#58a6ff",
  gospel: "#f7df85",
  soul: "#ff96a8",
  latin: "#ff8f4d",
  folk: "#9bd0a2",
  indie: "#b4b9ff",
  metal: "#d8dfe8",
  kwaito: "#7ddfbd",
};

export function genreAccent(genre: GenreId): string {
  return GENRE_ACCENTS[genre] ?? "#70e3ff";
}

export default function GenreIcon({
  genre,
  size = 18,
  strokeWidth = 2,
  className,
}: {
  genre: GenreId;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  const Icon = GENRE_ICONS[genre] ?? Music2;
  return (
    <Icon
      aria-hidden="true"
      className={className}
      size={size}
      strokeWidth={strokeWidth}
    />
  );
}
