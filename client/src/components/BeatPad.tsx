"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines, Headphones, Volume2, X } from "lucide-react";
import type { DeckId } from "../lib/audio/Deck";
import {
  BEAT_PAD_LABELS,
  BEAT_PAD_SOUNDS,
  BeatPadEngine,
} from "../lib/audio/BeatPadEngine";
import type { MixerEngine } from "../lib/audio/MixerEngine";

type PadMode = "drums" | "cues" | "loops" | "fx";

type BeatPadProps = {
  engine: MixerEngine;
  padEngine: BeatPadEngine;
  onClose: () => void;
  onDeckChange: () => void;
  onError: (message: string) => void;
};

type HeldAction = {
  intervalId?: number;
  release?: () => void;
};

const PAD_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8"] as const;
const LOOP_BEATS = [0.25, 0.5, 1, 2, 4] as const;
const LOOP_LABELS = ["1/4 BEAT", "1/2 BEAT", "1 BEAT", "2 BEATS", "4 BEATS"];
const FX_LABELS = [
  "8D SPIN",
  "BASS SURGE",
  "FILTER BURST",
  "HALL WASH",
  "8D TOGGLE",
  "BASS TOGGLE",
  "FILTER TOGGLE",
  "CLEAR FX",
];

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.matches("input, textarea, select, [contenteditable='true']"))
  );
}

function formatCue(position: number | null): string {
  if (position === null) return "EMPTY";
  const minutes = Math.floor(position / 60);
  const seconds = Math.floor(position % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export default function BeatPad({
  engine,
  padEngine,
  onClose,
  onDeckChange,
  onError,
}: BeatPadProps) {
  const [mode, setMode] = useState<PadMode>("drums");
  const [deckId, setDeckId] = useState<DeckId>("A");
  const [holdRetrigger, setHoldRetrigger] = useState(false);
  const [fxRouting, setFxRouting] = useState(false);
  const [padVolume, setPadVolume] = useState(() => padEngine.getVolume());
  const [flashingPads, setFlashingPads] = useState<Set<number>>(() => new Set());
  const heldActions = useRef(new Map<string, HeldAction>());
  const flashTimers = useRef(new Map<number, number>());
  const activeDeck = engine.getDeck(deckId);

  const flashPad = useCallback((index: number) => {
    setFlashingPads((current) => new Set(current).add(index));
    const previousTimer = flashTimers.current.get(index);
    if (previousTimer !== undefined) window.clearTimeout(previousTimer);
    const timer = window.setTimeout(() => {
      setFlashingPads((current) => {
        const next = new Set(current);
        next.delete(index);
        return next;
      });
      flashTimers.current.delete(index);
    }, 180);
    flashTimers.current.set(index, timer);
  }, []);

  const triggerDrum = useCallback(
    (index: number, velocity: number) => {
      const sound = BEAT_PAD_SOUNDS[index];
      if (!sound) return false;
      try {
        padEngine.trigger(sound, velocity);
      } catch (reason) {
        onError(
          reason instanceof Error ? reason.message : "Could not trigger the performance pad.",
        );
        return false;
      }
      void engine.resume().catch((reason: unknown) => {
        onError(reason instanceof Error ? reason.message : "Could not start the audio engine.");
      });
      flashPad(index);
      return true;
    },
    [engine, flashPad, onError, padEngine],
  );

  const releasePad = useCallback(
    (key: string) => {
      const action = heldActions.current.get(key);
      if (!action) return;
      if (action.intervalId !== undefined) window.clearInterval(action.intervalId);
      action.release?.();
      heldActions.current.delete(key);
      if (action.release) onDeckChange();
    },
    [onDeckChange],
  );

  const pressPad = useCallback(
    (key: string, index: number, velocity: number) => {
      if (heldActions.current.has(key)) return;
      flashPad(index);

      if (mode === "drums") {
        if (!triggerDrum(index, velocity)) return;
        if (holdRetrigger) {
          const intervalId = window.setInterval(
            () => {
              if (!triggerDrum(index, velocity)) releasePad(key);
            },
            120,
          );
          heldActions.current.set(key, { intervalId });
        }
        return;
      }

      if (mode === "cues") {
        if (!activeDeck.audioBuffer) {
          onError(`Load a track into Deck ${deckId} before setting hot cues.`);
          return;
        }
        const cue = activeDeck.getSnapshot().hotCues[index];
        if (cue === null || cue === undefined) activeDeck.setHotCue(index);
        else activeDeck.triggerHotCue(index);
        onDeckChange();
        return;
      }

      if (mode === "loops") {
        if (!activeDeck.audioBuffer) {
          onError(`Load a track into Deck ${deckId} before using loops.`);
          return;
        }
        if (index < LOOP_BEATS.length) {
          if (!activeDeck.setBeatLoop(LOOP_BEATS[index])) {
            onError("Could not set a quick loop at this position.");
            return;
          }
        } else if (index === 5) {
          activeDeck.setLoopEnabled(false);
        } else if (index === 6) {
          activeDeck.setLoopIn();
        } else {
          activeDeck.setLoopOut();
        }
        onDeckChange();
        return;
      }

      const snapshot = activeDeck.getSnapshot();
      if (index < 4) {
        if (index === 0) {
          activeDeck.setSpatialEnabled(true);
          activeDeck.setSpatialSpeed(0.5);
          activeDeck.setSpatialDepth(1);
          heldActions.current.set(key, {
            release: () => {
              activeDeck.setSpatialEnabled(snapshot.spatial.enabled);
              activeDeck.setSpatialSpeed(snapshot.spatial.speed);
              activeDeck.setSpatialDepth(snapshot.spatial.depth);
            },
          });
        } else if (index === 1) {
          activeDeck.setBassBoost(true);
          heldActions.current.set(key, {
            release: () => activeDeck.setBassBoost(snapshot.bassBoost),
          });
        } else if (index === 2) {
          activeDeck.setFilter(0.84);
          heldActions.current.set(key, {
            release: () => activeDeck.setFilter(snapshot.filter),
          });
        } else {
          activeDeck.setSpatialEnabled(true);
          activeDeck.setRoom(1);
          heldActions.current.set(key, {
            release: () => {
              activeDeck.setSpatialEnabled(snapshot.spatial.enabled);
              activeDeck.setRoom(snapshot.spatial.room);
            },
          });
        }
      } else if (index === 4) {
        activeDeck.setSpatialEnabled(!snapshot.spatial.enabled);
      } else if (index === 5) {
        activeDeck.setBassBoost(!snapshot.bassBoost);
      } else if (index === 6) {
        activeDeck.setFilter(snapshot.filter === 0 ? -0.78 : 0);
      } else {
        activeDeck.setSpatialEnabled(false);
        activeDeck.setBassBoost(false);
        activeDeck.setFilter(0);
      }
      onDeckChange();
    },
    [
      activeDeck,
      deckId,
      flashPad,
      holdRetrigger,
      mode,
      onDeckChange,
      onError,
      releasePad,
      triggerDrum,
    ],
  );

  useEffect(() => {
    padEngine.setFxDestination(fxRouting ? activeDeck.padInput : null);
    return () => padEngine.setFxDestination(null);
  }, [activeDeck, deckId, fxRouting, padEngine]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.repeat ||
        isEditableTarget(event.target)
      ) {
        return;
      }
      const index = PAD_KEYS.indexOf(event.key as (typeof PAD_KEYS)[number]);
      if (index < 0) return;
      event.preventDefault();
      pressPad(`keyboard-${event.key}`, index, 0.85);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (PAD_KEYS.includes(event.key as (typeof PAD_KEYS)[number])) {
        releasePad(`keyboard-${event.key}`);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [pressPad, releasePad]);

  useEffect(() => {
    const releaseAll = () => {
      for (const key of heldActions.current.keys()) releasePad(key);
    };
    window.addEventListener("blur", releaseAll);
    return () => window.removeEventListener("blur", releaseAll);
  }, [releasePad]);

  useEffect(
    () => () => {
      for (const action of heldActions.current.values()) {
        if (action.intervalId !== undefined) window.clearInterval(action.intervalId);
        action.release?.();
      }
      heldActions.current.clear();
      for (const timer of flashTimers.current.values()) window.clearTimeout(timer);
      flashTimers.current.clear();
    },
    [],
  );

  const getPadText = (index: number): { label: string; detail: string } => {
    if (mode === "drums") {
      const sound = BEAT_PAD_SOUNDS[index];
      return { label: sound ? BEAT_PAD_LABELS[sound] : "", detail: "ONE SHOT" };
    }
    if (mode === "cues") {
      const cue = activeDeck.getSnapshot().hotCues[index] ?? null;
      return { label: `CUE ${index + 1}`, detail: cue === null ? "SET" : formatCue(cue) };
    }
    if (mode === "loops") {
      if (index < LOOP_BEATS.length) {
        return { label: LOOP_LABELS[index], detail: "QUICK LOOP" };
      }
      if (index === 5) return { label: "EXIT LOOP", detail: "LOOP OFF" };
      if (index === 6) return { label: "LOOP IN", detail: "MARK START" };
      return { label: "LOOP OUT", detail: "MARK END" };
    }
    return {
      label: FX_LABELS[index],
      detail:
        index < 4
          ? "HOLD"
          : index === 7
            ? "RESET"
            : "TOGGLE",
    };
  };

  const setVolume = (value: number) => {
    padEngine.setVolume(value);
    setPadVolume(value);
  };

  return (
    <section
      id="beatpad-panel"
      className="beatpad-dock"
      aria-label="DJ performance beat pad"
    >
      <header className="beatpad-header">
        <div className="beatpad-title">
          <span className="beatpad-mark"><AudioLines size={17} /></span>
          <div>
            <b>PERFORMANCE PADS</b>
            <small>LOW-LATENCY · DECK {deckId}</small>
          </div>
        </div>
        <div className="beatpad-header-actions">
          <div className="beatpad-deck-select" role="group" aria-label="Active pad deck">
            {(["A", "B"] as const).map((id) => (
              <button
                type="button"
                key={id}
                className={deckId === id ? "selected" : ""}
                aria-pressed={deckId === id}
                onClick={() => setDeckId(id)}
              >
                {id}
              </button>
            ))}
          </div>
          <button type="button" className="beatpad-close" onClick={onClose} aria-label="Close beat pad">
            <X size={17} />
          </button>
        </div>
      </header>

      <div className="beatpad-toolbar">
        <nav className="beatpad-mode-tabs" aria-label="Beat pad mode">
          {([
            ["drums", "DRUMS / SAMPLES"],
            ["cues", "HOT CUES"],
            ["loops", "LOOPS"],
            ["fx", "8D / FX"],
          ] as const).map(([id, label]) => (
            <button
              type="button"
              key={id}
              className={mode === id ? "selected" : ""}
              aria-pressed={mode === id}
              onClick={() => setMode(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="beatpad-options">
          <label className="beatpad-volume">
            <Volume2 size={14} />
            <span>PAD VOL</span>
            <input
              aria-label="Pad master volume"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={padVolume}
              onChange={(event) => setVolume(Number(event.target.value))}
            />
            <b>{Math.round(padVolume * 100)}%</b>
          </label>
          <button
            type="button"
            className={`beatpad-option ${holdRetrigger ? "selected" : ""}`}
            aria-pressed={holdRetrigger}
            onClick={() => setHoldRetrigger((enabled) => !enabled)}
          >
            HOLD / RETRIGGER
          </button>
          <button
            type="button"
            className={`beatpad-option ${fxRouting ? "selected" : ""}`}
            aria-pressed={fxRouting}
            onClick={() => setFxRouting((enabled) => !enabled)}
          >
            <Headphones size={13} /> DECK FX SEND
          </button>
        </div>
      </div>

      <div className={`beatpad-grid beatpad-${mode}`}>
        {PAD_KEYS.map((key, index) => {
          const { label, detail } = getPadText(index);
          return (
            <button
              type="button"
              key={`${mode}-${key}`}
              className={`beatpad-pad ${flashingPads.has(index) ? "flashing" : ""}`}
              aria-label={`${label}, shortcut ${key}`}
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                const velocity =
                  event.pointerType !== "mouse" && event.pressure > 0
                    ? Math.max(0.18, event.pressure)
                    : 0.85;
                pressPad(`pointer-${event.pointerId}`, index, velocity);
              }}
              onPointerUp={(event) => releasePad(`pointer-${event.pointerId}`)}
              onPointerCancel={(event) => releasePad(`pointer-${event.pointerId}`)}
              onLostPointerCapture={(event) => releasePad(`pointer-${event.pointerId}`)}
              onClick={(event) => {
                if (event.detail !== 0) return;
                const keyId = `button-${index}`;
                pressPad(keyId, index, 0.85);
                window.setTimeout(() => releasePad(keyId), 120);
              }}
            >
              <span className="beatpad-key">{key}</span>
              <b>{label}</b>
              <small>{detail}</small>
            </button>
          );
        })}
      </div>

      <div className="beatpad-footer">
        <span>PRESS 1–8 TO TRIGGER</span>
        {mode === "drums" && <span>TOUCH PRESSURE SETS VELOCITY · HOLD TO RETRIGGER</span>}
        {mode === "loops" && <span>QUICK LOOPS SNAP TO THE ACTIVE DECK BEAT GRID</span>}
        {mode === "fx" && <span>HOLD ACCENTS TO RESTORE THE PREVIOUS DECK SETTINGS ON RELEASE</span>}
      </div>
    </section>
  );
}
