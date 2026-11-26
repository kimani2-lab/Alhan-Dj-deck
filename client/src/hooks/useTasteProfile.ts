"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TrackResult } from "../lib/tracks";
import {
  loadTasteDraft,
  loadTasteProfile,
  MINIMUM_SELECTED_GENRES,
  recordTastePlay,
  recordTasteSearch,
  saveTasteProfile,
  type GenreId,
  type TasteProfile,
} from "../utils/tasteProfile";

const RECENTLY_PLAYED_KEY = "alhan-dj:recently-played:v1";

export type TasteProfileWithHistory = TasteProfile & {
  recentlyPlayed: TrackResult[];
};

function loadRecentlyPlayed(): TrackResult[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(
      window.localStorage.getItem(RECENTLY_PLAYED_KEY) ?? "[]",
    ) as unknown;
    return Array.isArray(value) ? (value as TrackResult[]) : [];
  } catch {
    return [];
  }
}

const emptyProfile = (): TasteProfile => ({
  selectedGenres: [],
  genreAffinities: {},
  recentSearches: [],
});

export function useTasteProfile(initialProfile?: TasteProfile | null) {
  const [profile, setProfile] = useState<TasteProfileWithHistory>(() => {
    return {
      ...(initialProfile ?? emptyProfile()),
      recentlyPlayed: [],
    };
  });
  const profileRef = useRef(profile);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const stored =
      loadTasteDraft(window.localStorage) ??
      loadTasteProfile(window.localStorage);
    const next = {
      ...(stored ?? profileRef.current),
      recentlyPlayed: loadRecentlyPlayed(),
    };
    profileRef.current = next;
    setProfile(next);
    setIsLoaded(true);
  }, []);

  const persist = useCallback((next: TasteProfileWithHistory) => {
    profileRef.current = next;
    setProfile(next);
    if (typeof window === "undefined") return;
    saveTasteProfile(window.localStorage, {
      selectedGenres: next.selectedGenres,
      genreAffinities: next.genreAffinities,
      recentSearches: next.recentSearches,
    });
    window.localStorage.setItem(
      RECENTLY_PLAYED_KEY,
      JSON.stringify(next.recentlyPlayed.slice(0, 20)),
    );
  }, []);

  const updateProfile = useCallback(
    (next: TasteProfile) => {
      persist({ ...next, recentlyPlayed: profileRef.current.recentlyPlayed });
    },
    [persist],
  );

  const setSelectedGenres = useCallback(
    (genres: GenreId[]) => {
      const current = profileRef.current;
      persist({ ...current, selectedGenres: [...new Set(genres)] });
    },
    [persist],
  );

  const toggleGenre = useCallback(
    (genre: GenreId) => {
      const current = profileRef.current;
      const selectedGenres = current.selectedGenres.includes(genre)
        ? current.selectedGenres.filter((item) => item !== genre)
        : [...current.selectedGenres, genre];
      persist({ ...current, selectedGenres });
    },
    [persist],
  );

  const recordSearch = useCallback(
    (query: string) => {
      const current = profileRef.current;
      const nextProfile = recordTasteSearch(current, query);
      persist({ ...nextProfile, recentlyPlayed: current.recentlyPlayed });
    },
    [persist],
  );

  const recordPlayed = useCallback(
    (track: TrackResult) => {
      const current = profileRef.current;
      const nextProfile = recordTastePlay(current, track);
      persist({
        ...nextProfile,
        recentlyPlayed: [
          track,
          ...current.recentlyPlayed.filter((item) => item.id !== track.id),
        ].slice(0, 20),
      });
    },
    [persist],
  );

  const clearRecentlyPlayed = useCallback(() => {
    const current = profileRef.current;
    persist({ ...current, recentlyPlayed: [] });
  }, [persist]);

  const hasCompletedTaste =
    profile.selectedGenres.length >= MINIMUM_SELECTED_GENRES;

  return useMemo(
    () => ({
      profile,
      isLoaded,
      hasCompletedTaste,
      updateProfile,
      setSelectedGenres,
      toggleGenre,
      recordSearch,
      recordPlayed,
      clearRecentlyPlayed,
    }),
    [
      profile,
      isLoaded,
      hasCompletedTaste,
      updateProfile,
      setSelectedGenres,
      toggleGenre,
      recordSearch,
      recordPlayed,
      clearRecentlyPlayed,
    ],
  );
}
