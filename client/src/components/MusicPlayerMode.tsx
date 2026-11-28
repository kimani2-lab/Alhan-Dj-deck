"use client";

import {
  Download,
  FolderOpen,
  AudioLines,
  Headphones,
  LoaderCircle,
  Pause,
  Play,
  Radio,
  Search,
  SkipBack,
  SkipForward,
  Volume2,
} from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import {
  HALL_SIZE_ORDER,
  HALL_SIZE_PRESETS,
  type Deck,
  type DeckSnapshot,
  type EightDMusicSnapshot,
  type EightDMusicEngine,
  type HallSize,
  type MixerEngine,
} from "../lib/audio/AudioEngine";
import { normalizeTrack, type TrackResult } from "../lib/tracks";
import {
  getEcosystemArtist,
  type EcosystemQueueSnapshot,
} from "../utils/ecosystemQueue";
import TrackArtwork from "./TrackArtwork";
import {
  GENRES,
  isGenreBoosted,
  type GenreId,
  type TasteProfile,
} from "../utils/tasteProfile";

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function SpatialVisualizer({
  deck,
  snapshot,
}: {
  deck: Deck | null;
  snapshot: DeckSnapshot;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const frequencies = deck
      ? new Uint8Array(deck.analyser.frequencyBinCount)
      : new Uint8Array(64);
    const startedAt = performance.now();
    let frame = 0;
    let width = 0;
    let height = 0;
    let scale = 1;

    const draw = (timestamp: number) => {
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width !== width || bounds.height !== height) {
        width = bounds.width;
        height = bounds.height;
        scale = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        context.setTransform(scale, 0, 0, scale, 0, 0);
      }

      context.clearRect(0, 0, width, height);
      if (deck) deck.analyser.getByteFrequencyData(frequencies);

      const centerX = width / 2;
      const centerY = height / 2;
      const radius = Math.min(width, height) * 0.3;
      const elapsed = (timestamp - startedAt) / 1000;
      const phase =
        snapshot.spatial.phase +
        (snapshot.spatial.enabled ? elapsed * Math.PI * 2 * snapshot.spatial.speed : 0);
      const pan = snapshot.spatial.enabled
        ? Math.sin(phase) * snapshot.spatial.depth
        : 0;

      const glow = context.createRadialGradient(
        centerX,
        centerY,
        8,
        centerX,
        centerY,
        radius * 2.2,
      );
      glow.addColorStop(0, "rgba(50, 214, 203, 0.12)");
      glow.addColorStop(1, "rgba(50, 214, 203, 0)");
      context.fillStyle = glow;
      context.fillRect(0, 0, width, height);

      context.beginPath();
      context.arc(centerX, centerY, radius, 0, Math.PI * 2);
      context.strokeStyle = "rgba(164, 190, 202, 0.18)";
      context.lineWidth = 1;
      context.stroke();
      context.beginPath();
      context.arc(centerX, centerY, radius * 1.38, 0, Math.PI * 2);
      context.strokeStyle = "rgba(164, 190, 202, 0.08)";
      context.setLineDash([2, 8]);
      context.stroke();
      context.setLineDash([]);

      const bars = 72;
      for (let index = 0; index < bars; index += 1) {
        const angle = (index / bars) * Math.PI * 2;
        const energy = frequencies[Math.floor((index / bars) * frequencies.length)] / 255;
        const inner = radius * 1.48;
        const outer = inner + 5 + energy * 28;
        context.beginPath();
        context.moveTo(
          centerX + Math.cos(angle) * inner,
          centerY + Math.sin(angle) * inner,
        );
        context.lineTo(
          centerX + Math.cos(angle) * outer,
          centerY + Math.sin(angle) * outer,
        );
        context.strokeStyle = `rgba(50, 214, 203, ${0.18 + energy * 0.7})`;
        context.lineWidth = 2;
        context.stroke();
      }

      const orbitX = centerX + Math.cos(phase - Math.PI / 2) * radius;
      const orbitY = centerY + Math.sin(phase - Math.PI / 2) * radius;
      context.beginPath();
      context.moveTo(centerX, centerY);
      context.lineTo(orbitX, orbitY);
      context.strokeStyle = "rgba(50, 214, 203, 0.35)";
      context.stroke();
      context.beginPath();
      context.arc(orbitX, orbitY, 5 + Math.abs(pan) * 3, 0, Math.PI * 2);
      context.fillStyle = "#32d6cb";
      context.shadowColor = "#32d6cb";
      context.shadowBlur = 18;
      context.fill();
      context.shadowBlur = 0;

      const spectrumBars = 56;
      const spectrumWidth = width / spectrumBars;
      const spectrumBase = height - 8;
      for (let index = 0; index < spectrumBars; index += 1) {
        const frequencyIndex = Math.floor(
          (index / spectrumBars) * frequencies.length * 0.62,
        );
        const energy = frequencies[frequencyIndex] / 255;
        const barHeight = 3 + energy * Math.min(34, height * 0.12);
        const gradient = context.createLinearGradient(
          0,
          spectrumBase - barHeight,
          0,
          spectrumBase,
        );
        gradient.addColorStop(0, "#19dff2");
        gradient.addColorStop(1, "#ba32ff");
        context.fillStyle = gradient;
        context.globalAlpha = 0.35 + energy * 0.65;
        context.fillRect(
          index * spectrumWidth + 1,
          spectrumBase - barHeight,
          Math.max(1, spectrumWidth - 3),
          barHeight,
        );
      }
      context.globalAlpha = 1;

      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [
    deck,
    snapshot.spatial.depth,
    snapshot.spatial.enabled,
    snapshot.spatial.phase,
    snapshot.spatial.speed,
  ]);

  return <canvas className="spatial-visualizer" ref={canvasRef} aria-hidden="true" />;
}

export default function MusicPlayerMode({
  engine,
  snapshot,
  eightDEngine,
  eightDSnapshot,
  tracks,
  searchQuery,
  onSearchQueryChange,
  onSearch,
  searching,
  loadingId,
  ecosystemQueue,
  onPlayTrack,
  onActivatePlayback,
  onSeedTrack,
  onClearSeed,
  onNextTrack,
  onPreviousTrack,
  onPlayQueuedTrack,
  onDeckChange,
  onToggleLibrary,
  tasteProfile,
  genreFilter,
  onGenreFilterChange,
  onUpdateTaste,
  onDownload,
}: {
  engine: MixerEngine | null;
  snapshot: DeckSnapshot;
  eightDEngine: EightDMusicEngine | null;
  eightDSnapshot: EightDMusicSnapshot | null;
  tracks: TrackResult[];
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearch: (event: FormEvent<HTMLFormElement>) => void;
  searching: boolean;
  loadingId: string | null;
  ecosystemQueue: EcosystemQueueSnapshot;
  onPlayTrack: (track: TrackResult) => Promise<void>;
  onActivatePlayback: () => void;
  onSeedTrack: (track: TrackResult) => void;
  onClearSeed: () => void;
  onNextTrack: () => void;
  onPreviousTrack: () => void;
  onPlayQueuedTrack: (track: TrackResult) => Promise<void>;
  onDeckChange: () => void;
  onToggleLibrary: () => void;
  tasteProfile: TasteProfile | null;
  genreFilter: GenreId | null;
  onGenreFilterChange: (genre: GenreId | null) => void;
  onUpdateTaste: () => void;
  onDownload: (track: TrackResult) => void;
}) {
  const [scrubPosition, setScrubPosition] = useState<number | null>(null);
  const [localAudioLoading, setLocalAudioLoading] = useState(false);
  const [localAudioError, setLocalAudioError] = useState("");
  const localAudioInputRef = useRef<HTMLInputElement>(null);
  const activeSnapshot = eightDSnapshot ?? snapshot;
  const trebleMuted = eightDSnapshot?.trebleMuted ?? false;
  const currentBpm = eightDSnapshot?.bpm ?? 120;
  const beatSynced = eightDSnapshot?.spatial.beatSynced ?? false;
  const deck = engine?.deckA ?? null;
  const searchResult =
    tracks.find((track) => track.id === snapshot.trackId) ??
    tracks.find((track) => track.title === snapshot.title);
  const currentTrack =
    searchResult ??
    (snapshot.trackId
      ? normalizeTrack({
          id: snapshot.trackId,
          title: snapshot.title,
          duration: snapshot.duration,
          thumbnail: snapshot.thumbnail,
          channelTitle: snapshot.channelTitle ?? "YouTube",
        })
      : undefined);
  const position = scrubPosition ?? snapshot.position;

  const playTrack = (track: TrackResult) => {
    void onPlayTrack(track);
  };

  const togglePlayback = async () => {
    if (!eightDEngine) return;
    onActivatePlayback();
    await eightDEngine.resume();
    eightDEngine.togglePlayback();
    onDeckChange();
  };

  const setSpatialControl = (
    update: "speed" | "depth",
    value: number,
  ) => {
    if (!eightDEngine) return;
    if (update === "speed") eightDEngine.setSpatialSpeed(value);
    else eightDEngine.setSpatialDepth(value);
    onDeckChange();
  };

  const setHallSize = (size: HallSize) => {
    if (!eightDEngine) return;
    eightDEngine.setHallSize(size);
    onDeckChange();
  };

  const commitSeek = () => {
    if (scrubPosition === null || !eightDEngine) return;
    eightDEngine.seek(scrubPosition);
    setScrubPosition(null);
    onDeckChange();
  };

  return (
    <section className="music-mode concert-mode">
      <div className="music-content">
        <div className="music-main">
          <div className="music-stage">
            {!currentTrack?.thumbnail && (
              <SpatialVisualizer deck={deck} snapshot={snapshot} />
            )}
            {currentTrack && snapshot.thumbnail && (
              <TrackArtwork
                className="stage-artwork"
                track={currentTrack}
                alt={`${snapshot.title} artwork`}
                loading="eager"
              />
            )}
            <div className="visual-center">
              <span className="visual-ring"><Headphones size={38} strokeWidth={1.2} /></span>
              <span className="visual-mode">{snapshot.spatial.enabled ? "SPATIAL FIELD ACTIVE" : "READY TO ORBIT"}</span>
            </div>
            <div className="stage-caption">
              <span className="eyebrow">
                {snapshot.spatial.enabled ? "NOW PLAYING IN 8D" : "NOW PLAYING · STEREO"}
              </span>
              <h1>{snapshot.title}</h1>
              <span>{snapshot.channelTitle ?? "ALHAN SPATIAL PLAYER"}</span>
            </div>
            <div className="stage-position">
              <span>LEFT</span>
              <div><i style={{ left: `${((snapshot.spatial.pan + 1) / 2) * 100}%` }} /></div>
              <span>RIGHT</span>
            </div>
          </div>

          <div className="spatial-control-strip">
            <div className="spatial-control-title">
              <Radio size={18} />
              <div><b>LARGE HALL 8D ENGINE</b><small>INDEPENDENT TONE + SPATIAL</small></div>
            </div>
            <label className="music-fx-switch">
              <span>HALL 8D</span>
              <button
                type="button"
                role="switch"
                aria-checked={snapshot.spatial.enabled}
                aria-label="Toggle Hall 8D HRTF and reverb"
                className={snapshot.spatial.enabled ? "enabled" : ""}
                onClick={() => {
                  if (!eightDEngine) return;
                  eightDEngine.setSpatialEnabled(!snapshot.spatial.enabled);
                  onDeckChange();
                }}
              >
                <i />
              </button>
            </label>
            <div className="music-tone-controls" role="group" aria-label="Tone effects">
              <button
                className={`bass-boost-button ${snapshot.bassBoost ? "active" : ""}`}
                type="button"
                aria-pressed={snapshot.bassBoost}
                onClick={() => {
                  if (!eightDEngine) return;
                  eightDEngine.setBassBoost(!snapshot.bassBoost);
                  onDeckChange();
                }}
              >
                <AudioLines size={16} />
                <span>BASS</span>
                <small>{snapshot.bassBoost ? "ON" : "OFF"}</small>
              </button>
              <button
                className={`bass-boost-button treble-cut-button ${trebleMuted ? "active" : ""}`}
                type="button"
                aria-pressed={trebleMuted}
                aria-label="Toggle tweeter treble cut"
                onClick={() => {
                  if (!eightDEngine) return;
                  eightDEngine.setTrebleMuted(!trebleMuted);
                  onDeckChange();
                }}
              >
                <AudioLines size={16} />
                <span>TWEETER</span>
                <small>{trebleMuted ? "OFF" : "ON"}</small>
              </button>
            </div>
            <label className="music-range">
              <span>ORBIT SPEED <b>{snapshot.spatial.speed.toFixed(2)} Hz</b></span>
              <small className="orbit-sync-status">
                {currentBpm} BPM · {beatSynced ? "BEAT SYNC" : "MANUAL"}
              </small>
              <input
                aria-label="Orbit speed"
                type="range"
                min={0.04}
                max={1}
                step={0.01}
                value={snapshot.spatial.speed}
                onChange={(event) =>
                  setSpatialControl("speed", Number(event.target.value))
                }
              />
            </label>
            <label className="music-range">
              <span>SIDE-TO-SIDE WIDTH <b>{Math.round(snapshot.spatial.depth * 100)}%</b></span>
              <input
                aria-label="Spatial width"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={snapshot.spatial.depth}
                onChange={(event) =>
                  setSpatialControl("depth", Number(event.target.value))
                }
              />
            </label>
            <div className="hall-preset-group" role="group" aria-label="Hall size">
              <span>HALL SIZE <b>{HALL_SIZE_PRESETS[snapshot.spatial.hallSize].label}</b></span>
              <div>
                {HALL_SIZE_ORDER.map((size) => (
                  <button
                    key={size}
                    type="button"
                    className={snapshot.spatial.hallSize === size ? "active" : ""}
                    aria-pressed={snapshot.spatial.hallSize === size}
                    onClick={() => setHallSize(size)}
                  >
                    {HALL_SIZE_PRESETS[size].label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <p className="spatial-headphone-note">
            <Headphones size={12} /> Put on headphones for full 360° 8D audio
          </p>

          <div className="music-transport">
            <div className="transport-time">
              <span>{formatTime(position)}</span>
              <span>{formatTime(snapshot.duration)}</span>
            </div>
            <input
              className="music-progress"
              type="range"
              min={0}
              max={Math.max(snapshot.duration, 0.01)}
              step={0.01}
              value={Math.min(position, snapshot.duration || 0)}
              aria-label="Track progress"
              style={{
                background: `linear-gradient(90deg,#32d6cb 0%,#32d6cb ${
                  snapshot.duration > 0 ? (position / snapshot.duration) * 100 : 0
                }%,#3b454d ${
                  snapshot.duration > 0 ? (position / snapshot.duration) * 100 : 0
                }%)`,
              }}
              onChange={(event) => setScrubPosition(Number(event.target.value))}
              onPointerUp={commitSeek}
              onKeyUp={commitSeek}
              onBlur={commitSeek}
            />
            <div className="music-transport-buttons">
              <button type="button" aria-label="Previous track" onClick={onPreviousTrack}><SkipBack size={19} /></button>
              <button className="music-play-button" type="button" aria-label={snapshot.isPlaying ? "Pause" : "Play"} onClick={() => void togglePlayback()}>
                {snapshot.isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
              </button>
              <button type="button" aria-label="Next track" onClick={onNextTrack}><SkipForward size={19} /></button>
              <span className={`music-now-state ${snapshot.isPlaying ? "active" : ""}`}><Volume2 size={14} />{snapshot.isPlaying ? "PLAYING" : "PAUSED"}</span>
            </div>
          </div>
        </div>

        <aside className="music-queue">
          <form className="music-search music-search-compact" onSubmit={onSearch}>
            <Search size={17} />
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.target.value)}
              placeholder="Search songs..."
              aria-label="Search music"
            />
            <button type="submit" disabled={searching} aria-label="Search tracks">
              {searching ? <LoaderCircle className="spinner" size={16} /> : <Search size={16} />}
            </button>
          </form>
          <div className="queue-heading">
            <div><span className="eyebrow">ECOSYSTEM MIX</span><h2>PLAYLIST · UP NEXT <small>{ecosystemQueue.upNextQueue.length}</small></h2></div>
            <span className="queue-live"><i /> AUTO-PLAY · 8D MUSIC</span>
            <button
              type="button"
              className="browser-toggle music-library-toggle"
              onClick={onToggleLibrary}
              aria-label="Open music library"
            >
              <FolderOpen size={14} /> LIBRARY
            </button>
          </div>
          <input
            ref={localAudioInputRef}
            hidden
            type="file"
            accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg"
            aria-label="Choose an audio file from your device"
            onChange={async (event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (!file || !eightDEngine) return;

              setLocalAudioError("");
              setLocalAudioLoading(true);
              onActivatePlayback();
              try {
                await eightDEngine.resume();
                await eightDEngine.loadFile(file);
                eightDEngine.play();
                onDeckChange();
              } catch {
                setLocalAudioError(
                  "That audio file couldn't be opened. Try another file from your device.",
                );
              } finally {
                setLocalAudioLoading(false);
              }
            }}
          />
          <div className="local-audio-import">
            <div>
              <b>PLAY FROM YOUR DEVICE</b>
              <small>Choose an audio file. It stays on your device.</small>
            </div>
            <button
              type="button"
              onClick={() => localAudioInputRef.current?.click()}
              disabled={!eightDEngine || localAudioLoading}
            >
              {localAudioLoading ? (
                <LoaderCircle className="spinner" size={14} />
              ) : (
                <FolderOpen size={14} />
              )}
              {localAudioLoading ? "LOADING" : "OPEN SONG"}
            </button>
          </div>
          {localAudioError && (
            <p className="local-audio-error" role="alert">
              {localAudioError}
            </p>
          )}
          {tasteProfile && (
            <div className="taste-genre-filters" aria-label="Taste genre filters">
              <button
                type="button"
                className={genreFilter === null ? "selected" : ""}
                aria-pressed={genreFilter === null}
                onClick={() => onGenreFilterChange(null)}
              >
                FOR YOU
              </button>
              {tasteProfile.selectedGenres.map((genreId) => {
                const genre = GENRES.find((item) => item.id === genreId);
                if (!genre) return null;
                const boosted = isGenreBoosted(tasteProfile, genreId);
                return (
                  <button
                    type="button"
                    key={genreId}
                    className={genreFilter === genreId ? "selected" : ""}
                    aria-pressed={genreFilter === genreId}
                    onClick={() =>
                      onGenreFilterChange(
                        genreFilter === genreId ? null : genreId,
                      )
                    }
                  >
                    {genre.label}
                    {boosted && <small title="Boosted by repeat searches">BOOSTED</small>}
                  </button>
                );
              })}
              <button
                type="button"
                className="taste-update"
                onClick={onUpdateTaste}
                aria-label="Update selected genres"
              >
                EDIT
              </button>
            </div>
          )}
          <div className="ecosystem-seed">
            <div>
              <span className="eyebrow">ACTIVE ECOSYSTEM</span>
              <b>
                {ecosystemQueue.seed
                  ? `${(getEcosystemArtist(ecosystemQueue.seed) || ecosystemQueue.seed.channelTitle).toUpperCase()} · ${ecosystemQueue.seed.title.toUpperCase()}`
                  : "NO SEED SELECTED"}
              </b>
            </div>
            {ecosystemQueue.seed && (
              <button type="button" onClick={onClearSeed} aria-label="Clear ecosystem seed">CLEAR</button>
            )}
          </div>
          <div className="queue-list">
            {ecosystemQueue.upNextQueue.map((track) => (
              <article className={`queue-track ${track.id === snapshot.trackId ? "current" : ""}`} key={track.id}>
                <TrackArtwork className="queue-artwork" track={track} />
                <div className="queue-track-meta">
                  <b title={track.title}>{track.title}</b>
                  <small>{track.channelTitle} · {track.duration ? formatTime(track.duration) : "YouTube"}</small>
                  <div className="queue-track-actions">
                    <button
                      type="button"
                      disabled={loadingId === track.id}
                      onClick={() => void onPlayQueuedTrack(track)}
                    >
                      {loadingId === track.id ? <LoaderCircle className="spinner" size={13} /> : <><Play size={12} fill="currentColor" /> PLAY IN 8D</>}
                    </button>
                    <button
                      type="button"
                      onClick={() => onDownload(track)}
                      aria-label={`Download MP3: ${track.title}`}
                    >
                      <Download size={12} /> DOWNLOAD MP3
                    </button>
                  </div>
                </div>
              </article>
            ))}
            {ecosystemQueue.upNextQueue.length === 0 && (
              <p className="queue-empty">
                {ecosystemQueue.seed
                  ? "Finding more tracks from this artist's ecosystem…"
                  : "Play or seed a search result to build an ecosystem queue."}
              </p>
            )}
          </div>
          <div className="music-search-results">
            <div className="search-results-heading">
              <span>SEARCH RESULTS</span><b>{tracks.length}</b>
            </div>
            <div className="search-results-list">
              {tracks.map((track) => (
                <article className="search-result-track" key={track.id}>
                  <TrackArtwork className="search-result-artwork" track={track} />
                  <div className="search-result-meta">
                    <b title={track.title}>{track.title}</b>
                    <small>{track.channelTitle} · {track.duration ? formatTime(track.duration) : "YouTube"}</small>
                  </div>
                  <div className="search-result-actions">
                    <button
                      type="button"
                      disabled={loadingId === track.id}
                      onClick={() => playTrack(track)}
                    >
                      {loadingId === track.id ? <LoaderCircle className="spinner" size={12} /> : <><Play size={11} fill="currentColor" /> PLAY</>}
                    </button>
                    <button type="button" onClick={() => onSeedTrack(track)}>SEED</button>
                    <button
                      type="button"
                      onClick={() => onDownload(track)}
                      aria-label={`Download MP3: ${track.title}`}
                    >
                      <Download size={12} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <button className="queue-library-link" type="button" onClick={onToggleLibrary}>
              OPEN LIBRARY DRAWER
            </button>
          </div>
        </aside>
      </div>
    </section>
  );
}
