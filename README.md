# Alhan DJ

A browser-based dual-deck DJ console with local audio loading, YouTube search/streaming, per-deck EQ and filter, cue pads, pitch controls, crossfader, and 8D spatial effects.

## Setup

Use Node.js 20.9 or newer. This repository already contains the `client` and `server` workspaces; run commands from the repository root rather than scaffolding another nested `alhan-dj` folder.

The audio API uses the `yt-dlp` command-line executable. On Windows, install it with:

```powershell
py -m pip install --upgrade yt-dlp
$ytDlpScripts = py -c "import sysconfig; print(sysconfig.get_path('scripts', scheme='nt_user'))"
$env:Path = "$ytDlpScripts;$env:Path"
yt-dlp --version
```

The `PATH` update applies to the current PowerShell session. MP3 extraction also requires `ffmpeg` on `PATH`. Audio files are fetched only in response to a user search or load action; follow the source platform's terms and applicable copyright rules.

## Run

```powershell
# Run from the repository root.
npm install
npm run dev
```

The Next.js app runs at `http://localhost:3000`; the Express API runs at `http://localhost:4000`. Set `CLIENT_ORIGIN` for a non-localhost client origin and `PORT` if needed; update `NEXT_PUBLIC_API_URL` in the client if the API host or port changes.

To check the project:

```powershell
npm run lint
npm run build
```

## Audio engine

`client/src/lib/audio/Deck.ts` encapsulates each deck's source, transport, 3-band EQ, filter, spatial LFO, delay, channel gain, and cue state. `MixerEngine.ts` owns both decks, the constant-power crossfader, and master gain. `AudioEngine.ts` is the public export surface. React controls call these classes directly; waveform and transport UI state is sampled separately from the audio graph.

Hot cues are set on first press and jump to their stored positions on later presses. BPM is user-editable; Sync matches the entered BPM values within the supported ±16% pitch range.

## 8D music mode

The header mode switch changes only the rendered view; the shared `MixerEngine` and Deck A remain mounted, so playback continues across DJ and 8D Music modes. Music mode searches through `GET /api/search?q=...`, shares results with the library drawer, and links to `GET /api/download?id=<videoId>` for an MP3 attachment. MP3 extraction requires both `yt-dlp` and `ffmpeg` on the server `PATH`.
