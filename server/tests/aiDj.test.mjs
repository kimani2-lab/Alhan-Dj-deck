import assert from "node:assert/strict";
import test from "node:test";
import { buildPrompt, extractPlayQuery } from "../src/aiDj.js";

test("extracts a song request after ALHAN's wake word and polite phrasing", () => {
  assert.equal(
    extractPlayQuery("Alhan can you kindly play for me Faded by Alan Walker"),
    "Faded by Alan Walker",
  );
});

test("extracts a song request with an alternate greeting", () => {
  assert.equal(
    extractPlayQuery("Hey Alhan, please play me Faded by Alan Walker."),
    "Faded by Alan Walker",
  );
  assert.equal(
    extractPlayQuery("Alham, play Faded by Alan Walker."),
    "Faded by Alan Walker",
  );
});

test("keeps a plain song and artist request intact", () => {
  assert.equal(
    extractPlayQuery("Faded by Alan Walker"),
    "Faded by Alan Walker",
  );
});

test("removes trailing thanks without damaging an Alan Walker artist name", () => {
  assert.equal(
    extractPlayQuery("Play faded by Alan Walker thank"),
    "faded by Alan Walker",
  );
  assert.equal(
    extractPlayQuery("Alan Walker - Faded"),
    "Alan Walker - Faded",
  );
});

test("includes selected genres, affinities, and recent searches in AI DJ prompts", () => {
  const prompt = buildPrompt({
    message: "Play something for tonight",
    orderedTracks: [],
    includeBridges: true,
    workflow: "vibe",
    selectedGenres: ["drill", "afrobeats", "amapiano"],
    genreAffinities: { drill: 6, afrobeats: 3 },
    recentSearches: ["UK drill mix", "Davido Afrobeats"],
  });

  assert.match(prompt, /User taste genres: drill, afrobeats, amapiano/);
  assert.match(prompt, /drill=6/);
  assert.match(prompt, /Recent searches: UK drill mix \| Davido Afrobeats/);
  assert.match(prompt, /respect the explicit song, artist, vibe, or exact setlist request/);
});
