"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TrackResult } from "../lib/tracks";

export type AlhanVoiceState =
  | "WAKE_LISTENING"
  | "AWAITING_COMMAND"
  | "EXECUTING";

type SpeechRecognitionResultLike = ArrayLike<{ transcript: string }> & {
  isFinal?: boolean;
};

type SpeechRecognitionEventLike = {
  results: ArrayLike<SpeechRecognitionResultLike>;
};

type SpeechRecognitionErrorLike = { error: string };

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onstart: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort?: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

type UseAlhanVoiceAssistantOptions = {
  active: boolean;
  searchTracks: (query: string) => Promise<TrackResult[]>;
  onPlayTrack: (track: TrackResult) => Promise<boolean>;
  onDuckVolume?: () => void;
  onRestoreVolume?: () => void;
  onCommand?: (query: string) => void;
  onError?: (message: string) => void;
};

const WAKE_WORD_PATTERN = /\b(?:al[\s-]*han|all?an|alham)\b/i;
const WAKE_WORD_REPLACE = /\b(?:al[\s-]*han|all?an|alham)\b/gi;
const COMMAND_PREFIX =
  /^(?:please\s+)?(?:can you\s+|could you\s+)?(?:play|search for|search|find|put on)\s+/i;
const RESTART_DELAY_MS = 250;

function cleanCommand(value: string): string {
  return value
    .replace(COMMAND_PREFIX, "")
    .replace(/^(?:the\s+)?(?:song|track|music)\s+/i, "")
    .replace(/^[\s,.:;-]+|[\s,.:;!?-]+$/g, "")
    .trim();
}

export function useAlhanVoiceAssistant({
  active,
  searchTracks,
  onPlayTrack,
  onDuckVolume,
  onRestoreVolume,
  onCommand,
  onError,
}: UseAlhanVoiceAssistantOptions) {
  const [supported, setSupported] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [listening, setListening] = useState(false);
  const [state, setState] = useState<AlhanVoiceState>("WAKE_LISTENING");
  const [status, setStatus] = useState('Say "Alhan" to wake me.');

  const optionsRef = useRef({
    searchTracks,
    onPlayTrack,
    onDuckVolume,
    onRestoreVolume,
    onCommand,
    onError,
  });
  optionsRef.current = {
    searchTracks,
    onPlayTrack,
    onDuckVolume,
    onRestoreVolume,
    onCommand,
    onError,
  };

  const enabledRef = useRef(false);
  const stateRef = useRef<AlhanVoiceState>("WAKE_LISTENING");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const recognitionConstructorRef =
    useRef<SpeechRecognitionConstructor | null>(null);
  const restartTimerRef = useRef<number | null>(null);
  const speechPausedRef = useRef(false);
  const executingRef = useRef(false);
  const duckedRef = useRef(false);
  const startRecognitionRef = useRef<() => void>(() => {});
  const mountedRef = useRef(true);

  const updateState = useCallback((next: AlhanVoiceState) => {
    stateRef.current = next;
    if (mountedRef.current) setState(next);
  }, []);

  const updateStatus = useCallback((message: string) => {
    if (mountedRef.current) setStatus(message);
  }, []);

  const duckVolume = useCallback(() => {
    if (duckedRef.current) return;
    duckedRef.current = true;
    optionsRef.current.onDuckVolume?.();
  }, []);

  const restoreVolume = useCallback(() => {
    if (!duckedRef.current) return;
    duckedRef.current = false;
    optionsRef.current.onRestoreVolume?.();
  }, []);

  const stopRecognition = useCallback(() => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      recognition.abort?.();
    } catch {
      // Some browsers only support stop().
    }
    try {
      recognition.stop();
    } catch {
      // The recognizer may already be stopped.
    }
    if (mountedRef.current) setListening(false);
  }, []);

  const scheduleRestart = useCallback((delay = RESTART_DELAY_MS) => {
    if (typeof window === "undefined") return;
    if (restartTimerRef.current !== null) {
      window.clearTimeout(restartTimerRef.current);
    }
    restartTimerRef.current = window.setTimeout(() => {
      restartTimerRef.current = null;
      if (!enabledRef.current || speechPausedRef.current || executingRef.current) {
        return;
      }
      startRecognitionRef.current();
    }, delay);
  }, []);

  const speak = useCallback((message: string, onDone: () => void) => {
    if (
      typeof window === "undefined" ||
      !("speechSynthesis" in window) ||
      typeof SpeechSynthesisUtterance === "undefined"
    ) {
      onDone();
      return;
    }

    const synthesis = window.speechSynthesis;
    try {
      synthesis.cancel();
    } catch {
      // Ignore synthesis cancellation errors.
    }

    const utterance = new SpeechSynthesisUtterance(message);
    utterance.lang = navigator.language || "en-US";
    let finished = false;
    let fallbackTimer = 0;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(fallbackTimer);
      onDone();
    };

    fallbackTimer = window.setTimeout(
      finish,
      Math.max(2_500, message.length * 90),
    );
    utterance.onend = finish;
    utterance.onerror = finish;
    try {
      synthesis.speak(utterance);
    } catch {
      finish();
    }
  }, []);

  const handleCommand = useCallback(
    (rawRequest: string) => {
      const request = cleanCommand(rawRequest);
      if (!request) {
        updateStatus("Listening for song...");
        scheduleRestart();
        return;
      }
      if (executingRef.current) return;

      executingRef.current = true;
      updateState("EXECUTING");
      updateStatus(`Okay. Searching for "${request}"...`);
      stopRecognition();
      speechPausedRef.current = true;
      optionsRef.current.onCommand?.(request);
      duckVolume();

      speak("Okay", async () => {
        try {
          const tracks = await optionsRef.current.searchTracks(request);
          const track = tracks[0];
          if (!track) {
            throw new Error(`I couldn't find "${request}" on YouTube.`);
          }
          updateStatus(`Playing "${track.title}"...`);
          const started = await optionsRef.current.onPlayTrack(track);
          if (!started) {
            throw new Error(
              `I found "${track.title}", but couldn't start playback.`,
            );
          }
          updateStatus(`Playing "${track.title}".`);
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "I couldn't play that request.";
          optionsRef.current.onError?.(message);
          updateStatus(message);
        } finally {
          restoreVolume();
          executingRef.current = false;
          speechPausedRef.current = false;
          updateState("WAKE_LISTENING");
          if (enabledRef.current) {
            updateStatus('Listening for "Alhan"...');
            scheduleRestart();
          }
        }
      });
    },
    [
      duckVolume,
      restoreVolume,
      scheduleRestart,
      speak,
      stopRecognition,
      updateState,
      updateStatus,
    ],
  );

  const handleWake = useCallback(() => {
    if (stateRef.current !== "WAKE_LISTENING") return;

    updateStatus("Yes, how may I help you?");
    stopRecognition();
    speechPausedRef.current = true;
    duckVolume();

    speak("Yes, how may I help you?", () => {
      if (!enabledRef.current) {
        restoreVolume();
        speechPausedRef.current = false;
        return;
      }
      updateState("AWAITING_COMMAND");
      updateStatus("Listening for song...");
      speechPausedRef.current = false;
      scheduleRestart();
    });
  }, [
    duckVolume,
    restoreVolume,
    scheduleRestart,
    speak,
    stopRecognition,
    updateState,
    updateStatus,
  ]);

  const handleResult = useCallback(
    (event: SpeechRecognitionEventLike) => {
      const result = event.results[event.results.length - 1];
      if (!result || result.isFinal === false) return;
      const transcript = result[0]?.transcript?.trim();
      if (!transcript) return;

      const hasWakeWord = WAKE_WORD_PATTERN.test(transcript);
      const withoutWakeWord = transcript.replace(WAKE_WORD_REPLACE, " ").trim();

      if (stateRef.current === "WAKE_LISTENING") {
        if (!hasWakeWord) return;
        const inlineCommand = cleanCommand(withoutWakeWord);
        if (inlineCommand) {
          handleCommand(inlineCommand);
          return;
        }
        handleWake();
        return;
      }

      if (stateRef.current === "AWAITING_COMMAND") {
        const request = cleanCommand(
          hasWakeWord ? withoutWakeWord : transcript,
        );
        if (request) {
          handleCommand(request);
        } else {
          updateStatus("Listening for song...");
        }
      }
    },
    [handleCommand, handleWake, updateStatus],
  );

  const startRecognition = useCallback(() => {
    if (typeof window === "undefined") return;
    if (
      !enabledRef.current ||
      speechPausedRef.current ||
      executingRef.current ||
      recognitionRef.current
    ) {
      return;
    }

    const Recognition = recognitionConstructorRef.current;
    if (!Recognition) return;

    const recognition = new Recognition();
    recognition.lang = navigator.language || "en-US";
    recognition.continuous = true;
    recognition.interimResults = false;

    recognition.onstart = () => {
      if (!enabledRef.current) return;
      if (mountedRef.current) setListening(true);
      updateStatus(
        stateRef.current === "AWAITING_COMMAND"
          ? "Listening for song..."
          : 'Listening for "Alhan"...',
      );
    };

    recognition.onresult = handleResult;

    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      const needsPermission =
        event.error === "not-allowed" ||
        event.error === "service-not-allowed";
      const missingMicrophone = event.error === "audio-capture";
      const message = needsPermission
        ? "Microphone access was denied. Allow it for this site, then toggle Voice Wake back on."
        : missingMicrophone
          ? "No microphone was detected. Connect a microphone and try again."
          : `Voice recognition was interrupted${
              event.error ? ` (${event.error})` : ""
            }. Restarting...`;

      if (needsPermission || missingMicrophone) {
        enabledRef.current = false;
        if (mountedRef.current) setEnabled(false);
        stopRecognition();
      }
      optionsRef.current.onError?.(message);
      updateStatus(message);
    };

    recognition.onend = () => {
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
      }
      if (mountedRef.current) setListening(false);
      if (!enabledRef.current) return;
      if (speechPausedRef.current || executingRef.current) return;
      scheduleRestart();
    };

    recognitionRef.current = recognition;
    if (mountedRef.current) setListening(true);
    try {
      recognition.start();
    } catch (reason) {
      recognitionRef.current = null;
      if (mountedRef.current) setListening(false);
      const message =
        reason instanceof Error ? reason.message : "Could not start voice input.";
      optionsRef.current.onError?.(message);
      updateStatus(message);
    }
  }, [handleResult, scheduleRestart, stopRecognition, updateStatus]);

  useEffect(() => {
    startRecognitionRef.current = startRecognition;
  }, [startRecognition]);

  const disable = useCallback(() => {
    enabledRef.current = false;
    if (mountedRef.current) setEnabled(false);
    if (restartTimerRef.current !== null) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    speechPausedRef.current = false;
    executingRef.current = false;
    stopRecognition();
    if ("speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore synthesis cancellation errors.
      }
    }
    restoreVolume();
    updateState("WAKE_LISTENING");
    updateStatus("Voice Wake is off.");
  }, [restoreVolume, stopRecognition, updateState, updateStatus]);

  const enable = useCallback(() => {
    if (!recognitionConstructorRef.current) {
      const message =
        "Voice control isn't supported in this browser. Try Chrome or Edge.";
      if (mountedRef.current) setSupported(false);
      updateStatus(message);
      optionsRef.current.onError?.(message);
      return;
    }
    enabledRef.current = true;
    if (mountedRef.current) setEnabled(true);
    updateState("WAKE_LISTENING");
    updateStatus('Listening for "Alhan"...');
    startRecognitionRef.current();
  }, [updateState, updateStatus]);

  const toggle = useCallback(() => {
    if (enabledRef.current) disable();
    else enable();
  }, [disable, enable]);

  useEffect(() => {
    const speechWindow = window as SpeechRecognitionWindow;
    const Recognition =
      speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!Recognition) {
      const timer = window.setTimeout(() => {
        if (!mountedRef.current) return;
        setSupported(false);
        setStatus(
          "Voice control isn't supported in this browser. Try Chrome or Edge.",
        );
      }, 0);
      return () => window.clearTimeout(timer);
    }
    recognitionConstructorRef.current = Recognition;
    return undefined;
  }, []);

  useEffect(() => {
    if (active) return;
    const timer = window.setTimeout(() => disable(), 0);
    return () => window.clearTimeout(timer);
  }, [active, disable]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      enabledRef.current = false;
      if (restartTimerRef.current !== null) {
        window.clearTimeout(restartTimerRef.current);
      }
      stopRecognition();
      if ("speechSynthesis" in window) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          // Ignore synthesis cancellation errors.
        }
      }
      if (duckedRef.current) {
        duckedRef.current = false;
        optionsRef.current.onRestoreVolume?.();
      }
    };
  }, [stopRecognition]);

  return {
    supported,
    enabled,
    listening,
    state,
    status,
    enable,
    disable,
    toggle,
  };
}
