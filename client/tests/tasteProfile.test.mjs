import assert from "node:assert/strict";
import test from "node:test";
import {
  createTasteProfile,
  inferGenres,
  inferTrackGenres,
  isGenreBoosted,
  loadTasteProfile,
  normalizeTasteProfile,
  recordTastePlay,
  recordTasteSearch,
  saveTasteProfile,
  scoreTrackTaste,
  TASTE_PROFILE_STORAGE_KEY,
} from "../src/utils/tasteProfile.ts";
import { normalizeTrack } from "../src/lib/tracks.ts";

test("requires at least three genres in persisted taste profiles", () => {
  assert.equal(normalizeTasteProfile({
    selectedGenres: ["hip-hop", "drill"],
    genreAffinities: {},
  }), null);
  assert.deepEqual(
    normalizeTasteProfile({
      selectedGenres: ["hip-hop", "drill", "afrobeats"],
      genreAffinities: { "hip-hop": 4 },
    })?.selectedGenres,
    ["hip-hop", "drill", "afrobeats"],
  );
});

test("infers genres and increments repeat-search and play affinities", () => {
  assert.deepEqual(
    inferGenres("Drill mix by Central Cee").sort(),
    ["drill", "hip-hop"].sort(),
  );
  let profile = createTasteProfile(["drill", "hip-hop", "afrobeats"]);
  profile = recordTasteSearch(profile, "UK drill mix");
  profile = recordTasteSearch(profile, "Central Cee drill");
  profile = recordTastePlay(profile, normalizeTrack({
    id: "drill1",
    title: "Drill Track",
    channelTitle: "UK Drill",
  }));

  assert.equal(profile.genreAffinities.drill >= 3, true);
  assert.equal(isGenreBoosted(profile, "drill"), true);
  assert.deepEqual(profile.recentSearches.slice(0, 2), [
    "Central Cee drill",
    "UK drill mix",
  ]);
});

test("boosts matching tracks but keeps ecosystem scoring combined", () => {
  const track = normalizeTrack({
    id: "afrobeats1",
    title: "Davido Afrobeats Mix",
    channelTitle: "Afrobeats Music",
  });
  const profile = createTasteProfile(["afrobeats", "drill", "amapiano"]);
  profile.genreAffinities.afrobeats = 5;
  assert.ok(inferTrackGenres(track).includes("afrobeats"));
  assert.ok(scoreTrackTaste(track, profile) >= 7);
});

test("round-trips selected genres and affinities through localStorage-like storage", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const profile = createTasteProfile(["hip-hop", "gengetone", "amapiano"]);
  profile.genreAffinities = { "hip-hop": 6, amapiano: 3 };
  saveTasteProfile(storage, profile);
  assert.equal(values.has(TASTE_PROFILE_STORAGE_KEY), true);
  assert.deepEqual(loadTasteProfile(storage)?.genreAffinities, {
    "hip-hop": 6,
    amapiano: 3,
  });
});
