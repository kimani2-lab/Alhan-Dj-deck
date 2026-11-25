# Alhan DJ

A browser-based dual-deck DJ console with local audio loading, YouTube search/streaming, per-deck EQ and filter, cue pads, pitch controls, crossfader, and 8D spatial effects. An integrated AI DJ assistant can play a requested song/vibe, toggle 8D/Bass Boost, and turn a DJ's ordered setlist into a staged high-vibe progression.

## Setup

Use Node.js 20.9 or newer. This repository already contains the `client` and `server` workspaces; run commands from the repository root rather than scaffolding another nested `alhan-dj` folder.

The audio API uses the `yt-dlp` command-line executable. On Windows, install it with:

```powershell
py -m pip install --upgrade yt-dlp
py -m yt_dlp --version
```

The server can run yt-dlp through Python even when its executable folder is not on `PATH`. If you installed a standalone executable, set `YT_DLP_PATH` to its full path. MP3 extraction also requires `ffmpeg` on `PATH`. Audio files are fetched only in response to a user search or load action; follow the source platform's terms and applicable copyright rules.

## Run

```powershell
# Run from the repository root.
npm install
npm run dev
```

The Next.js app runs at `http://localhost:3000`; the Express API runs at `http://localhost:5000`. Set `FRONTEND_URL` for a non-localhost client origin and `PORT` if needed; update `NEXT_PUBLIC_API_URL` in the client if the API host or port changes.

### AI DJ (Gemini)

`POST /api/ai-dj` uses Gemini structured outputs when `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) is set. Export it in the shell that starts the server:

```powershell
$env:GEMINI_API_KEY = "your-api-key"
$env:GEMINI_MODEL = "gemini-2.5-flash" # optional
npm run dev
```

Without a key, the route automatically falls back to a deterministic local planner so the UI still works. The endpoint accepts:

```json
{
  "message": "play Alone by Alan Walker with 8D on and bass boost",
  "orderedTracks": ["Alone - Alan Walker", "Levels - Avicii"],
  "includeBridges": true,
  "workflow": "vibe"
}
```

`workflow` is optional (`"vibe"` or `"setlist"`); supplying `orderedTracks` forces the `high_vibe_set` workflow. The response is a structured action:

- `{ "action": { "type": "play_request", "query", "enable8d", "bassBoost" }, "reply": "..." }`
- `{ "action": { "type": "high_vibe_set", "title", "vibe", "steps": [{ "order", "track", "stage", "energy", "vibe", "tip", "transition", "enable8d", "bassBoost", "bridge", "followUp" }] }, "reply": "..." }`

When the DJ supplies an ordered list, the server enforces the exact input order and one step per track even if the model returns something different. ALHAN starts listening for its wake word when the app loads; allow microphone access in the browser. Wake-word listening works while this app is open, not as a system-wide assistant when the tab is closed or in the background.

To check the project:

```powershell
npm run lint
npm run build
npm test
```

## Audio engine

`client/src/lib/audio/Deck.ts` encapsulates each deck's source, transport, 3-band EQ, filter, HRTF panner, generated stereo hall impulse response, spatial LFO, channel gain, cue state, and optional pad input. Hall 8D blends a clear dry path with a binaural orbit and convolved hall return. `MixerEngine.ts` owns both decks, the constant-power crossfader, a dedicated beat-pad bus, and master gain. `BeatPadEngine.ts` synthesizes eight one-shot sounds and creates a fresh buffer source per hit for polyphonic retriggering. `AudioEngine.ts` is the public export surface. React controls call these classes directly; waveform and transport UI state is sampled separately from the audio graph.

Hot cues are set on first press and jump to their stored positions on later presses; the performance-pad Hot Cues mode provides eight cue slots. BPM is user-editable; Sync matches the entered BPM values within the supported ±16% pitch range.

The PADS control opens the performance pad in DJ and 8D Music modes. Drums/Samples uses pointer pressure for velocity and supports hold-to-retrigger; Hot Cues, beat-grid loops, and momentary/toggle 8D effects use the selected deck. Pads can route directly to the master bus or through the selected deck's FX chain.

## 8D music mode

The header mode switch changes only the rendered view; the shared `MixerEngine` and Deck A remain mounted, so playback continues across DJ and 8D Music modes. At natural track end, Deck A automatically starts the next unplayed recommendation from the ranked ecosystem queue; AI-ordered sets finish in their requested order before recommendations resume. Recommendations favor the seed artist, filter duplicate and played tracks, and refill as needed. The Hall 8D toggle enables HRTF side-to-side motion and a generated stereo hall convolution; use the rotation, width, and hall-space controls to tune it. Headphones are recommended for binaural positioning. Music mode searches through `GET /api/search?q=...`, shares results with the library drawer, and links to `GET /api/download?id=<videoId>` for an MP3 attachment. MP3 extraction requires both `yt-dlp` and `ffmpeg` on the server `PATH`.
