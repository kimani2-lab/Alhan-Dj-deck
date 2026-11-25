"use client";

import {
  ArrowRight,
  Bot,
  Headphones,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Volume2,
} from "lucide-react";

export default function SettingsPanel({
  botActivated,
  onActivateBot,
  onDeactivateBot,
  onOpenBot,
  selectedGenres,
  onEditTaste,
  historyCount,
  onClearHistory,
  onOpenDj,
}: {
  botActivated: boolean;
  onActivateBot: () => void;
  onDeactivateBot: () => void;
  onOpenBot: () => void;
  selectedGenres: number;
  onEditTaste: () => void;
  historyCount: number;
  onClearHistory: () => void;
  onOpenDj: () => void;
}) {
  return (
    <section className="app-info-page" aria-label="Settings">
      <header className="app-info-head">
        <span className="eyebrow">SYSTEM CONTROL</span>
        <h1>Settings</h1>
        <p>
          Manage ALHAN Bot activation, your taste profile, and listening data.
        </p>
      </header>

      <div className="app-info-grid">
        <article className="app-info-card app-info-card-accent">
          <div className="app-info-card-head">
            <span className="app-info-icon">
              <Bot size={20} />
            </span>
            <div>
              <b>ALHAN Bot</b>
              <small className={botActivated ? "status-on" : "status-off"}>
                {botActivated ? "ACTIVATED" : "NOT ACTIVATED"}
              </small>
            </div>
          </div>
          <p>
            ALHAN plays requested songs, tunes 8D and vibes, and turns an
            ordered DJ list into a high-vibe set. Deactivating locks the chat
            and setlist builder until you activate again.
          </p>
          <div className="app-info-actions">
            {botActivated ? (
              <button
                type="button"
                className="app-info-button danger"
                onClick={onDeactivateBot}
              >
                <RotateCcw size={13} /> Reset &amp; Deactivate
              </button>
            ) : (
              <button
                type="button"
                className="app-info-button primary"
                onClick={onActivateBot}
              >
                <Sparkles size={13} /> Activate ALHAN Bot
              </button>
            )}
            <button
              type="button"
              className="app-info-button"
              onClick={onOpenBot}
            >
              Open Bot <ArrowRight size={13} />
            </button>
          </div>
        </article>

        <article className="app-info-card">
          <div className="app-info-card-head">
            <span className="app-info-icon">
              <SlidersHorizontal size={20} />
            </span>
            <div>
              <b>Taste profile</b>
              <small>{selectedGenres} GENRES TUNED</small>
            </div>
          </div>
          <p>
            Your selected genres and repeat plays shape Trending Now and the
            ecosystem queue. You need at least three genres for a personalised
            mix.
          </p>
          <div className="app-info-actions">
            <button
              type="button"
              className="app-info-button"
              onClick={onEditTaste}
            >
              Edit taste profile <ArrowRight size={13} />
            </button>
          </div>
        </article>

        <article className="app-info-card">
          <div className="app-info-card-head">
            <span className="app-info-icon">
              <Trash2 size={20} />
            </span>
            <div>
              <b>Recently played</b>
              <small>{historyCount} TRACKS SAVED</small>
            </div>
          </div>
          <p>
            Clear the local listening history used by the Home panel. This does
            not delete your taste profile.
          </p>
          <div className="app-info-actions">
            <button
              type="button"
              className="app-info-button danger"
              onClick={onClearHistory}
              disabled={historyCount === 0}
            >
              <Trash2 size={13} /> Clear history
            </button>
          </div>
        </article>

        <article className="app-info-card">
          <div className="app-info-card-head">
            <span className="app-info-icon">
              <Volume2 size={20} />
            </span>
            <div>
              <b>Audio engine</b>
              <small>LARGE HALL 8D · STEREO</small>
            </div>
          </div>
          <p>
            Master volume, crossfader, spatial width, and hall size live on the
            DJ decks. Open DJ Mode to fine-tune the output.
          </p>
          <div className="app-info-actions">
            <button
              type="button"
              className="app-info-button"
              onClick={onOpenDj}
            >
              <Headphones size={13} /> Open DJ Mode
            </button>
          </div>
        </article>
      </div>
    </section>
  );
}
