"use client";

import {
  Activity,
  AudioLines,
  Disc3,
  FolderOpen,
  Headphones,
  Info,
  LoaderCircle,
  Music2,
  Pause,
  Play,
  Radio,
  Search,
  Settings,
  SkipBack,
  SlidersHorizontal,
  Volume2,
  X,
  Crown,
} from "lucide-react";
import {
  type CSSProperties,
  type DragEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Deck, type DeckId, type DeckSnapshot, MixerEngine } from "../lib/audio/AudioEngine";
import { getEcosystemArtist, EcosystemQueueManager } from "../utils/ecosystemQueue";
import { normalizeTrack } from "../lib/tracks";
import MusicPlayerMode from "./MusicPlayerMode";
import TrackArtwork from "./TrackArtwork";
import type { TrackResult } from "../lib/tracks";

type LocalTrack = { file: File; id: string };
type DragState = { id: DeckId; x: number; tempo: number; position: number };
type AppMode = "dj" | "music";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

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
        {snapshot.hotCues.map((cue, index) => (
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
            <b>8D SPACE</b>
            <small>{snapshot.spatial.enabled ? "SPATIAL FX ACTIVE" : "SPATIAL FX BYPASS"}</small>
          </div>
        </div>
        <button
          className={`fx-switch ${snapshot.spatial.enabled ? "enabled" : ""}`}
          type="button"
          role="switch"
          aria-checked={snapshot.spatial.enabled}
          aria-label={`Toggle deck ${id} 8D spatial effect`}
          onClick={() => update((item) => item.setSpatialEnabled(!snapshot.spatial.enabled))}
        >
          <span />
        </button>
        <Rotary
          label="SPEED"
          value={snapshot.spatial.speed}
          min={0.05}
          max={0.5}
          accent={accent}
          display={`${snapshot.spatial.speed.toFixed(2)} Hz`}
          onChange={(value) => update((item) => item.setSpatialSpeed(value))}
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
      </div>
    </section>
  );
}

export default function DjConsole() {
  const engineRef = useRef<MixerEngine | null>(null);
  const [engine, setEngine] = useState<MixerEngine | null>(null);
  const [snapshots, setSnapshots] = useState<Record<DeckId, DeckSnapshot> | null>(null);
  const [queueManager] = useState(() => new EcosystemQueueManager());
  const [ecosystemQueue, setEcosystemQueue] = useState(() =>
    queueManager.getSnapshot(),
  );
  const [crossfader, setCrossfader] = useState(0);
  const [masterVolume, setMasterVolume] = useState(0.82);
  const [mode, setMode] = useState<AppMode>("dj");
  const [browserOpen, setBrowserOpen] = useState(false);
  const [localTracks, setLocalTracks] = useState<LocalTrack[]>([]);
  const [youtubeQuery, setYoutubeQuery] = useState("");
  const [youtubeTracks, setYoutubeTracks] = useState<TrackResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const isManualDeckLoad = useRef(false);

  useEffect(() => {
    const mixer = new MixerEngine();
    engineRef.current = mixer;
    let isReady = false;
    const update = () => {
      if (!isReady) {
        isReady = true;
        setEngine(mixer);
      }
      setSnapshots({
        A: mixer.deckA.getSnapshot(),
        B: mixer.deckB.getSnapshot(),
      });
      setCrossfader(mixer.getCrossfader());
      setMasterVolume(mixer.getMasterVolume());
    };
    const interval = window.setInterval(update, 100);
    return () => {
      window.clearInterval(interval);
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
  }, []);

  const refreshEcosystemQueue = useCallback(() => {
    setEcosystemQueue(queueManager.getSnapshot());
  }, [queueManager]);

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

  const searchYoutube = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!youtubeQuery.trim()) return;
    setSearching(true);
    setError("");
    try {
      const response = await fetch(
        `${API_URL}/api/search?q=${encodeURIComponent(youtubeQuery.trim())}`,
      );
      const data = (await response.json()) as {
        tracks?: TrackResult[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "YouTube search failed.");
      setYoutubeTracks((data.tracks ?? []).map((track) => normalizeTrack(track)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not reach the audio server.");
    } finally {
      setSearching(false);
    }
  };

  const loadYoutubeTrack = useCallback(async (id: DeckId, track: TrackResult): Promise<boolean> => {
    const mixer = engineRef.current;
    if (!mixer) return false;
    if (id === "A") isManualDeckLoad.current = true;
    setLoadingId(track.id);
    setError("");
    try {
      await mixer.resume();
      await mixer.loadUrl(
        id,
        `${API_URL}/api/stream/${encodeURIComponent(track.id)}`,
        track.title,
        {
          id: track.id,
          channelTitle: track.channelTitle,
          thumbnail: track.thumbnail ?? "",
        },
      );
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
      if (id === "A") isManualDeckLoad.current = false;
      setLoadingId(null);
    }
  }, [refresh]);

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
        const response = await fetch(
          `${API_URL}/api/search?q=${encodeURIComponent(query)}`,
        );
        const data = (await response.json()) as {
          tracks?: TrackResult[];
          error?: string;
        };
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

  const playEcosystemTrack = useCallback(async (track: TrackResult) => {
    if (!(await loadYoutubeTrack("A", track))) return false;
    const mixer = engineRef.current;
    if (!mixer) return false;
    const deck = mixer.deckA;
    deck.setSpatialEnabled(true);
    deck.play();
    queueManager.markPlaying(track);
    refreshEcosystemQueue();
    refresh();
    return true;
  }, [loadYoutubeTrack, queueManager, refresh, refreshEcosystemQueue]);

  const playTrackIn8D = async (track: TrackResult) => {
    queueManager.setSeed(track);
    refillAttempts.current = 0;
    refreshEcosystemQueue();
    if (!(await playEcosystemTrack(track))) return;
    void fetchEcosystemCandidates(track);
  };

  const seedEcosystem = (track: TrackResult) => {
    queueManager.setSeed(track);
    refillAttempts.current = 0;
    refreshEcosystemQueue();
    void fetchEcosystemCandidates(track);
  };

  const clearEcosystem = () => {
    queueManager.clear();
    refillAttempts.current = 0;
    refreshEcosystemQueue();
  };

  const playNextEcosystemTrack = useCallback(async () => {
    let next = queueManager.peekNext();
    if (!next) {
      const seed = queueManager.getSnapshot().seed;
      if (seed) {
        await fetchEcosystemCandidates(seed);
        next = queueManager.peekNext();
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
  }, [fetchEcosystemCandidates, playEcosystemTrack, queueManager]);

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

  useEffect(() => {
    if (!engine) return;
    const handleEnded = () => {
      if (isManualDeckLoad.current) return;
      void playNextEcosystemTrack();
    };
    engine.deckA.setOnEnded(handleEnded);
    return () => engine.deckA.setOnEnded(null);
  }, [engine, playNextEcosystemTrack]);

  if (!snapshots) {
    return <main className="boot-screen"><AudioLines size={24} /> Starting audio engine…</main>;
  }

  return (
    <main className={`app-shell ${browserOpen ? "browser-expanded" : ""}`}>
      <aside className="nav-rail" aria-label="Main navigation">
        <a className="rail-brand" href="#" aria-label="Alhan DJ home">
          <span className="rail-brand-mark"><AudioLines size={25} /></span>
          <span>ALHAN <b>DJ</b></span>
        </a>
        <nav className="rail-nav">
          <button
            type="button"
            className={`rail-item ${mode === "dj" ? "active" : ""}`}
            aria-pressed={mode === "dj"}
            onClick={() => setMode("dj")}
          >
            <Headphones size={17} /> <span>DJ Mode</span>
          </button>
          <button
            type="button"
            className={`rail-item ${mode === "music" ? "active" : ""}`}
            aria-pressed={mode === "music"}
            onClick={() => setMode("music")}
          >
            <Music2 size={17} /> <span>8D Music</span>
          </button>
          <button
            type="button"
            className={`rail-item ${browserOpen ? "active" : ""}`}
            aria-pressed={browserOpen}
            onClick={() => setBrowserOpen((open) => !open)}
          >
            <FolderOpen size={17} /> <span>Library</span>
          </button>
          <div className="rail-item rail-static"><Settings size={17} /><span>Settings</span></div>
          <div className="rail-item rail-static"><Info size={17} /><span>About</span></div>
        </nav>
        <div className="feel-beat-badge">
          <Crown size={18} />
          <b>Feel the Beat</b>
          <span>Mix · Play · Enjoy</span>
        </div>
      </aside>

      <div className="console-shell">
      <header className="topbar">
        <div className="mode-switch" role="group" aria-label="Application mode">
          <button
            type="button"
            className={mode === "dj" ? "selected" : ""}
            aria-pressed={mode === "dj"}
            onClick={() => setMode("dj")}
          >
            DJ MODE
          </button>
          <button
            type="button"
            className={mode === "music" ? "selected" : ""}
            aria-pressed={mode === "music"}
            onClick={() => setMode("music")}
          >
            8D MUSIC
          </button>
        </div>
        <div className="topbar-center">
          <span className="live-indicator"><i /> AUDIO ENGINE READY</span>
          <span className="topbar-divider" />
          <span className="headphone-status"><Headphones size={14} /> MASTER OUT</span>
        </div>
        <button className={`browser-toggle ${browserOpen ? "selected" : ""}`} onClick={() => setBrowserOpen(!browserOpen)}>
          <FolderOpen size={16} />
          LIBRARY
          {browserOpen ? <X size={14} /> : <span className="library-count">{localTracks.length + youtubeTracks.length}</span>}
        </button>
      </header>

      {mode === "dj" ? (
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
        </div>
      ) : (
        <MusicPlayerMode
          engine={engine}
          snapshot={snapshots.A}
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
        />
      )}

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

      <footer className="bottom-bar">
        <span><span className="status-dot" /> SYSTEM NOMINAL</span>
        <span>{mode === "dj" ? "DUAL DECK · 8D SPATIAL FX" : "DECK A · 360° SPATIAL AUDIO"}</span>
        <span>ALHAN DJ <span className="footer-version">PHASE 02</span></span>
      </footer>
      </div>
    </main>
  );
}
