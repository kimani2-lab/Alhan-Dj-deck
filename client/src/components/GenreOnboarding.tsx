"use client";

import { Check, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { type CSSProperties, useState } from "react";
import GenreIcon, { genreAccent } from "./GenreIcon";
import {
  createTasteProfile,
  GENRES,
  MINIMUM_SELECTED_GENRES,
  type GenreId,
  type TasteProfile,
} from "../utils/tasteProfile";

export default function GenreOnboarding({
  open,
  profile,
  onSave,
  onClose,
}: {
  open: boolean;
  profile: TasteProfile | null;
  onSave: (profile: TasteProfile) => void;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <GenreOnboardingForm
      profile={profile}
      onSave={onSave}
      onClose={onClose}
    />
  );
}

function GenreOnboardingForm({
  profile,
  onSave,
  onClose,
}: {
  profile: TasteProfile | null;
  onSave: (profile: TasteProfile) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<GenreId[]>(
    profile?.selectedGenres ?? [],
  );

  const toggle = (genre: GenreId) => {
    setSelected((current) =>
      current.includes(genre)
        ? current.filter((item) => item !== genre)
        : [...current, genre],
    );
  };

  const save = () => {
    if (selected.length < MINIMUM_SELECTED_GENRES) return;
    const next = {
      ...(profile ?? createTasteProfile()),
      selectedGenres: selected,
    };
    onSave(next);
  };

  return (
    <div className="genre-onboarding" role="dialog" aria-modal="true" aria-label="Choose your music genres">
      <section className="genre-onboarding-card">
        <header className="genre-onboarding-head">
          <div className="genre-onboarding-mark"><Sparkles size={21} /></div>
          <div>
            <span className="eyebrow">ALHAN TASTE PROFILE</span>
            <h1>What moves you?</h1>
            <p>Choose at least {MINIMUM_SELECTED_GENRES} genres. ALHAN will tune the mix to your energy.</p>
          </div>
          <button type="button" className="genre-onboarding-close" onClick={onClose} aria-label="Close taste profile">
            <X size={18} />
          </button>
        </header>

        <div className="genre-grid" role="group" aria-label="Music genres">
          {GENRES.map((genre) => {
            const checked = selected.includes(genre.id);
            return (
              <button
                type="button"
                key={genre.id}
                className={`genre-card genre-${genre.id} ${checked ? "selected" : ""}`}
                aria-pressed={checked}
                onClick={() => toggle(genre.id)}
              >
                <span className="genre-card-check">
                  {checked ? <Check size={13} /> : null}
                </span>
                <span
                  className="genre-card-icon"
                  style={
                    {
                      "--genre-accent": genreAccent(genre.id),
                    } as CSSProperties
                  }
                >
                  <GenreIcon genre={genre.id} size={21} />
                </span>
                <b>{genre.label}</b>
                <small>{checked ? "IN YOUR MIX" : "ADD TO TASTE"}</small>
              </button>
            );
          })}
        </div>

        <footer className="genre-onboarding-footer">
          <span>
            <SlidersHorizontal size={13} />
            {selected.length}/{GENRES.length} selected
          </span>
          <button
            type="button"
            className="genre-onboarding-start"
            disabled={selected.length < MINIMUM_SELECTED_GENRES}
            onClick={save}
          >
            {profile ? "UPDATE MY TASTE" : "ENTER ALHAN DJ"}
          </button>
        </footer>
      </section>
    </div>
  );
}
