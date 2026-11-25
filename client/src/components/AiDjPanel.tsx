"use client";

import {
  ArrowDown,
  ArrowUp,
  Bot,
  Flame,
  ListMusic,
  LoaderCircle,
  Mic,
  Play,
  Plus,
  Send,
  Sparkles,
  Square,
  Trash,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isAiStage,
  STAGE_LABELS,
  type AiDjResponse,
  type AiSetQueueItem,
  type AiSetStep,
  type DeckFx,
} from "../lib/aiDj";
import type { TrackResult } from "../lib/tracks";
import TrackArtwork from "./TrackArtwork";
import type { TasteProfile } from "../utils/tasteProfile";
import { fetchApi, readApiJson } from "../lib/api";

type DeckSlot = "A" | "B";
type AiMode = "dj" | "music";

const MAX_SETLIST_TRACKS = 24;

type SpeechRecognitionResult = ArrayLike<{ transcript: string }> & {
  isFinal?: boolean;
};

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<SpeechRecognitionResult> }) => void) | null;
  onstart: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

const stageIcon = (stage: string) => {
  if (!isAiStage(stage)) return <Zap size={11} />;
  if (stage === "peak") return <Flame size={11} />;
  if (stage === "build") return <Sparkles size={11} />;
  return <Zap size={11} />;
};

function formatTime(seconds: number | null): string {
  if (!seconds || !Number.isFinite(seconds)) return "YouTube";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

export default function AiDjPanel({
  open,
  mode,
  activated,
  onActivate,
  loadingId,
  searchTracks,
  onClose,
  onLoadTrack,
  onPlayIn8D,
  onRunSet,
  aiQueue,
  aiQueueIndex,
  onStopSet,
  tasteProfile,
}: {
  open: boolean;
  mode: AiMode;
  activated: boolean;
  onActivate: () => void;
  loadingId: string | null;
  searchTracks: (query: string) => Promise<TrackResult[]>;
  onClose: () => void;
  onLoadTrack: (
    deck: DeckSlot,
    track: TrackResult,
    fx: DeckFx,
  ) => Promise<boolean>;
  onPlayIn8D: (track: TrackResult, fx: DeckFx) => Promise<boolean>;
  onRunSet: (items: AiSetQueueItem[]) => void;
  aiQueue: AiSetQueueItem[];
  aiQueueIndex: number;
  onStopSet: () => void;
  tasteProfile: TasteProfile | null;
}) {
  const [prompt, setPrompt] = useState("");
  const [setlist, setSetlist] = useState<string[]>([]);
  const [trackInput, setTrackInput] = useState("");
  const [includeBridges, setIncludeBridges] = useState(true);
  const [busy, setBusy] = useState(false);
  const [resolvingPlay, setResolvingPlay] = useState(false);
  const [resolvingSet, setResolvingSet] = useState(false);
  const [error, setError] = useState("");
  const [response, setResponse] = useState<AiDjResponse | null>(null);
  const [resolvedPlay, setResolvedPlay] = useState<TrackResult | null>(null);
  const [resolvedSteps, setResolvedSteps] = useState<Array<TrackResult | null>>(
    [],
  );
  const [listening, setListening] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const recognitionConstructorRef = useRef<SpeechRecognitionConstructor | null>(null);
  const restartRecognitionRef = useRef<(() => void) | null>(null);
  const listenerEnabledRef = useRef(false);
  const awaitingSongRef = useRef(false);
  const speechPausedRef = useRef(false);
  const busyRef = useRef(false);
  const runRequestRef = useRef<((options?: {
    workflow?: "vibe" | "setlist";
    message?: string;
    autoPlay?: boolean;
  }) => Promise<void>) | null>(null);
  const speakAsAlhanRef = useRef<(message: string) => void>(() => {});

  useEffect(
    () => () => {
      listenerEnabledRef.current = false;
      recognitionRef.current?.stop();
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    },
    [],
  );

  const speakAsAlhan = (message: string) => {
    if (!("speechSynthesis" in window)) return;
    speechPausedRef.current = true;
    recognitionRef.current?.stop();
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(message);
    utterance.lang = navigator.language || "en-US";
    const resumeListening = () => {
      speechPausedRef.current = false;
      if (listenerEnabledRef.current && !busyRef.current) {
        window.setTimeout(() => restartRecognitionRef.current?.(), 350);
      } else {
        setListening(false);
      }
    };
    utterance.onend = resumeListening;
    utterance.onerror = resumeListening;
    window.speechSynthesis.speak(utterance);
  };

  const addTrack = () => {
    const value = trackInput.trim();
    if (!value) return;
    if (setlist.length >= MAX_SETLIST_TRACKS) {
      setError(`Setlists are limited to ${MAX_SETLIST_TRACKS} tracks.`);
      return;
    }
    setSetlist((current) => [...current, value]);
    setTrackInput("");
  };

  const moveTrack = (index: number, direction: -1 | 1) => {
    setSetlist((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

  const removeTrack = (index: number) => {
    setSetlist((current) => current.filter((_, itemIndex) => itemIndex !== index));
  };

  const resolvePlayRequest = async (
    query: string,
    autoPlay: boolean,
    fx: DeckFx,
  ) => {
    setResolvingPlay(true);
    if (autoPlay) setVoiceStatus(`Finding “${query}” on YouTube…`);
    try {
      const tracks = await searchTracks(query);
      const track = tracks[0] ?? null;
      setResolvedPlay(track);
      if (!track) {
        const message = `I couldn't find “${query}” on YouTube. Try another title or artist.`;
        setError(message);
        if (autoPlay) {
          setVoiceStatus(message);
          setResponse((current) =>
            current?.action.type === "play_request"
              ? { ...current, reply: message }
              : current,
          );
          speakAsAlhan(message);
        }
        return;
      }

      if (autoPlay) {
        setVoiceStatus(`Starting “${track.title}”…`);
        const started = await onPlayIn8D(track, fx);
        if (!started) {
          const message = `I found “${track.title}”, but couldn't start playback. Check the audio server and try again.`;
          setError(message);
          setVoiceStatus(message);
          setResponse((current) =>
            current?.action.type === "play_request"
              ? { ...current, reply: message }
              : current,
          );
          speakAsAlhan(message);
          return;
        }

        const reply = `Playing ${track.title}.`;
        setVoiceStatus(reply);
        setResponse((current) =>
          current?.action.type === "play_request"
            ? { ...current, reply }
            : current,
        );
        speakAsAlhan(reply);
      }
    } catch (reason) {
      setResolvedPlay(null);
      const message =
        reason instanceof Error
          ? reason.message
          : "Could not resolve that request through YouTube search.";
      setError(message);
      if (autoPlay) {
        setVoiceStatus(message);
        setResponse((current) =>
          current?.action.type === "play_request"
            ? { ...current, reply: message }
            : current,
        );
        speakAsAlhan(message);
      }
    } finally {
      setResolvingPlay(false);
    }
  };

  const resolveSetSteps = async (steps: AiSetStep[]) => {
    const results: Array<TrackResult | null> = steps.map(() => null);
    setResolvedSteps(results);
    setResolvingSet(true);
    let cursor = 0;

    const worker = async () => {
      while (cursor < steps.length) {
        const index = cursor;
        cursor += 1;
        const step = steps[index];
        if (!step) continue;
        try {
          const tracks = await searchTracks(step.track);
          results[index] = tracks[0] ?? null;
        } catch {
          results[index] = null;
        }
        setResolvedSteps([...results]);
      }
    };

    try {
      await Promise.all([worker(), worker()]);
    } finally {
      setResolvingSet(false);
    }
  };

  const runRequest = async (options?: {
    workflow?: "vibe" | "setlist";
    message?: string;
    autoPlay?: boolean;
  }) => {
    if (!activated) {
      setError("Activate ALHAN Bot to start a voice or setlist request.");
      return;
    }
    if (busyRef.current) return;
    const autoPlay = options?.autoPlay === true;
    const workflow =
      options?.workflow ??
      (autoPlay ? "vibe" : mode === "dj" && setlist.length > 0 ? "setlist" : "vibe");
    const message =
      (options?.message ?? prompt).trim() ||
      (workflow === "setlist"
        ? "Make this a high-vibe set in this exact order."
        : "");
    const orderedTracks = workflow === "setlist" ? setlist : [];

    if (workflow === "setlist" && orderedTracks.length === 0) {
      setError("Add at least one track to the setlist first.");
      return;
    }
    if (!message && orderedTracks.length === 0) {
      setError("Ask for a song or vibe, or add tracks to the setlist.");
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setError("");
    setResponse(null);
    setResolvedPlay(null);
    setResolvedSteps([]);
    if (autoPlay) setVoiceStatus("ALHAN is finding your track…");

    try {
      const result = await fetchApi(
        "/api/ai-dj",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            orderedTracks: orderedTracks.length > 0 ? orderedTracks : undefined,
            includeBridges,
            workflow,
            mode,
            selectedGenres: tasteProfile?.selectedGenres ?? [],
            genreAffinities: tasteProfile?.genreAffinities ?? {},
            recentSearches: tasteProfile?.recentSearches ?? [],
          }),
        },
      );
      const data = await readApiJson<AiDjResponse>(
        result,
        "The AI DJ request failed",
      );
      if (!result.ok) throw new Error(data.error ?? "The AI DJ request failed.");
      if (!data?.action) throw new Error("The AI DJ returned an unexpected response.");
      if (autoPlay && data.action.type !== "play_request") {
        throw new Error("Ask ALHAN for one song at a time when using voice playback.");
      }
      setResponse(data);

      if (data.action.type === "play_request") {
        await resolvePlayRequest(data.action.query, autoPlay, {
          enable8d: data.action.enable8d,
          bassBoost: data.action.bassBoost,
        });
      } else {
        await resolveSetSteps(data.action.steps);
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not reach the AI DJ service.",
      );
      if (autoPlay) {
        const message =
          reason instanceof Error
            ? reason.message
            : "ALHAN couldn't process that voice request.";
        setVoiceStatus(message);
        speakAsAlhan(message);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
      if (!listenerEnabledRef.current) setListening(false);
      if (listenerEnabledRef.current && !speechPausedRef.current) {
        window.setTimeout(() => restartRecognitionRef.current?.(), 350);
      }
    }
  };

  useEffect(() => {
    runRequestRef.current = runRequest;
    speakAsAlhanRef.current = speakAsAlhan;
  });

  const startListening = useCallback(() => {
    const Recognition = recognitionConstructorRef.current;
    if (
      !Recognition ||
      !listenerEnabledRef.current ||
      busyRef.current ||
      speechPausedRef.current ||
      recognitionRef.current
    ) {
      return;
    }

    const recognition = new Recognition();
    recognition.lang = navigator.language || "en-US";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onstart = () => {
      setListening(true);
      setVoiceStatus('Listening for “Alhan”…');
    };
    recognition.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      if (!result?.isFinal && result?.isFinal !== undefined) return;
      const transcript = result?.[0]?.transcript.trim();
      if (!transcript) return;

      const wakeWord = /\b(?:alhan|alham)\b/i;
      const hasWakeWord = wakeWord.test(transcript);
      const request = hasWakeWord
        ? transcript
            .replace(wakeWord, " ")
            .replace(/^[\s,.:;-]+|[\s,.:;!?-]+$/g, "")
            .trim()
        : awaitingSongRef.current
          ? transcript
          : "";

      if (hasWakeWord && !request) {
        awaitingSongRef.current = true;
        setVoiceStatus("ALHAN heard you. Listening for your song request…");
        recognition.stop();
        speakAsAlhanRef.current("Yes, how can I help?");
        return;
      }

      if (!request) {
        setVoiceStatus('Listening for “Alhan”…');
        return;
      }

      awaitingSongRef.current = false;
      setPrompt(request);
      setVoiceStatus(`Okay. Searching for “${request}”…`);
      recognition.stop();
      speakAsAlhanRef.current("Okay, searching now.");
      void runRequestRef.current?.({
        workflow: "vibe",
        message: request,
        autoPlay: true,
      });
    };
    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      const needsPermission = event.error === "not-allowed" || event.error === "service-not-allowed";
      const missingMicrophone = event.error === "audio-capture";
      const message =
        needsPermission
          ? "Microphone access was denied. Allow it for this site, then reload the app."
          : missingMicrophone
            ? "No microphone was detected. Connect a microphone and try again."
            : `Voice recognition was interrupted${event.error ? ` (${event.error})` : ""}. Restarting…`;
      if (needsPermission || missingMicrophone) {
        listenerEnabledRef.current = false;
      }
      setError(message);
      setVoiceStatus(message);
      if (needsPermission || missingMicrophone) setListening(false);
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      if (!listenerEnabledRef.current) {
        setListening(false);
        return;
      }
      if (
        !speechPausedRef.current &&
        !busyRef.current
      ) {
        window.setTimeout(() => restartRecognitionRef.current?.(), 350);
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch (reason) {
      recognitionRef.current = null;
      listenerEnabledRef.current = false;
      setListening(false);
      const message =
        reason instanceof Error ? reason.message : "Could not start voice input.";
      setError(message);
      setVoiceStatus(message);
    }
  }, []);

  useEffect(() => {
    if (!activated) {
      listenerEnabledRef.current = false;
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      setListening(false);
      setVoiceStatus("Activate ALHAN Bot to enable voice listening.");
      return;
    }
    const timer = window.setTimeout(() => {
      const speechWindow = window as SpeechRecognitionWindow;
      const Recognition =
        speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
      if (!Recognition) {
        setError("Voice input isn't supported in this browser. Try a current version of Chrome or Edge.");
        setVoiceStatus("Voice input isn't supported in this browser.");
        return;
      }

      recognitionConstructorRef.current = Recognition;
      listenerEnabledRef.current = true;
      setError("");
      setVoiceStatus('Starting wake-word listening for “Alhan”…');
      restartRecognitionRef.current = startListening;
      startListening();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activated, startListening]);

  const retryStep = async (index: number, step: AiSetStep) => {
    try {
      const tracks = await searchTracks(step.track);
      setResolvedSteps((current) => {
        const next = [...current];
        next[index] = tracks[0] ?? null;
        return next;
      });
    } catch {
      setResolvedSteps((current) => {
        const next = [...current];
        next[index] = null;
        return next;
      });
    }
  };

  const runOrderedSet = async () => {
    if (!response || response.action.type !== "high_vibe_set" || busy) return;
    const steps = response.action.steps;
    if (steps.length === 0) {
      setError("This set has no steps to run.");
      return;
    }

    setBusy(true);
    setError("");
    const results = [...resolvedSteps];
    const items: AiSetQueueItem[] = [];

    try {
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        if (!step) continue;
        if (!results[index]) {
          try {
            const tracks = await searchTracks(step.track);
            results[index] = tracks[0] ?? null;
          } catch {
            results[index] = null;
          }
          setResolvedSteps([...results]);
        }
        const track = results[index];
        if (track) items.push({ track, step });
      }

      if (items.length === 0) {
        setError("None of the set tracks could be resolved. Refine the track names.");
        return;
      }
      if (items.length < steps.length) {
        setError(
          `${steps.length - items.length} track(s) could not be resolved and were skipped.`,
        );
      }
      onRunSet(items);
    } finally {
      setBusy(false);
    }
  };

  const renderDeckActions = (track: TrackResult, fx: DeckFx) => (
    <div className="ai-deck-actions">
      <button
        type="button"
        disabled={loadingId === track.id}
        onClick={() => void onLoadTrack("A", track, fx)}
        aria-label={`Load ${track.title} on Deck A`}
      >
        {loadingId === track.id ? <LoaderCircle className="spinner" size={11} /> : "A"}
      </button>
      <button
        type="button"
        disabled={loadingId === track.id}
        onClick={() => void onLoadTrack("B", track, fx)}
        aria-label={`Load ${track.title} on Deck B`}
      >
        {loadingId === track.id ? <LoaderCircle className="spinner" size={11} /> : "B"}
      </button>
      <button
        type="button"
        className="ai-play-8d"
        disabled={loadingId === track.id}
        onClick={() => void onPlayIn8D(track, fx)}
      >
        <Play size={10} fill="currentColor" /> PLAY 8D
      </button>
    </div>
  );

  const isDjMode = mode === "dj";

  return (
    <aside
      className={`ai-drawer ${open ? "open" : ""}`}
      aria-label="ALHAN voice assistant"
      aria-hidden={!open}
    >
      <header className="ai-drawer-head">
        <div className="ai-drawer-title">
          <span className="ai-mark">
            <Bot size={19} />
          </span>
          <div>
            <span className="eyebrow">ALHAN · VOICE DJ</span>
            <h2>
              ALHAN <small>VOICE ASSISTANT</small>
            </h2>
          </div>
        </div>
        <button
          className="ai-close"
          type="button"
          onClick={onClose}
          aria-label="Close ALHAN"
        >
          <X size={17} />
        </button>
      </header>

      <div className="ai-drawer-body">
        {!activated && (
          <section className="alhan-bot-activation" aria-label="Activate ALHAN Bot">
            <span className="alhan-bot-activation-mark"><Bot size={28} /></span>
            <span className="eyebrow">FIRST-TIME SETUP</span>
            <h3>Activate ALHAN Bot</h3>
            <p>
              Ask for a song or vibe, tune 8D and bass effects, or turn an
              ordered DJ song list into a staged high-vibe set.
            </p>
            <button type="button" onClick={onActivate}>
              <Sparkles size={15} /> Activate ALHAN Bot
            </button>
          </section>
        )}
        {activated && (
          <>
        {aiQueue.length > 0 && (
          <section className="ai-runner">
            <div className="ai-runner-meta">
              <span className="eyebrow">ORDERED SET RUNNING</span>
              <b>
                STEP {Math.max(1, aiQueueIndex + 1)} / {aiQueue.length}
              </b>
              <small title={aiQueue[aiQueueIndex]?.track.title}>
                {aiQueue[aiQueueIndex]?.track.title ?? "Waiting for deck"}
              </small>
            </div>
            <button type="button" onClick={onStopSet}>
              <Square size={11} fill="currentColor" /> STOP
            </button>
          </section>
        )}

        <section className="ai-request">
          <label className="ai-prompt-field">
            <span className="eyebrow">ASK ALHAN FOR A TRACK OR VIBE</span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
              placeholder={
                isDjMode
                  ? "e.g. Play Alone by Alan Walker with 8D on. Then build a high-vibe set in my exact order."
                  : "e.g. Play a euphoric 8D track with bass boost."
              }
            />
          </label>

          <div className="ai-voice-control">
            <span className={`ai-voice-mark ${listening ? "listening" : ""}`}>
              <Mic size={14} />
            </span>
            <span aria-live="polite">
              {voiceStatus || "Say “Alhan” followed by a song request."}
            </span>
          </div>

          <div className="ai-chips">
            {(isDjMode
              ? [
                  "Make this a high-vibe set in this exact order",
                  "Build to a peak in the second half",
                  "Keep 8D on through the build",
                ]
              : [
                  "Play Alone by Alan Walker with 8D on",
                  "Bass boost this track",
                  "Play something euphoric in 8D",
                ]
            ).map((chip) => (
              <button
                key={chip}
                type="button"
                className="ai-chip"
                onClick={() => setPrompt(chip)}
              >
                {chip}
              </button>
            ))}
          </div>

          {isDjMode && (
            <section className="ai-builder">
              <div className="ai-builder-head">
                <div>
                  <span className="eyebrow">SETLIST ORDER BUILDER</span>
                  <h3>
                    {setlist.length} TRACK{setlist.length === 1 ? "" : "S"} · EXACT
                    ORDER
                  </h3>
                </div>
                {setlist.length > 0 && (
                  <button
                    type="button"
                    className="ai-clear"
                    onClick={() => setSetlist([])}
                  >
                    CLEAR
                  </button>
                )}
              </div>

              <div className="ai-add-row">
                <input
                  type="text"
                  value={trackInput}
                  onChange={(event) => setTrackInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addTrack();
                    }
                  }}
                  placeholder="Add a song (artist – title)"
                  aria-label="Add a track to the setlist"
                />
                <button type="button" onClick={addTrack} aria-label="Add track">
                  <Plus size={14} /> ADD
                </button>
              </div>

              <ol className="ai-setlist">
                {setlist.map((track, index) => (
                  <li className="ai-setlist-row" key={`${track}-${index}`}>
                    <span className="ai-setlist-index">{index + 1}</span>
                    <span className="ai-setlist-name" title={track}>
                      {track}
                    </span>
                    <span className="ai-setlist-actions">
                      <button
                        type="button"
                        onClick={() => moveTrack(index, -1)}
                        disabled={index === 0}
                        aria-label={`Move ${track} up`}
                      >
                        <ArrowUp size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveTrack(index, 1)}
                        disabled={index === setlist.length - 1}
                        aria-label={`Move ${track} down`}
                      >
                        <ArrowDown size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeTrack(index)}
                        aria-label={`Remove ${track}`}
                      >
                        <Trash size={12} />
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
              {setlist.length === 0 && (
                <p className="ai-hint">
                  Add songs in the order you want them played, then generate a
                  staged high-vibe set without reordering your list.
                </p>
              )}
            </section>
          )}

          <label className="ai-checkbox">
            <input
              type="checkbox"
              checked={includeBridges}
              onChange={(event) => setIncludeBridges(event.target.checked)}
            />
            Suggest bridge / follow-up tracks
          </label>

          <div className="ai-actions">
            <button
              type="button"
              className="ai-primary"
              onClick={() => void runRequest()}
              disabled={busy}
            >
              {busy ? (
                <LoaderCircle className="spinner" size={15} />
              ) : (
                <Send size={14} />
              )}
              ASK ALHAN
            </button>
            {isDjMode && (
              <button
                type="button"
                className="ai-secondary"
                onClick={() => void runRequest({ workflow: "setlist" })}
                disabled={busy || setlist.length === 0}
              >
                <Sparkles size={14} /> GENERATE HIGH VIBE
              </button>
            )}
          </div>
        </section>

        {error && (
          <div className="ai-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError("")} aria-label="Dismiss">
              <X size={13} />
            </button>
          </div>
        )}

        {response && (
          <section className="ai-result">
            <div className="ai-reply">
              <Sparkles size={15} />
              <p>{response.reply}</p>
            </div>
            <span className="ai-source">
              {response.meta?.degraded
                ? "LOCAL PLANNER · SET GEMINI_API_KEY FOR LLM REASONING"
                : `GENERATED WITH ${(response.meta?.model ?? "GEMINI").toUpperCase()}`}
            </span>

            {response.action.type === "play_request" ? (
              <div className="ai-play-result">
                <div className="ai-result-head">
                  <span className="eyebrow">PLAY REQUEST</span>
                  <b>{response.action.query}</b>
                </div>
                <div className="ai-fx-flags">
                  <span className={response.action.enable8d ? "on" : ""}>
                    <Sparkles size={10} /> 8D {response.action.enable8d ? "ON" : "OFF"}
                  </span>
                  <span className={response.action.bassBoost ? "on" : ""}>
                    <Zap size={10} /> BASS{" "}
                    {response.action.bassBoost ? "BOOST ON" : "OFF"}
                  </span>
                </div>

                {resolvingPlay ? (
                  <div className="ai-resolving">
                    <LoaderCircle className="spinner" size={14} /> Resolving through
                    YouTube…
                  </div>
                ) : resolvedPlay ? (
                  <article className="ai-resolved-track">
                    <TrackArtwork
                      className="ai-resolved-art"
                      track={resolvedPlay}
                      alt={`${resolvedPlay.title} artwork`}
                    />
                    <div className="ai-resolved-meta">
                      <b title={resolvedPlay.title}>{resolvedPlay.title}</b>
                      <small>
                        {resolvedPlay.channelTitle} ·{" "}
                        {formatTime(resolvedPlay.duration)}
                      </small>
                    </div>
                    {renderDeckActions(resolvedPlay, {
                      enable8d: response.action.enable8d,
                      bassBoost: response.action.bassBoost,
                    })}
                  </article>
                ) : (
                  <p className="ai-hint">
                    No matching track was found. Refine the request or use the
                    Library search.
                  </p>
                )}
              </div>
            ) : (
              <div className="ai-set-result">
                <div className="ai-result-head">
                  <span className="eyebrow">HIGH VIBE SET</span>
                  <b>{response.action.title}</b>
                  <small>{response.action.vibe}</small>
                </div>

                <div className="ai-set-toolbar">
                  <span>
                    <ListMusic size={12} /> {response.action.steps.length} STEPS
                    {resolvingSet ? " · RESOLVING…" : ""}
                  </span>
                  <button
                    type="button"
                    className="ai-primary ai-run-button"
                    onClick={() => void runOrderedSet()}
                    disabled={busy || resolvingSet}
                  >
                    {busy ? (
                      <LoaderCircle className="spinner" size={13} />
                    ) : (
                      <Play size={12} fill="currentColor" />
                    )}
                    RUN ORDERED SET
                  </button>
                </div>

                <ol className="ai-steps">
                  {response.action.steps.map((step, index) => {
                    const resolved = resolvedSteps[index] ?? null;
                    const fx: DeckFx = {
                      enable8d: step.enable8d,
                      bassBoost: step.bassBoost,
                    };
                    return (
                      <li
                        className={`ai-step ai-stage-${step.stage}`}
                        key={`${step.order}-${step.track}`}
                      >
                        <span className="ai-step-order">{step.order}</span>
                        <div className="ai-step-body">
                          <div className="ai-step-title">
                            <b title={step.track}>{step.track}</b>
                            <span className={`ai-stage-pill ai-stage-${step.stage}`}>
                              {stageIcon(step.stage)}
                              {STAGE_LABELS[step.stage] ?? step.stage}
                            </span>
                            <span className="ai-energy-value">{step.energy}/10</span>
                          </div>
                          <small className="ai-step-vibe">{step.vibe}</small>
                          <div className="ai-energy-bar" aria-hidden="true">
                            <i style={{ width: `${Math.max(0, Math.min(100, step.energy * 10))}%` }} />
                          </div>
                          <p className="ai-step-tip">{step.tip}</p>
                          <p className="ai-step-cue">
                            <b>MIX CUE</b> {step.transition}
                          </p>
                          {step.bridge && (
                            <p className="ai-step-cue">
                              <b>BRIDGE</b> {step.bridge}
                            </p>
                          )}
                          {step.followUp && (
                            <p className="ai-step-cue">
                              <b>FOLLOW-UP</b> {step.followUp}
                            </p>
                          )}
                          <div className="ai-step-fx">
                            <span className={step.enable8d ? "on" : ""}>
                              8D {step.enable8d ? "ON" : "OFF"}
                            </span>
                            <span className={step.bassBoost ? "on" : ""}>
                              BASS {step.bassBoost ? "ON" : "OFF"}
                            </span>
                          </div>

                          {resolved ? (
                            <article className="ai-resolved-track ai-step-resolved">
                              <TrackArtwork
                                className="ai-resolved-art"
                                track={resolved}
                                alt={`${resolved.title} artwork`}
                              />
                              <div className="ai-resolved-meta">
                                <b title={resolved.title}>{resolved.title}</b>
                                <small>
                                  {resolved.channelTitle} ·{" "}
                                  {formatTime(resolved.duration)}
                                </small>
                              </div>
                              {renderDeckActions(resolved, fx)}
                            </article>
                          ) : (
                            <div className="ai-step-unresolved">
                              {resolvingSet ? (
                                <>
                                  <LoaderCircle className="spinner" size={12} />{" "}
                                  Resolving through YouTube…
                                </>
                              ) : (
                                <>
                                  <span>No match found.</span>
                                  <button
                                    type="button"
                                    onClick={() => void retryStep(index, step)}
                                  >
                                    RETRY
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}
          </section>
        )}
          </>
        )}
      </div>
    </aside>
  );
}
