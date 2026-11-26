"use client";

import { Download } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

const INSTALLED_STORAGE_KEY = "alhan-dj:pwa-installed";

function getInstalledSnapshot(): boolean {
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (isStandalone) return true;
  try {
    return window.localStorage.getItem(INSTALLED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function subscribeToInstallState(onChange: () => void): () => void {
  const displayMode = window.matchMedia("(display-mode: standalone)");
  const installedHandler = () => {
    try {
      window.localStorage.setItem(INSTALLED_STORAGE_KEY, "true");
    } catch {
      // The standalone display mode still detects installation when storage is unavailable.
    }
    onChange();
  };
  displayMode.addEventListener("change", onChange);
  window.addEventListener("appinstalled", installedHandler);
  window.addEventListener("storage", onChange);
  return () => {
    displayMode.removeEventListener("change", onChange);
    window.removeEventListener("appinstalled", installedHandler);
    window.removeEventListener("storage", onChange);
  };
}

const getServerInstalledSnapshot = () => false;

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export default function PwaInstallButton() {
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(null);
  const [iosInstructions, setIosInstructions] = useState(false);
  const browserReportsInstalled = useSyncExternalStore(
    subscribeToInstallState,
    getInstalledSnapshot,
    getServerInstalledSnapshot,
  );
  const [acceptedInstall, setAcceptedInstall] = useState(false);
  const isInstalled = browserReportsInstalled || acceptedInstall;

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
    const handler = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const install = async () => {
    if (promptEvent) {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      setPromptEvent(null);
      if (choice.outcome === "accepted") {
        setAcceptedInstall(true);
        try {
          window.localStorage.setItem(INSTALLED_STORAGE_KEY, "true");
        } catch (error) {
          console.warn("Could not persist the app installation state.", error);
        }
      }
      return;
    }
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIos) setIosInstructions(true);
  };

  return (
    <>
      {!isInstalled && (
        <button type="button" className="browser-toggle pwa-install-button" onClick={() => void install()}>
          <Download size={15} /> Install App
        </button>
      )}
      {!isInstalled && iosInstructions && (
        <div className="pwa-ios-popover" role="dialog" aria-label="Install ALHAN DJ">
          <b>Install on iOS</b>
          <span>Tap Share, then choose “Add to Home Screen”.</span>
          <button type="button" onClick={() => setIosInstructions(false)}>Close</button>
        </div>
      )}
    </>
  );
}
