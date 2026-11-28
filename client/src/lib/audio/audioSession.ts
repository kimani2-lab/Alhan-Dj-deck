const SILENT_WAV_DATA_URL =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

const RESUME_THROTTLE_MS = 500;

type AudioSessionNavigator = Navigator & {
  audioSession?: { type?: string };
};

const lastResumeAttempt = new WeakMap<AudioContext, number>();
const unlockCleanups = new WeakMap<AudioContext, () => void>();
let silentAudio: HTMLAudioElement | null = null;
let mediaUnlockPending = false;
let mediaUnlocked = false;

function ensurePlaybackAudioSession(): void {
  if (typeof navigator === "undefined") return;
  const audioSession = (navigator as AudioSessionNavigator).audioSession;
  if (!audioSession) return;
  try {
    if (audioSession.type !== "playback") audioSession.type = "playback";
  } catch {
    // Some browsers expose audioSession as read-only.
  }
}

export async function resumeAudioContext(
  context: AudioContext | null | undefined,
): Promise<void> {
  if (!context || context.state === "closed") return;
  ensurePlaybackAudioSession();
  if (context.state === "running") return;

  const now = Date.now();
  const lastAttempt = lastResumeAttempt.get(context) ?? 0;
  if (now - lastAttempt < RESUME_THROTTLE_MS) return;
  lastResumeAttempt.set(context, now);

  try {
    await context.resume();
  } catch {
    // The browser may reject resume until the next user gesture.
  }
  ensurePlaybackAudioSession();
}

export function unlockMediaPlayback(): void {
  if (typeof window === "undefined" || mediaUnlocked || mediaUnlockPending) {
    return;
  }

  try {
    if (!silentAudio) {
      silentAudio = new Audio();
      silentAudio.src = SILENT_WAV_DATA_URL;
      silentAudio.preload = "auto";
      silentAudio.volume = 0;
      silentAudio.setAttribute("playsinline", "true");
      silentAudio.setAttribute("webkit-playsinline", "true");
    }
    silentAudio.currentTime = 0;
    mediaUnlockPending = true;
    const playback = silentAudio.play();
    if (!playback) {
      mediaUnlockPending = false;
      return;
    }
    void playback
      .then(() => {
        mediaUnlocked = true;
      })
      .catch(() => {
        mediaUnlockPending = false;
      })
      .finally(() => {
        mediaUnlockPending = false;
      });
  } catch {
    mediaUnlockPending = false;
  }
}

export function installAudioUnlockHandlers(
  context: AudioContext,
): () => void {
  if (
    typeof window === "undefined" ||
    typeof document === "undefined"
  ) {
    return () => {};
  }
  const existingCleanup = unlockCleanups.get(context);
  if (existingCleanup) return existingCleanup;

  const unlock = () => {
    ensurePlaybackAudioSession();
    void resumeAudioContext(context);
    unlockMediaPlayback();
  };

  for (const eventName of [
    "pointerdown",
    "touchstart",
    "touchend",
    "keydown",
    "click",
  ]) {
    window.addEventListener(eventName, unlock, {
      capture: true,
      passive: true,
    });
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") unlock();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pageshow", unlock);
  window.addEventListener("focus", unlock);

  const cleanup = () => {
    for (const eventName of [
      "pointerdown",
      "touchstart",
      "touchend",
      "keydown",
      "click",
    ]) {
      window.removeEventListener(eventName, unlock, true);
    }
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pageshow", unlock);
    window.removeEventListener("focus", unlock);
    unlockCleanups.delete(context);
  };
  unlockCleanups.set(context, cleanup);
  return cleanup;
}

export function attachMediaElementToDocument(element: HTMLAudioElement): void {
  if (typeof document === "undefined" || !document.body) return;
  element.setAttribute("playsinline", "true");
  element.setAttribute("webkit-playsinline", "true");
  if (element.isConnected) return;
  element.style.position = "fixed";
  element.style.width = "1px";
  element.style.height = "1px";
  element.style.opacity = "0";
  element.style.pointerEvents = "none";
  element.style.overflow = "hidden";
  element.setAttribute("aria-hidden", "true");
  document.body.appendChild(element);
}

export function detachMediaElementFromDocument(
  element: HTMLAudioElement | null,
): void {
  if (!element || typeof document === "undefined") return;
  try {
    element.remove();
  } catch {
    // The element may already have been removed.
  }
}
