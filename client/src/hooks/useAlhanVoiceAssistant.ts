"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TrackResult } from "../lib/tracks";

type VoiceAssistantState =
  | "WAKE_LISTENING"
  | "AWAITING_COMMAND"
  | "EXECUTING";

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

const subscribeToSpeechSupport = () => () => {};
const getSpeechSupportSnapshot = () => {
  if (typeof window === "undefined") return false;
  const speechWindow = window as SpeechRecognitionWindow;
  return Boolean(speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition);
};
const getSpeechSupportServerSnapshot = () => false;
const WAKE_PATTERN = /(?:^|[\s,.:;!?-])(alhan|al-han|allan|alan)(?=$|[\s,.:;!?-])/i;

function stripLeadingCommand(query: string): string {
  return query
    .replace(/^\s*[,:;.-]*/, "")
    .replace(/^\s*(?:play|search\s+for|find|put\s+on)\b[\s,:;.-]*/i, "")
    .replace(/^\s+|\s+$/g, "")
    .replace(/\s+/g, " ");
}

export function useAlhanVoiceAssistant({
  enabled,
  searchTracks,
  onPlayTrack,
  onVolumeDuck,
  onVolumeRestore,
}: {
  enabled: boolean;
  searchTracks: (query: string) => Promise<TrackResult[]>;
  onPlayTrack: (track: TrackResult) => Promise<boolean>;
  onVolumeDuck: () => void;
  onVolumeRestore: () => void;
}) {
  const speechWindow = typeof window === "undefined"
    ? null
    : window as SpeechRecognitionWindow;
  const Recognition = speechWindow?.SpeechRecognition ?? speechWindow?.webkitSpeechRecognition;
  const supported = useSyncExternalStore(
    subscribeToSpeechSupport,
    getSpeechSupportSnapshot,
    getSpeechSupportServerSnapshot,
  );
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState('Listening for "Alhan"...');
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const constructorRef = useRef<SpeechRecognitionConstructor | null>(null);
  const startRecognitionRef = useRef<(() => void) | null>(null);
  const restartTimerRef = useRef<number | null>(null);
  const stateRef = useRef<VoiceAssistantState>("WAKE_LISTENING");
  const enabledRef = useRef(enabled);
  const searchTracksRef = useRef(searchTracks);
  const onPlayTrackRef = useRef(onPlayTrack);
  const onVolumeDuckRef = useRef(onVolumeDuck);
  const onVolumeRestoreRef = useRef(onVolumeRestore);
  const volumeDuckedRef = useRef(false);
  const speechPausedRef = useRef(false);
  const permissionBlockedRef = useRef(false);
  const speechRequestRef = useRef(0);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  useEffect(() => {
    searchTracksRef.current = searchTracks;
  }, [searchTracks]);
  useEffect(() => {
    onPlayTrackRef.current = onPlayTrack;
  }, [onPlayTrack]);
  useEffect(() => {
    onVolumeDuckRef.current = onVolumeDuck;
  }, [onVolumeDuck]);
  useEffect(() => {
    onVolumeRestoreRef.current = onVolumeRestore;
  }, [onVolumeRestore]);

  const setAssistantState = useCallback((next: VoiceAssistantState) => {
    stateRef.current = next;
  }, []);

  const stopRecognition = useCallback(() => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    recognition?.stop();
  }, []);

  const speak = useCallback((text: string, onComplete?: () => void) => {
    if (!("speechSynthesis" in window)) {
      onComplete?.();
      return;
    }
    const requestId = ++speechRequestRef.current;
    window.speechSynthesis.cancel();
    let completed = false;
    const complete = () => {
      if (completed || speechRequestRef.current !== requestId) return;
      completed = true;
      onComplete?.();
    };
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = navigator.language || "en-US";
    utterance.onend = complete;
    utterance.onerror = complete;
    window.speechSynthesis.speak(utterance);
  }, []);

  const executeRequest = useCallback(async (spokenQuery: string) => {
    const cleanedQuery = stripLeadingCommand(spokenQuery);
    if (!cleanedQuery) {
      speechPausedRef.current = false;
      setAssistantState("WAKE_LISTENING");
      setStatus('Listening for "Alhan"...');
      if (enabledRef.current) {
        window.setTimeout(() => startRecognitionRef.current?.(), 250);
      }
      if (volumeDuckedRef.current) {
        volumeDuckedRef.current = false;
        onVolumeRestoreRef.current();
      }
      return;
    }

    setAssistantState("EXECUTING");
    setStatus(`Searching for “${cleanedQuery}”…`);
    speechPausedRef.current = true;
    stopRecognition();

    speak("Okay", async () => {
      try {
        const tracks = await searchTracksRef.current(cleanedQuery);
        const track = tracks[0];
        if (!track) {
          setStatus(`No result found for “${cleanedQuery}”.`);
          return;
        }
        setStatus(`Starting “${track.title}”…`);
        const started = await onPlayTrackRef.current(track);
        setStatus(started ? `Playing “${track.title}”.` : `Couldn't start “${track.title}”.`);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Could not search or play that song.");
      } finally {
        if (volumeDuckedRef.current) {
          volumeDuckedRef.current = false;
          onVolumeRestoreRef.current();
        }
        speechPausedRef.current = false;
        setAssistantState("WAKE_LISTENING");
        setStatus('Listening for "Alhan"...');
        if (enabledRef.current) {
          window.setTimeout(() => startRecognitionRef.current?.(), 250);
        }
      }
    });
  }, [setAssistantState, speak, stopRecognition]);

  const startRecognition = useCallback(() => {
    const Recognition = constructorRef.current;
    if (!Recognition || !enabledRef.current || recognitionRef.current) return;

    const recognition = new Recognition();
    recognition.lang = navigator.language || "en-US";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onstart = () => {
      setListening(true);
      setStatus(
        stateRef.current === "AWAITING_COMMAND"
          ? 'Listening for song...'
          : 'Listening for "Alhan"...',
      );
    };
    recognition.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      if (!result?.isFinal && result?.isFinal !== undefined) return;
      const transcript = result?.[0]?.transcript?.trim();
      if (!transcript) return;

      if (stateRef.current === "AWAITING_COMMAND") {
        void executeRequest(transcript);
        return;
      }

      const match = transcript.match(WAKE_PATTERN);
      if (!match) return;

      const wakeWordOffset = match[0].lastIndexOf(match[1] ?? "");
      const remainder = transcript
        .slice((match.index ?? 0) + wakeWordOffset + (match[1]?.length ?? 0))
        .trim();
      const directQuery = stripLeadingCommand(remainder);

      speechPausedRef.current = true;
      stopRecognition();
      if (!volumeDuckedRef.current) {
        volumeDuckedRef.current = true;
        onVolumeDuckRef.current();
      }

      if (directQuery) {
        speak("Yes, how may I help you?", () => {
          speechPausedRef.current = false;
          setAssistantState("AWAITING_COMMAND");
          void executeRequest(directQuery);
        });
      } else {
        setStatus("Speaking to ALHAN...");
        speak("Yes, how may I help you?", () => {
          speechPausedRef.current = false;
          setAssistantState("AWAITING_COMMAND");
          setStatus('Listening for song...');
          window.setTimeout(() => startRecognitionRef.current?.(), 250);
        });
      }
    };
    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        permissionBlockedRef.current = true;
        setStatus("Microphone access was denied. Allow microphone access and try again.");
        setListening(false);
      } else if (event.error === "audio-capture") {
        permissionBlockedRef.current = true;
        setStatus("No microphone was detected.");
        setListening(false);
      } else {
        setStatus("Voice recognition interrupted. Restarting...");
      }
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      setListening(false);
      if (
        !enabledRef.current ||
        permissionBlockedRef.current ||
        speechPausedRef.current ||
        stateRef.current === "EXECUTING"
      ) return;
      if (restartTimerRef.current !== null) window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = window.setTimeout(() => startRecognitionRef.current?.(), 250);
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setListening(false);
      setStatus("Could not start voice recognition.");
    }
  }, [executeRequest, setAssistantState, speak, stopRecognition]);

  useEffect(() => {
    startRecognitionRef.current = startRecognition;
  }, [startRecognition]);

  useEffect(() => {
    if (!Recognition) {
      return;
    }

    constructorRef.current = Recognition;
    if (!enabled) {
      stopRecognition();
      stateRef.current = "WAKE_LISTENING";
      speechPausedRef.current = false;
      if (volumeDuckedRef.current) {
        volumeDuckedRef.current = false;
        onVolumeRestoreRef.current();
      }
      return;
    }

    permissionBlockedRef.current = false;
    stateRef.current = "WAKE_LISTENING";
    restartTimerRef.current = window.setTimeout(() => {
      startRecognitionRef.current?.();
    }, 0);

    return () => {
      stopRecognition();
      if (restartTimerRef.current !== null) window.clearTimeout(restartTimerRef.current);
      speechRequestRef.current += 1;
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      if (volumeDuckedRef.current) {
        volumeDuckedRef.current = false;
        onVolumeRestoreRef.current();
      }
    };
  }, [Recognition, enabled, setAssistantState, startRecognition, stopRecognition]);

  return {
    supported,
    listening,
    status: !supported
      ? "Voice wake is unavailable: use Chrome or Edge with SpeechRecognition support."
      : !enabled
        ? "Voice wake is off."
        : status,
  };
}
