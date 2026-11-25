import type { TrackResult } from "../lib/tracks";

export const TASTE_PROFILE_STORAGE_KEY = "alhan-dj:taste-profile:v1";
export const MINIMUM_SELECTED_GENRES = 3;
export const RECENT_SEARCH_LIMIT = 10;
export const GENRE_BOOST_THRESHOLD = 2;

export const GENRES = [
  {
    id: "hip-hop",
    label: "Hip Hop & Rap",
    aliases: ["hip hop", "hip-hop", "hiphop", "rap", "trap", "drake", "kendrick lamar", "central cee"],
  },
  {
    id: "afrobeats",
    label: "Afrobeats",
    aliases: ["afrobeats", "afrobeat", "afropop", "burna boy", "davido", "wizkid", "rema", "ayra starr", "asake", "tems"],
  },
  {
    id: "house-edm",
    label: "EDM & Dance",
    aliases: ["house", "edm", "electronic", "techno", "trance", "dubstep", "dance music", "dance", "alan walker", "martin garrix", "avicii", "calvin harris"],
  },
  {
    id: "rock",
    label: "Rock",
    aliases: ["rock", "alternative rock", "indie rock", "classic rock", "metal", "punk", "guitar", "queen", "nirvana", "acdc", "linkin park", "arctic monkeys"],
  },
  {
    id: "r-and-b",
    label: "RnB",
    aliases: ["r and b", "rnb", "rhythm and blues", "neo soul", "sza", "usher", "summer walker", "alicia keys"],
  },
  {
    id: "reggae",
    label: "Reggae",
    aliases: ["reggae", "dancehall", "ska", "bob marley", "chronixx", "sean paul", "koffee", "burning spears"],
  },
  {
    id: "classical",
    label: "Classical",
    aliases: ["classical", "orchestral", "symphony", "piano", "beethoven", "mozart", "bach", "chopin", "ludovico einaudi", "hans zimmer"],
  },
  {
    id: "jazz",
    label: "Jazz",
    aliases: ["jazz", "smooth jazz", "bebop", "miles davis", "john coltrane", "nina simone", "lo-fi jazz", "esperanza spalding"],
  },
  {
    id: "gengetone",
    label: "Gengetone",
    aliases: ["gengetone", "genge", "shrap", "mejja", "ethic entertainment"],
  },
  {
    id: "drill",
    label: "Drill",
    aliases: ["drill", "uk drill", "ny drill", "chicago drill", "central cee"],
  },
  {
    id: "amapiano",
    label: "Amapiano",
    aliases: ["amapiano", "log drum", "bacardi", "kabza de small", "dj maphorisa", "uncle waffles", "busta 929"],
  },
  {
    id: "pop",
    label: "Pop",
    aliases: ["pop music", "pop", "top 40", "taylor swift", "dua lipa", "ariana grande"],
  },
  {
    id: "k-pop",
    label: "K-Pop",
    aliases: ["k pop", "k-pop", "korean pop", "bts", "blackpink", "newjeans", "stray kids"],
  },
  {
    id: "country",
    label: "Country",
    aliases: ["country", "country pop", "country rock", "dolly parton", "johnny cash", "morgan wallen"],
  },
  {
    id: "blues",
    label: "Blues",
    aliases: ["blues", "rhythm and blues", "delta blues", "bb king", "muddy waters", "robert johnson"],
  },
  {
    id: "gospel",
    label: "Gospel",
    aliases: ["gospel", "christian music", "praise and worship", "cece winans", "kirk franklin", "donnie mcclurkin"],
  },
  {
    id: "soul",
    label: "Soul",
    aliases: ["soul", "neo soul", "motown", "aretha franklin", "marvin gaye", "al green"],
  },
  {
    id: "latin",
    label: "Latin",
    aliases: ["latin", "latin pop", "reggaeton", "bachata", "bad bunny", "karol g", "shakira"],
  },
  {
    id: "folk",
    label: "Folk",
    aliases: ["folk", "indie folk", "acoustic", "bob dylan", "mumford and sons", "joan baez"],
  },
  {
    id: "indie",
    label: "Indie",
    aliases: ["indie", "indie pop", "indie rock", "tame impala", "the 1975", "phoebe bridgers"],
  },
  {
    id: "metal",
    label: "Metal",
    aliases: ["metal", "heavy metal", "death metal", "metallica", "iron maiden", "slipknot"],
  },
  {
    id: "kwaito",
    label: "Kwaito",
    aliases: ["kwaito", "south african house", "brenda fassie", "mdu", "tkzee", "boom shaka"],
  },
] as const;

export type GenreId = (typeof GENRES)[number]["id"];

export const HOME_GENRE_IDS: readonly GenreId[] = [
  "hip-hop",
  "afrobeats",
  "house-edm",
  "rock",
  "r-and-b",
  "reggae",
  "classical",
  "jazz",
];

export function genreLabel(id: GenreId): string {
  return GENRES.find((genre) => genre.id === id)?.label ?? id;
}

export function genreQuery(id: GenreId): string {
  return `${genreLabel(id)} official audio mix`;
}

export type TasteProfile = {
  selectedGenres: GenreId[];
  genreAffinities: Partial<Record<GenreId, number>>;
  recentSearches: string[];
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const GENRE_IDS = new Set<string>(GENRES.map(({ id }) => id));

export function isGenreId(value: unknown): value is GenreId {
  return typeof value === "string" && GENRE_IDS.has(value);
}

export function createTasteProfile(selectedGenres: GenreId[] = []): TasteProfile {
  return {
    selectedGenres: [...new Set(selectedGenres)],
    genreAffinities: {},
    recentSearches: [],
  };
}

function normalizeTasteProfileInternal(
  value: unknown,
  requireMinimumGenres: boolean,
): TasteProfile | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const selectedGenres = Array.isArray(record.selectedGenres)
    ? [...new Set(record.selectedGenres.filter(isGenreId))]
    : [];
  if (requireMinimumGenres && selectedGenres.length < MINIMUM_SELECTED_GENRES) {
    return null;
  }

  const rawAffinities =
    record.genreAffinities && typeof record.genreAffinities === "object"
      ? (record.genreAffinities as Record<string, unknown>)
      : {};
  const genreAffinities: Partial<Record<GenreId, number>> = {};
  for (const { id } of GENRES) {
    const valueForGenre = rawAffinities[id];
    if (typeof valueForGenre === "number" && Number.isFinite(valueForGenre)) {
      genreAffinities[id] = Math.max(0, Math.min(100, valueForGenre));
    }
  }
  const recentSearches = Array.isArray(record.recentSearches)
    ? record.recentSearches
        .filter((search): search is string => typeof search === "string")
        .map((search) => search.trim().slice(0, 160))
        .filter(Boolean)
        .slice(0, RECENT_SEARCH_LIMIT)
    : [];

  return { selectedGenres, genreAffinities, recentSearches };
}

export function normalizeTasteProfile(value: unknown): TasteProfile | null {
  return normalizeTasteProfileInternal(value, true);
}

export function normalizeTasteDraft(value: unknown): TasteProfile | null {
  return normalizeTasteProfileInternal(value, false);
}

function readStoredProfile(
  storage: StorageLike,
  normalize: (value: unknown) => TasteProfile | null,
): TasteProfile | null {
  const saved = storage.getItem(TASTE_PROFILE_STORAGE_KEY);
  if (!saved) return null;
  try {
    return normalize(JSON.parse(saved) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export function loadTasteProfile(storage: StorageLike): TasteProfile | null {
  return readStoredProfile(storage, normalizeTasteProfile);
}

export function loadTasteDraft(storage: StorageLike): TasteProfile | null {
  return readStoredProfile(storage, normalizeTasteDraft);
}

export function saveTasteProfile(
  storage: StorageLike,
  profile: TasteProfile,
): void {
  storage.setItem(TASTE_PROFILE_STORAGE_KEY, JSON.stringify(profile));
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function inferGenres(value: string): GenreId[] {
  const text = ` ${normalizeText(value)} `;
  const matched = new Set<GenreId>();
  for (const genre of GENRES) {
    if (
      genre.aliases.some((alias) =>
        text.includes(` ${normalizeText(alias)} `),
      )
    ) {
      matched.add(genre.id);
    }
  }
  if (matched.has("drill")) matched.add("hip-hop");
  return [...matched];
}

export function inferTrackGenres(track: TrackResult): GenreId[] {
  return [
    ...new Set([
      ...(track.genreTags ?? []).filter(isGenreId),
      ...inferGenres(
        `${track.title} ${track.channelTitle} ${track.ecosystemQuery}`,
      ),
    ]),
  ];
}

function addAffinity(
  profile: TasteProfile,
  genres: GenreId[],
  weight: number,
): TasteProfile {
  const genreAffinities = { ...profile.genreAffinities };
  for (const genre of genres) {
    genreAffinities[genre] = Math.min(
      100,
      (genreAffinities[genre] ?? 0) + weight,
    );
  }
  return { ...profile, genreAffinities };
}

export function recordTasteSearch(
  profile: TasteProfile,
  query: string,
): TasteProfile {
  const search = query.trim().slice(0, 160);
  if (!search) return profile;
  const updated = addAffinity(profile, inferGenres(search), 1);
  return {
    ...updated,
    recentSearches: [search, ...profile.recentSearches].slice(
      0,
      RECENT_SEARCH_LIMIT,
    ),
  };
}

export function recordTastePlay(
  profile: TasteProfile,
  track: TrackResult,
): TasteProfile {
  return addAffinity(profile, inferTrackGenres(track), 1);
}

export function scoreTrackTaste(
  track: TrackResult,
  profile: TasteProfile | null,
): number {
  if (!profile) return 0;
  return inferTrackGenres(track).reduce((score, genre) => {
    const selectedBoost = profile.selectedGenres.includes(genre) ? 2 : 0;
    const affinityBoost = Math.min(
      6,
      profile.genreAffinities[genre] ?? 0,
    );
    return score + selectedBoost + affinityBoost;
  }, 0);
}

export function isGenreBoosted(
  profile: TasteProfile,
  genre: GenreId,
): boolean {
  return (profile.genreAffinities[genre] ?? 0) >= GENRE_BOOST_THRESHOLD;
}

export function genreMatchesTrack(track: TrackResult, genre: GenreId): boolean {
  return inferTrackGenres(track).includes(genre);
}

export function prioritizedSelectedGenres(
  profile: TasteProfile,
  limit = 2,
): GenreId[] {
  return [...profile.selectedGenres]
    .sort(
      (left, right) =>
        (profile.genreAffinities[right] ?? 0) -
        (profile.genreAffinities[left] ?? 0),
    )
    .slice(0, Math.max(0, limit));
}

export function getTrendingGenreIds(
  profile: TasteProfile,
  limit = 3,
  fallback: GenreId[] = ["hip-hop", "afrobeats", "amapiano"],
): GenreId[] {
  const base = prioritizedSelectedGenres(profile, limit);
  const boosted = (
    Object.entries(profile.genreAffinities) as [GenreId, number][]
  )
    .filter(
      ([genre, value]) =>
        !profile.selectedGenres.includes(genre) &&
        value >= GENRE_BOOST_THRESHOLD,
    )
    .sort((left, right) => right[1] - left[1])[0]?.[0];
  const seeds = base.length > 0 ? base : fallback;
  return [...new Set<GenreId>([...seeds, ...(boosted ? [boosted] : [])])].slice(
    0,
    Math.max(0, limit),
  );
}
