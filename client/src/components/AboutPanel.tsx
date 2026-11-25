"use client";

import {
  ArrowRight,
  AudioLines,
  Bot,
  Download,
  Headphones,
  House,
  ListMusic,
  Radio,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

export default function AboutPanel({
  onOpenHome,
  onOpenBot,
}: {
  onOpenHome: () => void;
  onOpenBot: () => void;
}) {
  return (
    <section className="app-info-page" aria-label="About ALHAN DJ">
      <header className="app-info-head">
        <span className="eyebrow">ABOUT</span>
        <h1>ALHAN DJ</h1>
        <p>
          A browser-based dual-deck DJ studio with a live YouTube catalog,
          Large Hall 8D spatial audio, and a taste-aware music director.
        </p>
      </header>

      <div className="app-info-hero">
        <span className="app-info-hero-mark">
          <AudioLines size={38} />
        </span>
        <div>
          <b>Feel the Beat</b>
          <span>Mix · Play · Enjoy</span>
        </div>
        <span className="app-info-version">v1.0</span>
      </div>

      <div className="app-info-grid">
        <article className="app-info-card">
          <div className="app-info-card-head">
            <span className="app-info-icon">
              <Headphones size={20} />
            </span>
            <div>
              <b>Large Hall 8D</b>
              <small>SPATIAL AUDIO ENGINE</small>
            </div>
          </div>
          <p>
            Convolution-based hall reverbs, rotating spatial panning, and
            per-deck effects for an immersive listening room.
          </p>
        </article>

        <article className="app-info-card">
          <div className="app-info-card-head">
            <span className="app-info-icon">
              <Bot size={20} />
            </span>
            <div>
              <b>ALHAN Bot</b>
              <small>VOICE + SETLIST DIRECTOR</small>
            </div>
          </div>
          <p>
            Ask for songs by voice or text, tune the vibe, or turn an ordered
            song list into a staged high-energy set.
          </p>
        </article>

        <article className="app-info-card">
          <div className="app-info-card-head">
            <span className="app-info-icon">
              <Radio size={20} />
            </span>
            <div>
              <b>Live catalog</b>
              <small>YOUTUBE + YT-DLP</small>
            </div>
          </div>
          <p>
            Search, stream, and download tracks through the local API. Genre
            shelves and Trending Now stay fresh from live results.
          </p>
        </article>

        <article className="app-info-card">
          <div className="app-info-card-head">
            <span className="app-info-icon">
              <ListMusic size={20} />
            </span>
            <div>
              <b>Ecosystem queue</b>
              <small>TASTE-AWARE AUTOPLAY</small>
            </div>
          </div>
          <p>
            Queue tracks manually or let ALHAN build an artist ecosystem that
            keeps playing after the current track ends.
          </p>
        </article>
      </div>

      <div className="app-info-footer">
        <span>
          <ShieldCheck size={13} /> Everything runs locally in your browser and
          audio API.
        </span>
        <div className="app-info-actions">
          <button
            type="button"
            className="app-info-button"
            onClick={onOpenHome}
          >
            <House size={13} /> Back to Home
          </button>
          <button
            type="button"
            className="app-info-button primary"
            onClick={onOpenBot}
          >
            <Sparkles size={13} /> Open ALHAN Bot <ArrowRight size={13} />
          </button>
        </div>
      </div>

      <p className="app-info-legal">
        <Download size={11} /> Downloads are provided by the local audio API.
        Respect the rights of the original artists.
      </p>
      <div className="app-info-actions desktop-download-action">
        <a
          className="app-info-button primary"
          href="https://github.com/kimani2-lab/Alhan-Dj-deck/releases"
          target="_blank"
          rel="noreferrer"
        >
          <Download size={13} /> Download Desktop App
        </a>
      </div>
    </section>
  );
}
