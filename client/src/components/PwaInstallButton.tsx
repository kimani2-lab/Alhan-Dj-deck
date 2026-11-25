"use client";

import { Download } from "lucide-react";
import { useEffect, useState } from "react";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export default function PwaInstallButton() {
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(null);
  const [iosInstructions, setIosInstructions] = useState(false);

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
      await promptEvent.userChoice;
      setPromptEvent(null);
      return;
    }
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIos) setIosInstructions(true);
  };

  return (
    <>
      <button type="button" className="browser-toggle pwa-install-button" onClick={() => void install()}>
        <Download size={15} /> Install App
      </button>
      {iosInstructions && (
        <div className="pwa-ios-popover" role="dialog" aria-label="Install ALHAN DJ">
          <b>Install on iOS</b>
          <span>Tap Share, then choose “Add to Home Screen”.</span>
          <button type="button" onClick={() => setIosInstructions(false)}>Close</button>
        </div>
      )}
    </>
  );
}
