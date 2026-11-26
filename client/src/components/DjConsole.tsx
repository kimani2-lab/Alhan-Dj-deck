"use client";

import {
  Activity,
  AudioLines,
  Bot,
  Check,
  ChevronRight,
  Crown,
  Disc3,
  Download,
  FolderOpen,
  Gamepad2,
  Headphones,
  House,
  Info,
  ListChecks,
  ListPlus,
  LoaderCircle,
  Menu,
  Music2,
  Pause,
  Play,
  Plus,
  Radio,
  Search,
  Settings,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Volume2,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type DragEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BeatPadEngine,
  Deck,
  EightDMusicEngine,
  type EightDMusicSnapshot,
  HALL_SIZE_ORDER,
  HALL_SIZE_PRESETS,
  type DeckId,
  type DeckSnapshot,
  MixerEngine,
} from "../lib/audio/AudioEngine";
import { getEcosystemArtist, EcosystemQueueManager } from "../utils/ecosystemQueue";
import { normalizeTrack } from "../lib/tracks";
import type { AiSetQueueItem, DeckFx } from "../lib/aiDj";
import AiDjPanel from "./AiDjPanel";
import AboutPanel from "./AboutPanel";
import BeatPad from "./BeatPad";
import GenreIcon, { genreAccent } from "./GenreIcon";
import MusicPlayerMode from "./MusicPlayerMode";
import SettingsPanel from "./SettingsPanel";
import TrackArtwork from "./TrackArtwork";
import GenreOnboarding from "./GenreOnboarding";
import type { TrackResult } from "../lib/tracks";
import {
  GENRES,
  genreLabel,
  genreQuery,
  getTrendingGenreIds,
  MINIMUM_SELECTED_GENRES,
  scoreTrackTaste,
  inferTrackGenres,
  type GenreId,
  type TasteProfile,
} from "../utils/tasteProfile";
import { useTasteProfile } from "../hooks/useTasteProfile";
import { apiUrl, fetchApi, readApiJson } from "../lib/api";
import PwaInstallButton from "./PwaInstallButton";

const TASTE_PROMPTED_KEY = "alhan-dj:taste-prompted:v1";
const BOT_ACTIVATED_KEY = "alhanBotActivated";

type LocalTrack = { file: File; id: string };
type DragState = { id: DeckId; x: number; tempo: number; position: number };
type AppMode = "home" | "dj" | "music" | "settings" | "about";


const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds)) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
};

function Waveform({
  deck,
  color,
  snapshot,
}: {
  deck: Deck | null;
  color: string;
  snapshot: DeckSnapshot;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const buffer = deck?.audioBuffer;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(width * scale));
      canvas.height = Math.max(1, Math.floor(height * scale));
      context.scale(scale, scale);
      context.clearRect(0, 0, width, height);
      if (!buffer) {
        context.strokeStyle = "rgba(151, 164, 180, .17)";
        context.beginPath();
        context.moveTo(0, height / 2);
        context.lineTo(width, height / 2);
        context.stroke();
        return;
      }

      const channel = buffer.getChannelData(0);
      const bars = Math.max(1, Math.floor(width / 2));
      const samplesPerBar = Math.max(1, Math.floor(channel.length / bars));
      for (let i = 0; i < bars; i += 1) {
        const start = i * samplesPerBar;
        let peak = 0;
        for (let j = 0; j < samplesPerBar && start + j < channel.length; j += 1) {
          peak = Math.max(peak, Math.abs(channel[start + j]));
        }
        const barHeight = Math.max(2, peak * (height * 0.9));
        context.fillStyle =
          buffer.duration > 0 && (i / bars) * buffer.duration < snapshot.position
            ? color
            : `${color}66`;
        context.fillRect(i * (width / bars), (height - barHeight) / 2, 1, barHeight);
      }

      const playheadX =
        snapshot.duration > 0
          ? (snapshot.position / snapshot.duration) * width
          : 0;
      if (snapshot.loop.start !== null || snapshot.loop.end !== null) {
        context.strokeStyle = color;
        context.lineWidth = 1;
        for (const point of [snapshot.loop.start, snapshot.loop.end]) {
          if (point === null) continue;
          const x = (point / snapshot.duration) * width;
          context.beginPath();
          context.moveTo(x, 0);
          context.lineTo(x, height);
          context.stroke();
        }
      }
      context.fillStyle = "#f4f6fb";
      context.fillRect(playheadX, 0, 1, height);
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [
    deck,
    snapshot.duration,
    snapshot.position,
    snapshot.loop.start,
    snapshot.loop.end,
    color,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className="waveform"
      aria-label={`${snapshot.title} waveform`}
    />
  );
}

function SpectrumMeter({ engine }: { engine: MixerEngine | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !engine) return;
    const deckA = new Uint8Array(engine.deckA.analyser.frequencyBinCount);
    const deckB = new Uint8Array(engine.deckB.analyser.frequencyBinCount);
    let frame = 0;

    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(bounds.width * scale));
      const height = Math.max(1, Math.round(bounds.height * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, bounds.width, bounds.height);
      engine.deckA.analyser.getByteFrequencyData(deckA);
      engine.deckB.analyser.getByteFrequencyData(deckB);

      const bars = 18;
      const gap = 3;
      const barWidth = (bounds.width - gap * (bars - 1)) / bars;
      for (let index = 0; index < bars; index += 1) {
        const frequencyIndex = Math.floor((index / bars) * deckA.length * 0.58);
        const energy = Math.max(deckA[frequencyIndex], deckB[frequencyIndex]) / 255;
        const barHeight = Math.max(3, energy * bounds.height);
        const gradient = context.createLinearGradient(0, bounds.height, 0, 0);
        gradient.addColorStop(0, "#19dff2");
        gradient.addColorStop(1, "#bd35ff");
        context.globalAlpha = 0.45 + energy * 0.55;
        context.fillStyle = gradient;
        context.fillRect(
          index * (barWidth + gap),
          bounds.height - barHeight,
          barWidth,
          barHeight,
        );
      }
      context.globalAlpha = 1;
      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [engine]);

  return <canvas ref={canvasRef} className="mixer-spectrum-canvas" aria-hidden="true" />;
}

function StageLighting({ engine }: { engine: MixerEngine | null }) {
  const lightsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const lights = lightsRef.current;
    if (!lights || !engine) return;

    const deckA = new Uint8Array(engine.deckA.analyser.frequencyBinCount);
    const deckB = new Uint8Array(engine.deckB.analyser.frequencyBinCount);
    const binWidth = engine.context.sampleRate / engine.deckA.analyser.fftSize;
    const average = (values: Uint8Array, fromHz: number, toHz: number) => {
      const start = Math.max(0, Math.floor(fromHz / binWidth));
      const end = Math.min(values.length, Math.ceil(toHz / binWidth));
      if (end <= start) return 0;
      let total = 0;
      for (let index = start; index < end; index += 1) total += values[index] ?? 0;
      return total / (end - start) / 255;
    };

    let frame = 0;
    const animate = () => {
      engine.deckA.analyser.getByteFrequencyData(deckA);
      engine.deckB.analyser.getByteFrequencyData(deckB);
      const crossfade = engine.getCrossfader();
      const angle = ((crossfade + 1) * Math.PI) / 4;
      const gainA = Math.cos(angle);
      const gainB = Math.sin(angle);
      const totalGain = Math.max(Number.EPSILON, gainA + gainB);
      const weightedEnergy = (fromHz: number, toHz: number) =>
        (average(deckA, fromHz, toHz) * gainA +
          average(deckB, fromHz, toHz) * gainB) /
        totalGain;
      const playing = engine.deckA.isPlaying || engine.deckB.isPlaying;
      const bassEnergy = playing ? weightedEnergy(35, 220) : 0;
      const trebleEnergy = playing ? weightedEnergy(1800, 9000) : 0;

      lights.style.setProperty(
        "--red-light",
        String(playing ? 0.38 + bassEnergy * 0.62 : 0.72),
      );
      lights.style.setProperty(
        "--blue-light",
        String(playing ? 0.38 + trebleEnergy * 0.62 : 0.72),
      );
      frame = requestAnimationFrame(animate);
    };

    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [engine]);

  return <div ref={lightsRef} className="dj-stage-lights" aria-hidden="true" />;
}

function Rotary({
  label,
  value,
  min,
  max,
  accent,
  onChange,
  display,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  accent: string;
  onChange: (value: number) => void;
  display?: string;
}) {
  const angle = -135 + ((value - min) / (max - min)) * 270;
  return (
    <label className="rotary-control">
      <span className="rotary-label">{label}</span>
      <span className="knob" style={{ "--accent": accent } as CSSProperties}>
        <span className="knob-indicator" style={{ transform: `rotate(${angle}deg)` }} />
        <input
          aria-label={label}
          type="range"
          min={min}
          max={max}
          step={0.01}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </span>
      <span className="rotary-value">{display ?? value.toFixed(1)}</span>
    </label>
  );
}

function DeckPanel({
  id,
  engine,
  snapshot,
  accent,
  onChange,
  onDropFile,
}: {
  id: DeckId;
  engine: MixerEngine | null;
  snapshot: DeckSnapshot;
  accent: string;
  onChange: () => void;
  onDropFile: (id: DeckId, file: File) => void;
}) {
  const [range, setRange] = useState(8);
  const [dragging, setDragging] = useState(false);
  const dragState = useRef<DragState | null>(null);
  const deck = engine?.getDeck(id) ?? null;

  const update = (operation: (deck: Deck) => void) => {
    if (!deck) return;
    operation(deck);
    onChange();
  };
  const trackArtwork =
    snapshot.trackId && snapshot.thumbnail
      ? normalizeTrack({
          id: snapshot.trackId,
          title: snapshot.title,
          duration: snapshot.duration,
          thumbnail: snapshot.thumbnail,
          channelTitle: snapshot.channelTitle ?? "YouTube",
        })
      : null;

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (!deck) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragState.current = {
      id,
      x: event.clientX,
      tempo: snapshot.tempo,
      position: snapshot.position,
    };
    setDragging(true);
  };

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const start = dragState.current;
    if (!start || !deck) return;
    const delta = event.clientX - start.x;
    if (snapshot.isPlaying) {
      deck.setTempo(Math.max(-16, Math.min(16, start.tempo + delta * 0.12)));
    } else {
      deck.seek(start.position + delta * 0.025);
    }
    onChange();
  };

  const handlePointerUp = () => {
    const start = dragState.current;
    if (start && snapshot.isPlaying) deck?.setTempo(start.tempo);
    dragState.current = null;
    setDragging(false);
    onChange();
  };

  const acceptDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) onDropFile(id, file);
  };

  return (
    <section
      className={`deck-panel deck-${id.toLowerCase()}`}
      style={{ "--accent": accent } as CSSProperties}
      onDragOver={(event) => event.preventDefault()}
      onDrop={acceptDrop}
      aria-label={`Deck ${id}`}
    >
      <header className="deck-heading">
        <div className="deck-label">
          <span className="deck-letter">{id}</span>
          <div>
            <span className="eyebrow">PLAYER {id}</span>
            <h2>{id === "A" ? "LEFT DECK" : "RIGHT DECK"}</h2>
          </div>
        </div>
        <div className={`deck-status ${snapshot.isPlaying ? "active" : ""}`}>
          <span className="status-dot" />
          {snapshot.isPlaying ? "ON AIR" : "STANDBY"}
        </div>
      </header>

      <div className="track-meta">
        {trackArtwork && (
          <TrackArtwork
            className="deck-track-artwork"
            track={trackArtwork}
            alt={`${snapshot.title} artwork`}
          />
        )}
        <div className="track-title" title={snapshot.title}>{snapshot.title}</div>
        <div className="track-clock">
          <span>{formatTime(snapshot.position)}</span>
          <span className="clock-divider">/</span>
          <span>{formatTime(snapshot.duration)}</span>
        </div>
      </div>
      <div
        className="waveform-wrap"
        onClick={(event) => {
          if (!deck || !snapshot.duration) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          deck.seek(((event.clientX - bounds.left) / bounds.width) * snapshot.duration);
          onChange();
        }}
      >
        <Waveform deck={deck} color={accent} snapshot={snapshot} />
      </div>

      <div className="deck-main-controls">
        <div className="jog-column">
          <div className={`jog-wheel ${snapshot.isPlaying ? "spinning" : ""} ${dragging ? "dragging" : ""}`}>
            <div className="jog-grooves">
              <span className="jog-center">
                <Disc3 size={33} strokeWidth={1.2} />
                <small>{id}</small>
              </span>
            </div>
            <button
              className="jog-hit-area"
              type="button"
              aria-label={`Scratch deck ${id}`}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            />
          </div>
          <div className="transport-row">
            <button
              className="transport-button"
              type="button"
              title={snapshot.isPlaying ? "Pause and return to cue" : "Set cue point"}
              onClick={() =>
                update((item) => {
                  if (item.isPlaying) {
                    item.pause();
                    item.returnToCue();
                  } else {
                    item.setCue();
                  }
                })
              }
            >
              <SkipBack size={15} />
              <span>CUE</span>
            </button>
            <button
              className="play-button"
              type="button"
              title={snapshot.isPlaying ? "Pause" : "Play"}
              onClick={() => {
                if (!engine) return;
                void engine.resume().then(() => {
                  deck?.togglePlayback();
                  onChange();
                });
              }}
            >
              {snapshot.isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
            </button>
          </div>
        </div>

        <div className="deck-controls">
          <div className="eq-strip">
            {(["high", "mid", "low"] as const).map((band) => (
              <Rotary
                key={band}
                label={band.toUpperCase()}
                value={snapshot.eq[band]}
                min={-24}
                max={12}
                accent={accent}
                display={`${snapshot.eq[band] > 0 ? "+" : ""}${Math.round(snapshot.eq[band])}`}
                onChange={(value) => update((item) => item.setEq(band, value))}
              />
            ))}
          </div>
          <div className="effect-row">
            <Rotary
              label="FILTER"
              value={snapshot.filter}
              min={-1}
              max={1}
              accent={accent}
              display={snapshot.filter === 0 ? "OFF" : snapshot.filter < 0 ? "LP" : "HP"}
              onChange={(value) => update((item) => item.setFilter(value))}
            />
            <label className="vertical-fader">
              <span>LEVEL</span>
              <input
                aria-label={`Deck ${id} channel level`}
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={snapshot.volume}
                onChange={(event) => update((item) => item.setVolume(Number(event.target.value)))}
              />
              <span>{Math.round(snapshot.volume * 100)}%</span>
            </label>
          </div>
        </div>
      </div>

      <div className="deck-bottom">
        <div className="tempo-control">
          <div className="tempo-header">
            <span className="eyebrow">PITCH / TEMPO</span>
            <button
              className="range-toggle"
              type="button"
              onClick={() => {
                const nextRange = range === 8 ? 16 : 8;
                setRange(nextRange);
                if (nextRange === 8 && Math.abs(snapshot.tempo) > 8) {
                  update((item) => item.setTempo(Math.sign(snapshot.tempo) * 8));
                }
              }}
              aria-label={`Change pitch range, currently plus or minus ${range} percent`}
            >
              ±{range}%
            </button>
          </div>
          <input
            className="tempo-slider"
            aria-label={`Deck ${id} tempo`}
            type="range"
            min={-range}
            max={range}
            step={0.1}
            value={Math.max(-range, Math.min(range, snapshot.tempo))}
            onChange={(event) => update((item) => item.setTempo(Number(event.target.value)))}
          />
          <div className="tempo-scale"><span>−{range}</span><b>{snapshot.tempo > 0 ? "+" : ""}{snapshot.tempo.toFixed(1)}%</b><span>+{range}</span></div>
        </div>
        <label className="bpm-control">
          <span className="eyebrow">BPM</span>
          <input
            aria-label={`Deck ${id} BPM`}
            type="number"
            min={40}
            max={240}
            value={snapshot.bpm}
            onChange={(event) => update((item) => item.setBpm(Number(event.target.value)))}
          />
        </label>
        <button
          className={`sync-button ${snapshot.tempo !== 0 ? "synced" : ""}`}
          type="button"
          title="Match tempo to the opposite deck"
          onClick={() => {
            engine?.syncDeck(id);
            onChange();
          }}
        >
          SYNC
        </button>
      </div>

      <div className="loop-row">
        <span className="eyebrow">LOOP</span>
        <button type="button" onClick={() => update((item) => item.setLoopIn())}>IN</button>
        <button type="button" onClick={() => update((item) => item.setLoopOut())}>OUT</button>
        <button
          type="button"
          className={snapshot.loop.enabled ? "loop-active" : ""}
          onClick={() => update((item) => item.setLoopEnabled(!snapshot.loop.enabled))}
        >
          {snapshot.loop.enabled ? "LOOP ON" : "LOOP"}
        </button>
        <small>
          {snapshot.loop.start === null ? "--:--" : formatTime(snapshot.loop.start)}
          {" — "}
          {snapshot.loop.end === null ? "--:--" : formatTime(snapshot.loop.end)}
        </small>
      </div>

      <div className="hot-cue-row">
        <span className="eyebrow cue-title">HOT CUE</span>
        {snapshot.hotCues.slice(0, 4).map((cue, index) => (
          <button
            key={index}
            className={`cue-pad ${cue !== null ? "loaded" : ""}`}
            type="button"
            title={cue === null ? `Set hot cue ${index + 1}` : `Jump to hot cue ${index + 1}`}
            onClick={() =>
              update((item) =>
                cue === null ? item.setHotCue(index) : item.triggerHotCue(index),
              )
            }
          >
            <span>{index + 1}</span>
            <small>{cue === null ? "SET" : formatTime(cue)}</small>
          </button>
        ))}
      </div>

      <div className={`spatial-row ${snapshot.spatial.enabled ? "spatial-on" : ""}`}>
        <div className="spatial-title">
          <Radio size={16} />
          <div>
            <b>HALL 8D</b>
            <small>{snapshot.spatial.enabled ? "HRTF + HALL ACTIVE" : "SPATIAL FX BYPASS"}</small>
          </div>
        </div>
        <button
          className={`fx-switch ${snapshot.spatial.enabled ? "enabled" : ""}`}
          type="button"
          role="switch"
          aria-checked={snapshot.spatial.enabled}
          aria-label={`Toggle deck ${id} Hall 8D spatial effect`}
          onClick={() => update((item) => item.setSpatialEnabled(!snapshot.spatial.enabled))}
        >
          <span />
        </button>
        <Rotary
          label="SPEED"
          value={snapshot.spatial.speed}
          min={0.04}
          max={1}
          accent={accent}
          display={`${snapshot.spatial.speed.toFixed(2)} Hz`}
          onChange={(value) => update((item) => item.setSpatialSpeedManual(value))}
        />
        <Rotary
          label="WIDTH"
          value={snapshot.spatial.depth}
          min={0}
          max={1}
          accent={accent}
          display={`${Math.round(snapshot.spatial.depth * 100)}%`}
          onChange={(value) => update((item) => item.setSpatialDepth(value))}
        />
        <Rotary
          label="HALL SIZE"
          value={Math.max(0, HALL_SIZE_ORDER.indexOf(snapshot.spatial.hallSize))}
          min={0}
          max={HALL_SIZE_ORDER.length - 1}
          accent={accent}
          display={HALL_SIZE_PRESETS[snapshot.spatial.hallSize].shortLabel}
          onChange={(value) =>
            update((item) =>
              item.setHallSize(
                HALL_SIZE_ORDER[Math.round(value)] ?? "hall",
              ),
            )
          }
        />
      </div>
      <div className="deck-spatial-note">
        <Headphones size={11} /> Use headphones for binaural HRTF + hall spatialization.
      </div>
    </section>
  );
}

export default function DjConsole() {
  const engineRef = useRef<MixerEngine | null>(null);
  const [engine, setEngine] = useState<MixerEngine | null>(null);
  const [eightDEngine, setEightDEngine] = useState<EightDMusicEngine | null>(null);
  const eightDEngineRef = useRef<EightDMusicEngine | null>(null);
  const [eightDSnapshot, setEightDSnapshot] = useState<EightDMusicSnapshot | null>(null);
  const [beatPadEngine, setBeatPadEngine] = useState<BeatPadEngine | null>(null);
  const [snapshots, setSnapshots] = useState<Record<DeckId, DeckSnapshot>>(() => {
    const createPreviewSnapshot = (id: DeckId): DeckSnapshot => ({
      id,
      title: "No track loaded",
      trackId: null,
      channelTitle: null,
      thumbnail: null,
      duration: 0,
      position: 0,
      isPlaying: false,
      tempo: 0,
      bpm: 120,
      volume: 0.82,
      eq: { low: 0, mid: 0, high: 0 },
      filter: 0,
      bassBoost: false,
      spatial: {
        enabled: true,
        speed: 0.12,
        depth: 0.75,
        room: 0.44,
        hallSize: "hall",
        phase: 0,
        pan: 0,
      },
      loop: { enabled: false, start: null, end: null },
      hotCues: Array(8).fill(null),
    });
    return { A: createPreviewSnapshot("A"), B: createPreviewSnapshot("B") };
  });
  const [queueManager] = useState(() => new EcosystemQueueManager());
  const [ecosystemQueue, setEcosystemQueue] = useState(() =>
    queueManager.getSnapshot(),
  );
  const [crossfader, setCrossfader] = useState(0);
  const [masterVolume, setMasterVolume] = useState(0.82);
  const [mode, setMode] = useState<AppMode>("home");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [beatPadOpen, setBeatPadOpen] = useState(false);
  const taste = useTasteProfile();
  const tasteProfile =
    taste.profile.selectedGenres.length >= MINIMUM_SELECTED_GENRES
      ? taste.profile
      : null;
  const tasteProfileRef = useRef(tasteProfile);
  const recordTasteSearch = taste.recordSearch;
  const recordTastePlay = taste.recordPlayed;
  const [genreOnboardingOpen, setGenreOnboardingOpen] = useState(false);
  const [genreFilter, setGenreFilter] = useState<GenreId | null>(null);
  const [selectingGenres, setSelectingGenres] = useState(false);
  const [genreShelf, setGenreShelf] = useState<GenreId | null>(null);
  const [genreShelfTracks, setGenreShelfTracks] = useState<TrackResult[]>([]);
  const [genreShelfLoading, setGenreShelfLoading] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [localTracks, setLocalTracks] = useState<LocalTrack[]>([]);
  const [youtubeQuery, setYoutubeQuery] = useState("");
  const [youtubeTracks, setYoutubeTracks] = useState<TrackResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [trendingTracks, setTrendingTracks] = useState<TrackResult[]>([]);
  const [trendingLoading, setTrendingLoading] = useState(false);
  const [homeSearchTracks, setHomeSearchTracks] = useState<TrackResult[]>([]);
  const [homeSearchLoading, setHomeSearchLoading] = useState(false);
  const [homeSearchText, setHomeSearchText] = useState("");
  const [genrePreviewTracks, setGenrePreviewTracks] = useState<
    Partial<Record<GenreId, TrackResult>>
  >({});
  const [error, setError] = useState("");
  const [backendStatus, setBackendStatus] = useState<"checking" | "warming" | "ready" | "offline">("checking");
  const [aiOpen, setAiOpen] = useState(false);
  const [botActivated, setBotActivated] = useState(false);
  const [aiQueue, setAiQueue] = useState<AiSetQueueItem[]>([]);
  const [aiQueueIndex, setAiQueueIndex] = useState(-1);
  const aiSetRef = useRef<{
    items: AiSetQueueItem[];
    index: number;
    active: boolean;
  }>({ items: [], index: -1, active: false });
  const explicitEcosystemSeedRef = useRef<string | null>(null);
  const autoPlayClearedTrackRef = useRef<{ trackId: string | null } | null>(null);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileNavOpen]);

  useEffect(() => {
    let cancelled = false;
    let warmingTimer = 0;
    const checkBackend = async () => {
      setBackendStatus("checking");
      warmingTimer = window.setTimeout(() => {
        if (!cancelled) setBackendStatus("warming");
      }, 1200);
      try {
        const response = await fetchApi("/api/health", { cache: "no-store" });
        if (!response.ok) throw new Error("Backend unavailable");
        if (!cancelled) setBackendStatus("ready");
      } catch {
        if (!cancelled) setBackendStatus("offline");
      } finally {
        window.clearTimeout(warmingTimer);
      }
    };
    void checkBackend();
    return () => {
      cancelled = true;
      window.clearTimeout(warmingTimer);
    };
  }, []);

  useEffect(() => {
    const mixer = new MixerEngine();
    const pads = new BeatPadEngine(mixer.context, mixer.padBus);
    const eightD = new EightDMusicEngine(
      mixer.context,
      mixer.masterInput,
    );
    eightDEngineRef.current = eightD;
    engineRef.current = mixer;
    let isReady = false;
    const update = () => {
      if (!isReady) {
        isReady = true;
        setEngine(mixer);
        setBeatPadEngine(pads);
        setEightDEngine(eightD);
      }
      setSnapshots({
        A: mixer.deckA.getSnapshot(),
        B: mixer.deckB.getSnapshot(),
      });
      setCrossfader(mixer.getCrossfader());
      setMasterVolume(mixer.getMasterVolume());
      setEightDSnapshot(eightD.getSnapshot());
    };
    const interval = window.setInterval(update, 100);
    return () => {
      window.clearInterval(interval);
      eightD.dispose();
      pads.dispose();
      mixer.dispose();
      engineRef.current = null;
    };
  }, []);

  const refresh = useCallback(() => {
    const mixer = engineRef.current;
    if (!mixer) return;
    setSnapshots({
      A: mixer.deckA.getSnapshot(),
      B: mixer.deckB.getSnapshot(),
    });
    const eightD = eightDEngineRef.current;
    if (eightD) setEightDSnapshot(eightD.getSnapshot());
  }, []);

  const refreshEcosystemQueue = useCallback(() => {
    setEcosystemQueue(queueManager.getSnapshot());
  }, [queueManager]);

  const updateTasteProfile = useCallback(
    (profile: TasteProfile) => {
      taste.updateProfile(profile);
      setGenreOnboardingOpen(false);
    },
    [taste],
  );

  useEffect(() => {
    tasteProfileRef.current = tasteProfile;
    queueManager.setTasteProfile(tasteProfile);
  }, [queueManager, tasteProfile]);

  useEffect(() => {
    if (!taste.isLoaded || taste.hasCompletedTaste) return;
    let alreadyPrompted = false;
    try {
      alreadyPrompted =
        window.localStorage.getItem(TASTE_PROMPTED_KEY) === "1";
    } catch {
      alreadyPrompted = false;
    }
    if (alreadyPrompted) return;
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(TASTE_PROMPTED_KEY, "1");
      } catch {
        // storage may be unavailable; still show the prompt for this session
      }
      setGenreOnboardingOpen(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [taste.hasCompletedTaste, taste.isLoaded]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        setBotActivated(
          window.localStorage.getItem(BOT_ACTIVATED_KEY) === "true",
        );
      } catch {
        setBotActivated(false);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const activateBot = useCallback(() => {
    try {
      window.localStorage.setItem(BOT_ACTIVATED_KEY, "true");
    } catch {
      // activation still applies for this session when storage is unavailable
    }
    setBotActivated(true);
  }, []);

  const deactivateBot = useCallback(() => {
    try {
      window.localStorage.removeItem(BOT_ACTIVATED_KEY);
    } catch {
      // ignore unavailable storage
    }
    setBotActivated(false);
    setAiOpen(false);
  }, []);

  const addLocalFiles = (fileList: FileList | null) => {
    if (!fileList) return;
    const files = Array.from(fileList).filter((file) =>
      ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/mp4", "audio/aac", "audio/flac", "audio/ogg"].includes(file.type) ||
      /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(file.name),
    );
    setLocalTracks((current) => [
      ...current,
      ...files.map((file) => ({ file, id: `${file.name}-${file.lastModified}-${Math.random()}` })),
    ]);
  };

  const loadLocalTrack = async (id: DeckId, track: LocalTrack) => {
    const mixer = engineRef.current;
    if (!mixer) return;
    setError("");
    try {
      await mixer.resume();
      await mixer.loadFile(id, track.file);
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not decode the audio file.");
    }
  };

  const loadEightDMusicTrack = useCallback(
    async (track: TrackResult): Promise<boolean> => {
      const eightD = eightDEngineRef.current;
      if (!eightD) return false;
      setLoadingId(track.id);
      setError("");
      try {
        await eightD.loadUrl(
          `/api/stream/${encodeURIComponent(track.id)}`,
          track.title,
          {
            id: track.id,
            channelTitle: track.channelTitle,
            thumbnail: track.thumbnail ?? "",
          },
        );
        recordTastePlay(track);
        eightD.play();
        setEightDSnapshot(eightD.getSnapshot());
        setMode("music");
        return true;
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not start this 8D track.",
        );
        return false;
      } finally {
        setLoadingId(null);
      }
    },
    [recordTastePlay],
  );

  const searchRequestRef = useRef(0);
  const trackSearchCacheRef = useRef(new Map<string, Promise<TrackResult[]>>());

  const fetchTracks = useCallback(
    async (query: string): Promise<TrackResult[]> => {
      const cacheKey = query.trim().toLowerCase();
      const cached = trackSearchCacheRef.current.get(cacheKey);
      if (cached) return cached;

      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 125_000);
      const request = (async () => {
        let response: Response;
        try {
          response = await fetchApi(
            `/api/search?q=${encodeURIComponent(query)}`,
            { signal: controller.signal },
          );
        } catch (reason) {
          if (reason instanceof DOMException && reason.name === "AbortError") {
            throw new Error(
              "YouTube search is taking longer than expected. Check yt-dlp, internet access, or try again.",
            );
          }
          throw reason instanceof Error
            ? reason
            : new Error("Could not reach the YouTube search server.");
        }
        window.clearTimeout(timeout);
        const data = await readApiJson<{
          tracks?: TrackResult[];
          error?: string;
        }>(response, "YouTube search failed");
        if (!response.ok) throw new Error(data.error ?? "YouTube search failed.");
        return (data.tracks ?? []).map((track) => normalizeTrack(track));
      })();

      trackSearchCacheRef.current.set(cacheKey, request);
      void request.catch(() => {
        trackSearchCacheRef.current.delete(cacheKey);
      });
      return request;
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;

    const loadGenrePreviews = async () => {
      for (const genre of GENRES) {
        if (cancelled) break;
        await new Promise((resolve) => window.setTimeout(resolve, 180));
        try {
            const artistSeed =
              genre.aliases.find((alias) =>
                /[a-z]/i.test(alias) &&
                !["hip hop", "afrobeats", "house", "rock", "jazz", "pop", "country", "blues", "gospel", "soul", "latin", "folk", "indie", "metal", "drill", "pop music"].includes(alias.toLowerCase()),
              ) ?? genre.aliases[0];
            const tracks = await fetchTracks(
              `${artistSeed} ${genre.label} official music`,
            );
            if (!cancelled && tracks[0]) {
              setGenrePreviewTracks((current) => ({
                ...current,
                [genre.id]: tracks[0],
              }));
            }
        } catch {
          // Genre cards retain their Lucide icon when a preview search fails.
        }
      }
    };

    void loadGenrePreviews();
    return () => {
      cancelled = true;
    };
  }, [fetchTracks]);

  const searchTracks = useCallback(
    async (query: string): Promise<TrackResult[]> => {
      recordTasteSearch(query);
      return fetchTracks(query);
    },
    [fetchTracks, recordTasteSearch],
  );

  const trendingGenreKey = useMemo(
    () => {
      if (taste.profile.selectedGenres.length < MINIMUM_SELECTED_GENRES) {
        return getTrendingGenreIds(taste.profile, 3).join("|");
      }
      const recentlyPlayedGenres = taste.profile.recentlyPlayed
        .slice(0, 6)
        .flatMap(inferTrackGenres);
      return [...new Set([
        ...taste.profile.selectedGenres,
        ...recentlyPlayedGenres,
      ])].slice(0, 6).join("|");
    },
    [taste.profile],
  );

  useEffect(() => {
    if (homeSearchText.trim()) return;
    const genreIds = trendingGenreKey
      .split("|")
      .filter(Boolean) as GenreId[];
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      setTrendingLoading(true);
      void Promise.allSettled(
        genreIds.map((genre) => fetchTracks(genreQuery(genre))),
      )
        .then((results) => {
          if (cancelled) return;
          const seen = new Set<string>();
          const tracks: TrackResult[] = [];
          let firstError: unknown = null;
          for (const result of results) {
            if (result.status === "fulfilled") {
              for (const track of result.value) {
                if (!seen.has(track.id)) {
                  seen.add(track.id);
                  tracks.push(track);
                }
              }
            } else if (!firstError) {
              firstError = result.reason;
            }
          }
          const activeProfile = tasteProfileRef.current;
          tracks.sort(
            (left, right) =>
              scoreTrackTaste(right, activeProfile) -
                scoreTrackTaste(left, activeProfile) ||
              left.title.localeCompare(right.title),
          );
          if (tracks.length > 0) setTrendingTracks(tracks.slice(0, 12));
          if (tracks.length === 0 && firstError) {
            setError(
              firstError instanceof Error
                ? firstError.message
                : "Could not load trending tracks.",
            );
          }
        })
        .finally(() => {
          if (!cancelled) setTrendingLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fetchTracks, homeSearchText, trendingGenreKey]);

  const runHomeSearch = useCallback(
    (query: string) => {
      const trimmed = query.trim();
      if (!trimmed) {
        setHomeSearchTracks([]);
        return;
      }
      const requestId = searchRequestRef.current + 1;
      searchRequestRef.current = requestId;
      setHomeSearchLoading(true);
      setGenreShelf(null);
      setGenreShelfTracks([]);
      setGenreFilter(null);
      void searchTracks(trimmed)
        .then((tracks) => {
          if (searchRequestRef.current === requestId) {
            setHomeSearchTracks(tracks);
          }
        })
        .catch((reason) => {
          if (searchRequestRef.current === requestId) {
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not search tracks.",
            );
          }
        })
        .finally(() => {
          if (searchRequestRef.current === requestId) {
            setHomeSearchLoading(false);
          }
        });
    },
    [searchTracks],
  );

  useEffect(() => {
    const query = homeSearchText.trim();
    const timer = window.setTimeout(() => {
      if (!query) {
        setHomeSearchTracks([]);
        return;
      }
      runHomeSearch(query);
    }, query ? 500 : 0);
    return () => window.clearTimeout(timer);
  }, [homeSearchText, runHomeSearch]);

  const browseGenre = useCallback(
    async (genre: GenreId) => {
      if (genreShelf === genre) {
        setGenreShelf(null);
        setGenreShelfTracks([]);
        setGenreFilter(null);
        return;
      }
      setGenreFilter(genre);
      setGenreShelf(genre);
      setGenreShelfTracks([]);
      setHomeSearchText("");
      setHomeSearchTracks([]);
      setGenreShelfLoading(true);
      setError("");
      recordTasteSearch(genreLabel(genre));
      try {
        const tracks = await fetchTracks(genreQuery(genre));
        setGenreShelfTracks(tracks.slice(0, 12));
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not load that genre.",
        );
      } finally {
        setGenreShelfLoading(false);
      }
    },
    [fetchTracks, genreShelf, recordTasteSearch],
  );

  const searchYoutube = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!youtubeQuery.trim()) return;
    setSearching(true);
    setError("");
    try {
      setYoutubeTracks(await searchTracks(youtubeQuery.trim()));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not reach the audio server.");
    } finally {
      setSearching(false);
    }
  };

  const loadYoutubeTrack = useCallback(async (id: DeckId, track: TrackResult): Promise<boolean> => {
    const mixer = engineRef.current;
    if (!mixer) return false;
    setLoadingId(track.id);
    setError("");
    try {
      await mixer.resume();
      await mixer.loadUrl(
        id,
        `/api/stream/${encodeURIComponent(track.id)}`,
        track.title,
        {
          id: track.id,
          channelTitle: track.channelTitle,
          thumbnail: track.thumbnail ?? "",
        },
      );
      recordTastePlay(track);
      refresh();
      return true;
    } catch (reason) {
      setError(
        reason instanceof Error
          ? `${reason.message} Verify yt-dlp is installed and available on the server PATH.`
          : "Could not load this YouTube track.",
      );
      return false;
    } finally {
      setLoadingId(null);
    }
  }, [recordTastePlay, refresh]);

  const loadToDeck = useCallback(
    async (id: DeckId, track: TrackResult) => {
      const loaded = await loadYoutubeTrack(id, track);
      if (loaded) setMode("dj");
    },
    [loadYoutubeTrack],
  );

  const loadAiTrack = useCallback(async (
    id: DeckId,
    track: TrackResult,
    fx: DeckFx,
  ): Promise<boolean> => {
    const loaded = await loadYoutubeTrack(id, track);
    if (!loaded) return false;
    const mixer = engineRef.current;
    if (mixer) {
      const deck = mixer.getDeck(id);
      if (typeof fx.enable8d === "boolean") deck.setSpatialEnabled(fx.enable8d);
      if (typeof fx.bassBoost === "boolean") deck.setBassBoost(fx.bassBoost);
    }
    refresh();
    return true;
  }, [loadYoutubeTrack, refresh]);

  const refillAttempts = useRef(0);

  const fetchEcosystemCandidates = useCallback(async (seed: TrackResult) => {
    const seedId = seed.id;
    const artist = getEcosystemArtist(seed);
    const queries = [
      seed.ecosystemQuery,
      artist ? `${artist} official audio` : `${seed.title} similar songs`,
      artist ? `${artist} popular songs` : `${seed.title} related music`,
    ].filter(Boolean);
    let queryIndex = refillAttempts.current;

    while (
      queryIndex < queries.length &&
      queueManager.getSnapshot().seed?.id === seedId &&
      queueManager.shouldRefill()
    ) {
      const query = queries[queryIndex];
      queryIndex += 1;
      refillAttempts.current = queryIndex;
      try {
        const response = await fetchApi(
          `/api/search?q=${encodeURIComponent(query)}`,
        );
        const data = await readApiJson<{
          tracks?: TrackResult[];
          error?: string;
        }>(response, "YouTube search failed");
        if (!response.ok) {
          throw new Error(data.error ?? "Could not load ecosystem recommendations.");
        }
        if (queueManager.getSnapshot().seed?.id !== seedId) return;
        queueManager.addCandidates(
          (data.tracks ?? []).map((track) => normalizeTrack(track)),
        );
        refreshEcosystemQueue();
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not load ecosystem recommendations.",
        );
        return;
      }
    }
  }, [queueManager, refreshEcosystemQueue]);

  const playAiTrackIn8D = useCallback(async (
    track: TrackResult,
    fx: DeckFx,
  ): Promise<boolean> => {
    aiSetRef.current = { items: [], index: -1, active: false };
    setAiQueue([]);
    setAiQueueIndex(-1);
    explicitEcosystemSeedRef.current = null;
    autoPlayClearedTrackRef.current = null;
    queueManager.clear();
    refreshEcosystemQueue();
    setMode("music");
    if (!(await loadAiTrack("A", track, {
      enable8d: fx.enable8d ?? true,
      bassBoost: fx.bassBoost,
    }))) return false;
    const mixer = engineRef.current;
    if (!mixer) return false;
    queueManager.setSeed(track);
    refillAttempts.current = 0;
    await mixer.resume();
    mixer.deckA.play();
    queueManager.markPlaying(track);
    refreshEcosystemQueue();
    void fetchEcosystemCandidates(track);
    refresh();
    return true;
  }, [
    fetchEcosystemCandidates,
    loadAiTrack,
    queueManager,
    refresh,
    refreshEcosystemQueue,
  ]);

  const playAiStep = useCallback(async (item: AiSetQueueItem): Promise<boolean> => {
    const eightD = eightDEngineRef.current;
    if (!eightD) return false;
    eightD.setSpatialEnabled(item.step.enable8d);
    eightD.setBassBoost(item.step.bassBoost);
    if (!(await loadEightDMusicTrack(item.track))) return false;
    explicitEcosystemSeedRef.current = null;
    autoPlayClearedTrackRef.current = null;
    queueManager.setSeed(item.track);
    refillAttempts.current = 0;
    queueManager.markPlaying(item.track);
    refreshEcosystemQueue();
    void fetchEcosystemCandidates(item.track);
    setEightDSnapshot(eightD.getSnapshot());
    return true;
  }, [
    fetchEcosystemCandidates,
    loadEightDMusicTrack,
    queueManager,
    refresh,
    refreshEcosystemQueue,
  ]);

  const runAiSet = useCallback(async (items: AiSetQueueItem[]) => {
    if (items.length === 0) return;
    aiSetRef.current = { items, index: 0, active: true };
    setAiQueue(items);
    setAiQueueIndex(0);
    const started = await playAiStep(items[0]);
    if (started) return;
    aiSetRef.current = { items: [], index: -1, active: false };
    setAiQueue([]);
    setAiQueueIndex(-1);
  }, [playAiStep]);

  const stopAiSet = useCallback(() => {
    aiSetRef.current = { items: [], index: -1, active: false };
    setAiQueue([]);
    setAiQueueIndex(-1);
    engineRef.current?.deckA.pause();
    refresh();
  }, [refresh]);

  const advanceAiSet = useCallback(() => {
    const current = aiSetRef.current;
    if (!current.active) return;
    const nextIndex = current.index + 1;
    if (nextIndex >= current.items.length) {
      aiSetRef.current = { items: [], index: -1, active: false };
      setAiQueue([]);
      setAiQueueIndex(-1);
      return;
    }
    aiSetRef.current = { items: current.items, index: nextIndex, active: true };
    setAiQueueIndex(nextIndex);
    const nextItem = current.items[nextIndex];
    if (!nextItem) return;
    void playAiStep(nextItem).then((started) => {
      if (started) return;
      aiSetRef.current = { items: [], index: -1, active: false };
      setAiQueue([]);
      setAiQueueIndex(-1);
    });
  }, [playAiStep]);

  const playEcosystemTrack = useCallback(async (track: TrackResult) => {
    if (!(await loadEightDMusicTrack(track))) return false;
    const eightD = eightDEngineRef.current;
    if (!eightD) return false;
    queueManager.markPlaying(track);
    refreshEcosystemQueue();
    refresh();
    return true;
  }, [loadEightDMusicTrack, queueManager, refresh, refreshEcosystemQueue]);

  const playTrackIn8D = useCallback(
    async (track: TrackResult) => {
      refillAttempts.current = 0;
      if (!(await playEcosystemTrack(track))) return;
      explicitEcosystemSeedRef.current = null;
      autoPlayClearedTrackRef.current = null;
      queueManager.setSeed(track);
      queueManager.markPlaying(track);
      refreshEcosystemQueue();
      setMode("music");
      void fetchEcosystemCandidates(track);
    },
    [
      fetchEcosystemCandidates,
      playEcosystemTrack,
      queueManager,
      refreshEcosystemQueue,
    ],
  );

  const playHeroMix = useCallback(async () => {
    const shelf = homeSearchText.trim()
      ? homeSearchTracks
      : genreShelf
        ? genreShelfTracks
        : trendingTracks;
    const seed = shelf[0];
    if (seed) {
      void playTrackIn8D(seed);
      return;
    }
    const [genre] = getTrendingGenreIds(taste.profile, 1);
    try {
      const tracks = await fetchTracks(genreQuery(genre ?? "hip-hop"));
      if (tracks[0]) void playTrackIn8D(tracks[0]);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not start your genre mix.",
      );
    }
  }, [
    fetchTracks,
    genreShelf,
    genreShelfTracks,
    homeSearchText,
    homeSearchTracks,
    playTrackIn8D,
    taste.profile,
    trendingTracks,
  ]);

  const seedEcosystem = (track: TrackResult) => {
    explicitEcosystemSeedRef.current = track.id;
    autoPlayClearedTrackRef.current = null;
    queueManager.setSeed(track);
    refillAttempts.current = 0;
    refreshEcosystemQueue();
    void fetchEcosystemCandidates(track);
  };

  const clearEcosystem = () => {
    explicitEcosystemSeedRef.current = null;
    autoPlayClearedTrackRef.current = {
      trackId: engineRef.current?.deckA.getSnapshot().trackId ?? null,
    };
    queueManager.clear();
    refillAttempts.current = 0;
    refreshEcosystemQueue();
  };

  const playNextEcosystemTrack = useCallback(async () => {
    let next = queueManager.peekNext(genreFilter);
    if (!next) {
      const seed = queueManager.getSnapshot().seed;
      if (seed) {
        await fetchEcosystemCandidates(seed);
        next = queueManager.peekNext(genreFilter);
      } else {
        return;
      }
    }
    if (!next) {
      setError("No unplayed tracks are available in this ecosystem yet.");
      return;
    }
    const played = await playEcosystemTrack(next);
    if (!played) return;
    const seed = queueManager.getSnapshot().seed;
    if (seed && queueManager.shouldRefill()) {
      void fetchEcosystemCandidates(seed);
    }
  }, [fetchEcosystemCandidates, genreFilter, playEcosystemTrack, queueManager]);

  const playPreviousEcosystemTrack = useCallback(async () => {
    const previous = queueManager.peekPrevious();
    if (!previous) return;
    await playEcosystemTrack(previous);
  }, [playEcosystemTrack, queueManager]);

  const playQueuedEcosystemTrack = useCallback(async (track: TrackResult) => {
    const played = await playEcosystemTrack(track);
    if (!played) return;
    const seed = queueManager.getSnapshot().seed;
    if (seed && queueManager.shouldRefill()) {
      void fetchEcosystemCandidates(seed);
    }
  }, [fetchEcosystemCandidates, playEcosystemTrack, queueManager]);

  const queueTrack = useCallback(
    (track: TrackResult) => {
      if (queueManager.enqueue(track)) refreshEcosystemQueue();
    },
    [queueManager, refreshEcosystemQueue],
  );

  useEffect(() => {
    if (!engine) return;
    const handleEnded = () => {
      if (aiSetRef.current.active) {
        const isLastSetTrack =
          aiSetRef.current.index === aiSetRef.current.items.length - 1;
        advanceAiSet();
        if (isLastSetTrack) void playNextEcosystemTrack();
        return;
      }
      const endedTrackId = engine.deckA.getSnapshot().trackId;
      if (autoPlayClearedTrackRef.current?.trackId === endedTrackId) return;
      const queueSnapshot = queueManager.getSnapshot();
      const isExplicitSeed =
        queueSnapshot.seed?.id === explicitEcosystemSeedRef.current;
      if (!isExplicitSeed && queueSnapshot.activeId !== endedTrackId) {
        const endedTrack = youtubeTracks.find(
          (track) => track.id === endedTrackId,
        );
        if (!endedTrack) {
          if (queueSnapshot.seed) {
            queueManager.clear();
            refreshEcosystemQueue();
          }
          return;
        }
        queueManager.setSeed(endedTrack);
        queueManager.markPlaying(endedTrack);
        refillAttempts.current = 0;
        refreshEcosystemQueue();
      }
      if (queueManager.getSnapshot().seed) {
        void playNextEcosystemTrack();
      }
    };
    engine.deckA.setOnEnded(handleEnded);
    return () => engine.deckA.setOnEnded(null);
  }, [
    advanceAiSet,
    engine,
    playNextEcosystemTrack,
    queueManager,
    refreshEcosystemQueue,
    youtubeTracks,
  ]);

  const searchActive = homeSearchText.trim().length > 0;
  const shelfTracks = searchActive
    ? homeSearchTracks
    : genreShelf
      ? genreShelfTracks
      : trendingTracks;
  const shelfLoading = searchActive
    ? homeSearchLoading
    : genreShelf
      ? genreShelfLoading
      : trendingLoading;
  const shelfEyebrow = searchActive
    ? "SEARCH"
    : genreShelf
      ? "GENRE SHELF"
      : "DISCOVER";
  const shelfTitle = searchActive
    ? `Results for "${homeSearchText.trim()}"`
    : genreShelf
      ? `${genreLabel(genreShelf)} Mix`
      : "Trending Now";
  const selectedCount = taste.profile.selectedGenres.length;
  const remainingGenres = Math.max(
    0,
    MINIMUM_SELECTED_GENRES - selectedCount,
  );

  return (
    <main className={`app-shell ${mode === "home" ? "home-mode" : ""} ${browserOpen ? "browser-expanded" : ""} ${aiOpen ? "ai-panel-open" : ""}`}>
      <aside
        id="main-navigation-panel"
        className={`nav-rail ${mobileNavOpen ? "mobile-open" : ""}`}
        aria-label="Main navigation"
      >
        <a className="rail-brand" href="#" aria-label="Alhan DJ home">
          <span className="rail-brand-mark"><AudioLines size={25} /></span>
          <span>ALHAN <b>DJ</b></span>
        </a>
        <button
          className="mobile-nav-close"
          type="button"
          aria-label="Close navigation menu"
          onClick={() => setMobileNavOpen(false)}
        >
          <X size={18} />
        </button>
        <nav className="rail-nav">
          <button
            type="button"
            className={`rail-item ${mode === "home" ? "active" : ""}`}
            aria-pressed={mode === "home"}
            onClick={() => {
              setMode("home");
              setMobileNavOpen(false);
            }}
          >
            <House size={17} /> <span>Home</span>
          </button>
          <button
            type="button"
            className={`rail-item ${mode === "music" ? "active" : ""}`}
            aria-pressed={mode === "music"}
            onClick={() => {
              setMode("music");
              setMobileNavOpen(false);
            }}
          >
            <Music2 size={17} /> <span>8D Music</span>
          </button>
          <button
            type="button"
            className={`rail-item ${mode === "dj" ? "active" : ""}`}
            aria-pressed={mode === "dj"}
            onClick={() => {
              setMode("dj");
              setMobileNavOpen(false);
            }}
          >
            <Headphones size={17} /> <span>DJ Mode</span>
          </button>
          <button
            type="button"
            className={`rail-item ${aiOpen ? "active" : ""}`}
            aria-pressed={aiOpen}
            onClick={() => {
              setAiOpen((open) => !open);
              setMobileNavOpen(false);
            }}
          >
            <Bot size={17} /> <span>ALHAN Bot</span>
          </button>
          <button
            type="button"
            className={`rail-item ${mode === "settings" ? "active" : ""}`}
            aria-pressed={mode === "settings"}
            onClick={() => {
              setMode("settings");
              setMobileNavOpen(false);
            }}
          >
            <Settings size={17} /> <span>Settings</span>
          </button>
          <button
            type="button"
            className={`rail-item ${mode === "about" ? "active" : ""}`}
            aria-pressed={mode === "about"}
            onClick={() => {
              setMode("about");
              setMobileNavOpen(false);
            }}
          >
            <Info size={17} /> <span>About</span>
          </button>
        </nav>
        <div className="feel-beat-badge">
          <Crown size={18} />
          <b>Feel the Beat</b>
          <span>Mix · Play · Enjoy</span>
        </div>
      </aside>

      {mobileNavOpen && (
        <button
          className="nav-drawer-backdrop"
          type="button"
          aria-label="Close navigation menu"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <div className="console-shell">
      <header className="topbar">
        <div className="topbar-center">
          <button
            className="mobile-nav-toggle"
            type="button"
            aria-controls="main-navigation-panel"
            aria-expanded={mobileNavOpen}
            aria-label={mobileNavOpen ? "Close navigation menu" : "Open navigation menu"}
            onClick={() => setMobileNavOpen((open) => !open)}
          >
            {mobileNavOpen ? <X size={19} /> : <Menu size={19} />}
          </button>
        </div>
        <div className="topbar-actions">
          <PwaInstallButton />
        </div>
      </header>

      {mode === "home" ? (
        <section className="alhan-home" aria-label="ALHAN DJ home">
          <div className="alhan-home-inner">
            <form
              className="alhan-home-search"
              onSubmit={(event) => {
                event.preventDefault();
                runHomeSearch(homeSearchText);
              }}
            >
              <Search size={15} />
              <input
                value={homeSearchText}
                onChange={(event) => setHomeSearchText(event.target.value)}
                placeholder="Search for songs, artists, or genres..."
                aria-label="Search for songs, artists, or genres"
              />
              {homeSearchText && (
                <button
                  type="button"
                  className="home-search-clear"
                  aria-label="Clear search"
                  onClick={() => {
                    setHomeSearchText("");
                    setHomeSearchTracks([]);
                  }}
                >
                  <X size={13} />
                </button>
              )}
              <span className="home-search-hint" aria-hidden="true">
                {homeSearchLoading ? (
                  <LoaderCircle className="spinner" size={14} />
                ) : (
                  "ENTER"
                )}
              </span>
            </form>

            <div className="alhan-home-hero">
              <div className="alhan-hero-copy">
                <span className="eyebrow">WELCOME TO ALHAN</span>
                <h1>Feel the <span>Beat</span></h1>
                <p>
                  Discover, stream and enjoy the best music across all genres.
                </p>
                <div className="alhan-hero-actions">
                  <button type="button" onClick={() => void playHeroMix()}>
                    <Play size={13} fill="currentColor" /> Play Now
                  </button>
                  <button
                    type="button"
                    onClick={() => setGenreOnboardingOpen(true)}
                  >
                    Explore Genres <ChevronRight size={13} />
                  </button>
                </div>
              </div>
            </div>

            <section className="alhan-home-section" aria-label="Music genres">
              <div className="alhan-section-heading">
                <div>
                  <span className="eyebrow">BROWSE</span>
                  <h2>Music Genres</h2>
                </div>
                <div className="alhan-section-heading-actions">
                  <button
                    type="button"
                    className={`alhan-select-genres-toggle ${selectingGenres ? "active" : ""}`}
                    aria-pressed={selectingGenres}
                    onClick={() => setSelectingGenres((current) => !current)}
                  >
                    <Check size={12} /> Select My Genres (Min{" "}
                    {MINIMUM_SELECTED_GENRES})
                  </button>
                </div>
              </div>
              <div className="alhan-genre-row">
                {GENRES.map((genreInfo) => {
                  const genre = genreInfo.id;
                  const selected =
                    taste.profile.selectedGenres.includes(genre);
                  const active =
                    genreShelf === genre || genreFilter === genre;
                  const preview = genrePreviewTracks[genre];
                  return (
                    <div
                      key={genre}
                      className={`alhan-genre-card ${selected ? "selected" : ""} ${active ? "active" : ""}`}
                    >
                      <button
                        type="button"
                        className="alhan-genre-card-main"
                        aria-label={
                          selectingGenres
                            ? `${selected ? "Remove" : "Add"} ${genreLabel(genre)} ${selected ? "from" : "to"} your taste`
                            : `Browse ${genreLabel(genre)} tracks`
                        }
                        onClick={() => {
                          if (selectingGenres) {
                            taste.toggleGenre(genre);
                          } else {
                            void browseGenre(genre);
                          }
                        }}
                      >
                        <span
                          className="alhan-genre-art"
                          style={
                            {
                              "--genre-accent": genreAccent(genre),
                            } as CSSProperties
                          }
                        >
                          {preview ? (
                            <TrackArtwork
                              className="alhan-genre-artwork"
                              track={preview}
                              alt={`${preview.channelTitle} — ${genreLabel(genre)} artwork`}
                              loading="eager"
                            />
                          ) : (
                            <GenreIcon genre={genre} size={20} />
                          )}
                        </span>
                        <b>{genreLabel(genre)}</b>
                        <small>
                          {preview
                            ? `${preview.channelTitle} · ${preview.title}`
                            : selected
                              ? "In your mix"
                              : active
                                ? "Now browsing"
                                : selectingGenres
                                  ? "Tap to add"
                                  : "Tap to browse"}
                        </small>
                      </button>
                      <button
                        type="button"
                        className="alhan-genre-card-check"
                        aria-pressed={selected}
                        aria-label={`${selected ? "Remove" : "Add"} ${genreLabel(genre)} ${selected ? "from" : "to"} your taste profile`}
                        onClick={() => taste.toggleGenre(genre)}
                      >
                        {selected ? <Check size={11} /> : <Plus size={11} />}
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="alhan-taste-status">
                <SlidersHorizontal size={12} />
                <span>
                  {remainingGenres === 0
                    ? `${selectedCount} genres tuned into your mix`
                    : `Pick ${remainingGenres} more genre${remainingGenres === 1 ? "" : "s"} to personalise Trending Now`}
                </span>
                <button
                  type="button"
                  className={remainingGenres === 0 ? "alhan-update-taste" : ""}
                  onClick={() => {
                    setSelectingGenres(false);
                    setGenreShelf(null);
                    setGenreFilter(null);
                    setGenreOnboardingOpen(true);
                  }}
                >
                  {remainingGenres === 0 ? "Update My Taste" : "Edit taste"}
                </button>
              </div>
            </section>

            <div className="alhan-home-grid">
              <section
                className="alhan-home-section"
                aria-label="Trending tracks"
              >
                <div className="alhan-section-heading">
                  <div>
                    <span className="eyebrow">{shelfEyebrow}</span>
                    <h2>{shelfTitle}</h2>
                  </div>
                  <div className="alhan-section-heading-actions">
                    {genreShelf && !searchActive && (
                      <button
                        type="button"
                        onClick={() => {
                          setGenreShelf(null);
                          setGenreShelfTracks([]);
                          setGenreFilter(null);
                        }}
                      >
                        Clear filter
                      </button>
                    )}
                  </div>
                </div>
                <div className="alhan-track-row">
                  {shelfLoading && shelfTracks.length === 0
                    ? Array.from({ length: 5 }).map((_, index) => (
                        <div className="alhan-track-skeleton" key={index} />
                      ))
                    : shelfTracks.slice(0, 5).map((track) => {
                        const queued = ecosystemQueue.upNextQueue.some(
                          (item) => item.id === track.id,
                        );
                        return (
                        <article
                          className="alhan-track-card-live"
                          key={track.id}
                        >
                          <button
                            type="button"
                            className={`alhan-track-art ${loadingId === track.id ? "is-loading" : ""}`}
                            aria-label={`Play ${track.title} in 8D`}
                            disabled={!eightDEngine || loadingId !== null}
                            onClick={() => void playTrackIn8D(track)}
                          >
                            <TrackArtwork
                              className="alhan-track-artwork"
                              track={track}
                              alt={`${track.title} artwork`}
                            />
                            <span>
                              {loadingId === track.id ? (
                                <LoaderCircle className="spinner" size={16} />
                              ) : (
                                <Play size={16} fill="currentColor" />
                              )}
                            </span>
                          </button>
                          <b title={track.title}>{track.title}</b>
                          <small>{track.channelTitle}</small>
                          <div className="alhan-track-card-actions">
                            <a
                              href={apiUrl(`/api/download?id=${encodeURIComponent(track.id)}`)}
                              aria-label={`Download MP3 ${track.title}`}
                            >
                              <Download size={11} />
                            </a>
                          </div>
                        </article>
                        );
                      })}
                  {!shelfLoading && shelfTracks.length === 0 && (
                    <p className="alhan-home-empty">
                      {searchActive
                        ? "No matches yet. Try another artist, song, or genre."
                        : "Pick genres or search to load live tracks."}
                    </p>
                  )}
                </div>
              </section>

              <aside
                className="alhan-recent-panel"
                aria-label="Recently played"
              >
                <div className="alhan-home-shelf-heading">
                  <div>
                    <span>HISTORY</span>
                    <b>RECENTLY PLAYED</b>
                  </div>
                  <button
                    type="button"
                    onClick={taste.clearRecentlyPlayed}
                    disabled={taste.profile.recentlyPlayed.length === 0}
                  >
                    CLEAR ALL
                  </button>
                </div>
                {taste.profile.recentlyPlayed.length === 0 ? (
                  <p className="alhan-home-empty recent-empty">
                    Tracks you play in 8D appear here.
                  </p>
                ) : (
                  taste.profile.recentlyPlayed.slice(0, 6).map((track) => (
                    <div className="alhan-recent-row" key={track.id}>
                      <button
                        type="button"
                        className="alhan-recent-main"
                        aria-label={`Play ${track.title} in 8D`}
                        disabled={!eightDEngine || loadingId !== null}
                        onClick={() => void playTrackIn8D(track)}
                      >
                        <TrackArtwork
                          className="alhan-recent-artwork"
                          track={track}
                        />
                        <span>
                          <b>{track.title}</b>
                          <small>{track.channelTitle}</small>
                        </span>
                        {loadingId === track.id ? (
                          <LoaderCircle className="spinner alhan-recent-play" size={13} />
                        ) : (
                          <Play
                            className="alhan-recent-play"
                            size={13}
                            fill="currentColor"
                          />
                        )}
                      </button>
                      <details className="alhan-recent-menu">
                        <summary aria-label={`Actions for ${track.title}`}>
                          ⋮
                        </summary>
                        <div>
                          <button
                            type="button"
                            disabled={!eightDEngine || loadingId !== null}
                            onClick={() => void playTrackIn8D(track)}
                          >
                            {loadingId === track.id ? "Playing…" : "Play in 8D"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void loadToDeck("A", track)}
                          >
                            Load Deck A
                          </button>
                          <button
                            type="button"
                            onClick={() => void loadToDeck("B", track)}
                          >
                            Load Deck B
                          </button>
                          <button
                            type="button"
                            onClick={() => queueTrack(track)}
                          >
                            Add to Queue
                          </button>
                          <a
                            href={apiUrl(`/api/download?id=${encodeURIComponent(track.id)}`)}
                          >
                            Download MP3
                          </a>
                        </div>
                      </details>
                    </div>
                  ))
                )}
              </aside>
            </div>

            <div className="alhan-home-player" aria-label="Now playing">
              <div className="alhan-home-player-info">
                <span className="eyebrow">NOW PLAYING</span>
                <b title={snapshots.A.title}>
                  {snapshots.A.trackId
                    ? snapshots.A.title
                    : "Nothing loaded — pick a track or press Play Now"}
                </b>
                <small>
                  {snapshots.A.isPlaying ? "HALL 8D ACTIVE" : "DECK A STANDBY"}
                </small>
              </div>
              <div className="alhan-home-player-controls">
                <button
                  type="button"
                  aria-label="Previous track"
                  onClick={() => void playPreviousEcosystemTrack()}
                >
                  <SkipBack size={16} />
                </button>
                <button
                  type="button"
                  className="alhan-home-player-play"
                  aria-label={snapshots.A.isPlaying ? "Pause" : "Play"}
                  onClick={() => {
                    if (!engine) return;
                    void engine.resume().then(() => {
                      engine.deckA.togglePlayback();
                      refresh();
                    });
                  }}
                >
                  {snapshots.A.isPlaying ? (
                    <Pause size={17} fill="currentColor" />
                  ) : (
                    <Play size={17} fill="currentColor" />
                  )}
                </button>
                <button
                  type="button"
                  aria-label="Next track"
                  onClick={() => void playNextEcosystemTrack()}
                >
                  <SkipForward size={16} />
                </button>
              </div>
              <div className="alhan-home-player-progress">
                <span>{formatTime(snapshots.A.position)}</span>
                <div>
                  <i
                    style={{
                      width: `${
                        snapshots.A.duration > 0
                          ? Math.min(
                              100,
                              (snapshots.A.position / snapshots.A.duration) *
                                100,
                            )
                          : 0
                      }%`,
                    }}
                  />
                </div>
                <span>{formatTime(snapshots.A.duration)}</span>
              </div>
              <button
                type="button"
                className="alhan-home-player-open"
                onClick={() => setMode("music")}
              >
                Open 8D <ChevronRight size={12} />
              </button>
            </div>
          </div>
        </section>
      ) : mode === "dj" ? (
        <div className="workspace concert-mode dj-workspace">
          <DeckPanel
            id="A"
            engine={engine}
            snapshot={snapshots.A}
            accent="#32d6cb"
            onChange={refresh}
            onDropFile={(id, file) => {
              void loadLocalTrack(id, { file, id: `${file.name}-${file.lastModified}` });
            }}
          />
          <aside className="mixer-panel">
            <div className="mixer-heading">
              <SlidersHorizontal size={15} />
              <span>MIXER</span>
              <button
                type="button"
                className={`browser-toggle beatpad-toggle ${beatPadOpen ? "selected" : ""}`}
                onClick={() => setBeatPadOpen((open) => !open)}
                aria-pressed={beatPadOpen}
              >
                <Gamepad2 size={15} /> PADS
              </button>
            </div>
            <div className="mixer-spectrum"><SpectrumMeter engine={engine} /></div>
            <div className="mixer-level">
              <Volume2 size={16} />
              <span>MASTER</span>
              <strong>{Math.round(masterVolume * 100)}%</strong>
            </div>
            <input
              className="master-slider"
              aria-label="Master volume"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={masterVolume}
              onChange={(event) => {
                const value = Number(event.target.value);
                engineRef.current?.setMasterVolume(value);
                setMasterVolume(value);
              }}
            />
            <div className="master-meter"><span style={{ width: `${masterVolume * 100}%` }} /></div>
            <div className="mixer-deck-state">
              <div className="mixer-deck-row"><i className="meter-a" /><span>DECK A</span><b>{snapshots.A.isPlaying ? "PLAY" : "—"}</b></div>
              <div className="mixer-deck-row"><i className="meter-b" /><span>DECK B</span><b>{snapshots.B.isPlaying ? "PLAY" : "—"}</b></div>
            </div>
            <div className="crossfader-block">
              <div className="crossfader-label"><span>A</span><span>CROSSFADER</span><span>B</span></div>
              <input
                className="crossfader"
                aria-label="Crossfader"
                type="range"
                min={-1}
                max={1}
                step={0.01}
                value={crossfader}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  engineRef.current?.setCrossfader(value);
                  setCrossfader(value);
                }}
              />
              <div className="crossfader-markers"><span>◀</span><span>CENTER</span><span>▶</span></div>
            </div>
            <div className="mixer-footer"><Activity size={13} /> STEREO · 44.1 KHZ</div>
          </aside>
          <DeckPanel
            id="B"
            engine={engine}
            snapshot={snapshots.B}
            accent="#f184b8"
            onChange={refresh}
            onDropFile={(id, file) => {
              void loadLocalTrack(id, { file, id: `${file.name}-${file.lastModified}` });
            }}
          />
          <StageLighting engine={engine} />
        </div>
      ) : (
        mode === "settings" ? (
          <SettingsPanel
            botActivated={botActivated}
            onActivateBot={activateBot}
            onDeactivateBot={deactivateBot}
            onOpenBot={() => setAiOpen(true)}
            selectedGenres={taste.profile.selectedGenres.length}
            onEditTaste={() => setGenreOnboardingOpen(true)}
            historyCount={taste.profile.recentlyPlayed.length}
            onClearHistory={taste.clearRecentlyPlayed}
            onOpenDj={() => setMode("dj")}
          />
        ) : mode === "about" ? (
          <AboutPanel
            onOpenHome={() => setMode("home")}
            onOpenBot={() => setAiOpen(true)}
          />
        ) : (
        <MusicPlayerMode
          engine={engine}
          snapshot={(eightDSnapshot ?? snapshots.A) as DeckSnapshot}
          eightDEngine={eightDEngine}
          eightDSnapshot={eightDSnapshot}
          tracks={youtubeTracks}
          searchQuery={youtubeQuery}
          onSearchQueryChange={setYoutubeQuery}
          onSearch={(event) => void searchYoutube(event)}
          searching={searching}
          loadingId={loadingId}
          onPlayTrack={playTrackIn8D}
          ecosystemQueue={ecosystemQueue}
          onSeedTrack={seedEcosystem}
          onClearSeed={clearEcosystem}
          onNextTrack={() => void playNextEcosystemTrack()}
          onPreviousTrack={() => void playPreviousEcosystemTrack()}
          onPlayQueuedTrack={playQueuedEcosystemTrack}
          onDeckChange={refresh}
          onToggleLibrary={() => setBrowserOpen((open) => !open)}
          tasteProfile={tasteProfile}
          genreFilter={genreFilter}
          onGenreFilterChange={setGenreFilter}
          onUpdateTaste={() => setGenreOnboardingOpen(true)}
        />
        )
      )}

      {beatPadOpen && engine && beatPadEngine && (
        <BeatPad
          engine={engine}
          padEngine={beatPadEngine}
          onClose={() => setBeatPadOpen(false)}
          onDeckChange={refresh}
          onError={setError}
        />
      )}

      <GenreOnboarding
        open={genreOnboardingOpen}
        profile={taste.profile}
        onSave={updateTasteProfile}
        onClose={() => setGenreOnboardingOpen(false)}
      />

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" aria-label="Dismiss error" onClick={() => setError("")}><X size={15} /></button>
        </div>
      )}

      <section className={`browser-drawer ${browserOpen ? "open" : ""}`} aria-hidden={!browserOpen}>
        <div className="browser-header">
          <div>
            <span className="eyebrow">TRACK DECK</span>
            <h2>LIBRARY <small>{localTracks.length + youtubeTracks.length} TRACKS</small></h2>
          </div>
          <button className="close-browser" type="button" onClick={() => setBrowserOpen(false)} aria-label="Close library"><X size={18} /></button>
        </div>
        <div className="browser-content">
          <div className="library-column local-library">
            <div className="browser-column-heading"><Music2 size={15} /><span>LOCAL AUDIO</span></div>
            <label className="file-drop">
              <input
                type="file"
                accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg"
                multiple
                onChange={(event) => addLocalFiles(event.target.files)}
              />
              <FolderOpen size={19} />
              <span>Choose audio files</span>
              <small>MP3 · WAV · M4A · FLAC</small>
            </label>
            <div className="track-list">
              {localTracks.map((track) => (
                <div className="track-item" key={track.id}>
                  <div className="track-item-icon"><Music2 size={15} /></div>
                  <div className="track-item-info"><b title={track.file.name}>{track.file.name}</b><small>{(track.file.size / 1048576).toFixed(1)} MB</small></div>
                  <div className="load-actions">
                    <button type="button" onClick={() => void loadLocalTrack("A", track)}>A</button>
                    <button type="button" onClick={() => void loadLocalTrack("B", track)}>B</button>
                  </div>
                </div>
              ))}
              {localTracks.length === 0 && <p className="empty-library">Add tracks or drag audio onto a deck.</p>}
            </div>
          </div>

          <div className="library-column youtube-library">
            <div className="browser-column-heading"><Radio size={15} /><span>YOUTUBE SEARCH</span></div>
            <form className="youtube-search" onSubmit={(event) => void searchYoutube(event)}>
              <Search size={16} />
              <input
                type="search"
                value={youtubeQuery}
                onChange={(event) => setYoutubeQuery(event.target.value)}
                placeholder="Search tracks or paste a YouTube URL"
                aria-label="Search YouTube"
              />
              <button type="submit" disabled={searching} aria-label="Search">
                {searching ? <LoaderCircle className="spinner" size={16} /> : <Search size={16} />}
              </button>
            </form>
            <div className="track-list youtube-results">
              {youtubeTracks.map((track) => (
                <div className="track-item" key={track.id}>
                  <TrackArtwork className="youtube-thumb" track={track} />
                  <div className="track-item-info"><b title={track.title}>{track.title}</b><small>{track.channelTitle} · {track.duration ? formatTime(track.duration) : "YouTube"}</small></div>
                  <div className="load-actions">
                    <button type="button" disabled={loadingId === track.id} onClick={() => void loadYoutubeTrack("A", track)}>{loadingId === track.id ? <LoaderCircle className="spinner" size={13} /> : "A"}</button>
                    <button type="button" disabled={loadingId === track.id} onClick={() => void loadYoutubeTrack("B", track)}>{loadingId === track.id ? <LoaderCircle className="spinner" size={13} /> : "B"}</button>
                  </div>
                </div>
              ))}
              {youtubeTracks.length === 0 && <p className="empty-library">Search for a track to add it to either deck.</p>}
            </div>
          </div>
        </div>
        <div className="browser-footnote">For personal use, respect creators’ rights and the platform’s terms when streaming third-party audio.</div>
      </section>

      <AiDjPanel
        open={aiOpen}
        mode={mode === "dj" ? "dj" : "music"}
        activated={botActivated}
        onActivate={activateBot}
        loadingId={loadingId}
        searchTracks={searchTracks}
        onClose={() => setAiOpen(false)}
        onLoadTrack={loadAiTrack}
        onPlayIn8D={playAiTrackIn8D}
        onRunSet={(items) => void runAiSet(items)}
        aiQueue={aiQueue}
        aiQueueIndex={aiQueueIndex}
        onStopSet={stopAiSet}
        tasteProfile={tasteProfile}
      />

      <footer className="bottom-bar">
        <span><span className="status-dot" /> SYSTEM NOMINAL</span>
        <span>{mode === "dj" ? "DUAL DECK · 8D SPATIAL FX" : "DECK A · 360° SPATIAL AUDIO"}</span>
        <span>ALHAN DJ <span className="footer-version">PHASE 02</span></span>
      </footer>
      </div>
    </main>
  );
}
