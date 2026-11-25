const STAGES = ["build", "peak", "drive", "lift"];
const MAX_TRACKS = 30;
const MAX_MESSAGE_LENGTH = 1_500;
const MAX_TRACK_LENGTH = 200;
const MAX_FIELD_LENGTH = 240;

const STAGE_META = {
  build: {
    vibe: "Tension rising · room warming up",
    tip: "Open with a long blend, keep the groove patient, and let the 8D field widen slowly.",
    transition: "Low-pass sweep into the next intro; raise 8D width as the filter opens.",
    enable8d: true,
    bassBoost: false,
  },
  drive: {
    vibe: "Momentum locked · bodies moving",
    tip: "Keep the kick steady and use short bass cuts before the next drop to add punch.",
    transition: "Cut the lows for one bar, then slam the bass boost back in on the downbeat.",
    enable8d: false,
    bassBoost: true,
  },
  peak: {
    vibe: "Peak time · maximum release",
    tip: "Ride the biggest drop of the night; keep the top end clean and the bass full.",
    transition: "Hot-swap on the drop or use a filtered loop to extend the peak without losing energy.",
    enable8d: true,
    bassBoost: true,
  },
  lift: {
    vibe: "Euphoric lift · hands in the air",
    tip: "Open the filters, let the vocal or lead breathe, and glide out with a wide 8D tail.",
    transition: "Open the high-pass gradually and crossfade into a brighter, uplifting follow-up.",
    enable8d: true,
    bassBoost: false,
  },
};

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    actionType: {
      type: "STRING",
      enum: ["play_request", "high_vibe_set"],
    },
    reply: { type: "STRING" },
    playRequest: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING" },
        enable8d: { type: "BOOLEAN" },
        bassBoost: { type: "BOOLEAN" },
      },
      required: ["query"],
    },
    set: {
      type: "OBJECT",
      properties: {
        title: { type: "STRING" },
        vibe: { type: "STRING" },
        steps: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              track: { type: "STRING" },
              stage: { type: "STRING", enum: STAGES },
              energy: { type: "INTEGER" },
              vibe: { type: "STRING" },
              tip: { type: "STRING" },
              transition: { type: "STRING" },
              enable8d: { type: "BOOLEAN" },
              bassBoost: { type: "BOOLEAN" },
              bridge: { type: "STRING" },
              followUp: { type: "STRING" },
            },
            required: [
              "track",
              "stage",
              "energy",
              "vibe",
              "tip",
              "transition",
              "enable8d",
              "bassBoost",
            ],
          },
        },
      },
      required: ["title", "vibe", "steps"],
    },
  },
  required: ["actionType", "reply"],
};

const SYSTEM_INSTRUCTION = `You are ALHAN AI DJ, a confident club and radio DJ assistant for a dual-deck web player.

Return only a JSON object that matches the provided response schema.

For a play_request:
- Put a clean YouTube search string in playRequest.query (song title plus artist when known).
- Treat "ALHAN" as the assistant's wake word, not part of the song title or artist query. Remove greetings and polite filler.
- Set enable8d and bassBoost from the user's request.
- Write a short, hype reply (one or two sentences).

For a high_vibe_set:
- When orderedTracks are supplied, you MUST keep the exact order and return exactly one step per supplied track. The step.track value must match the supplied string verbatim.
- Classify every step with one stage: build, peak, drive, or lift. build is the patient warm-up, drive keeps momentum, peak is the highest release, lift is the euphoric/open-air section.
- Assign an integer energy from 1 to 10 and a short vibe description.
- Give practical DJ guidance in tip and transition. Mention 8D/Bass Boost cues when useful.
- Set enable8d and bassBoost per step to reflect the vibe.
- If bridge/follow-up suggestions are requested, use the bridge and followUp fields for short, searchable track ideas. Otherwise use empty strings.
- Write a concise, high-energy reply summarizing the arc and naming the peak track.
- If no orderedTracks are supplied, build a sensible high-vibe progression from the user's prompt.

Never wrap the JSON in markdown fences.`;

const asString = (value, fallback = "", maxLength = MAX_FIELD_LENGTH) => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, maxLength);
};

const asBoolean = (value, fallback) =>
  typeof value === "boolean" ? value : fallback;

const asEnergy = (value, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(10, Math.max(1, Math.round(number)));
};

const normalizeStage = (value, fallback) => {
  const stage = typeof value === "string" ? value.trim().toLowerCase() : "";
  return STAGES.includes(stage) ? stage : fallback;
};

function pickStage(index, total) {
  if (total <= 1) return "peak";
  if (total === 2) return index === 0 ? "build" : "peak";
  const progress = index / (total - 1);
  if (progress < 0.25) return "build";
  if (progress < 0.5) return "drive";
  if (progress < 0.8) return "peak";
  return "lift";
}

function energyForStage(stage, index, total) {
  const base = { build: 5, drive: 7, peak: 10, lift: 8 };
  const progress = total > 1 ? index / (total - 1) : 1;
  const curve = Math.round((progress - 0.65) * 2);
  return Math.min(10, Math.max(1, base[stage] + curve));
}

function classifyWorkflow(message, orderedTracks, requestedWorkflow) {
  if (requestedWorkflow === "setlist") return "setlist";
  if (requestedWorkflow === "vibe") return "vibe";
  if (orderedTracks.length > 0) return "setlist";
  if (
    /\b(setlist|set list|high[- ]?vibe|playlist|progression|sequence|ordered|in this exact order|build (?:me )?a (?:set|mix)|make (?:this|it) a .*set)\b/i.test(
      message,
    )
  ) {
    return "setlist";
  }
  return "vibe";
}

export function extractPlayQuery(message) {
  const quoted = message.match(/["“'']([^"”'']{2,})["”'']/);
  if (quoted?.[1]) return quoted[1].trim();

  const withoutEffects = message
    .replace(/^\s*(?:(?:hey|hello|hi)\s+)?(?:alhan|alham)\b[\s,:-]*/i, " ")
    .replace(/\b(?:please|kindly|for me|to me|for us|for myself)\b/gi, " ")
    .replace(/\b(?:can|could|would) you\b/gi, " ")
    .replace(
      /\b(?:with|and|enable|turn on|turn off|add)\b[\s\w,-]*\b(?:8d|spatial|surround|bass(?: boost)?|sub)\b(?:\s+(?:on|off|enabled|disabled))?/gi,
      " ",
    )
    .replace(
      /\b(?:8d|spatial|surround|bass(?: boost)?|sub)(?:\s+(?:on|off|enabled|disabled))?\b/gi,
      " ",
    )
    .replace(
      /^\s*(?:play|put on|load|queue|spin|drop|find|search for|add)(?:\s+me)?\b/gi,
      " ",
    )
    .replace(/^\s*(?:for me|me|for us)\b/gi, " ")
    .replace(/\s+\b(?:thank you|thanks|thank)\b[.!?]*$/i, " ")
    .replace(/\s+/g, " ")
    .replace(/^[,:\-–—\s]+|[?.!,;:]+$/g, "")
    .trim();

  return withoutEffects || message.trim();
}

function fallbackPlayRequest(message) {
  const enable8d = /\b8d\b|spatial|surround|orbit/i.test(message);
  const bassBoost = /\bbass(?: boost)?\b|\bsub\b|low end/i.test(message);
  const query = extractPlayQuery(message) || "high energy dj mix";
  const fx = [
    enable8d ? "the 8D field wide open" : "",
    bassBoost ? "the low end boosted" : "",
  ].filter(Boolean);
  return {
    actionType: "play_request",
    reply: `Locked in — cueing “${query}”${fx.length ? ` with ${fx.join(" and ")}` : ""}. Load it and let it ride.`,
    playRequest: { query, enable8d, bassBoost },
  };
}

function preferredTasteSeed({ message, selectedGenres, genreAffinities }) {
  const affinityEntries = Object.entries(genreAffinities)
    .filter(([, score]) => typeof score === "number" && score >= 2)
    .sort((left, right) => right[1] - left[1]);
  const strongestAffinity = affinityEntries[0]?.[0];
  const selected = selectedGenres[0];
  if (strongestAffinity) return strongestAffinity;
  if (selected) return selected;
  return message || "high energy";
}

function fallbackHighVibeSet({
  message,
  orderedTracks,
  includeBridges,
  selectedGenres = [],
  genreAffinities = {},
}) {
  let tracks = orderedTracks;
  if (tracks.length === 0) {
    const cleanedPrompt = message
      .replace(
        /\b(make|build|create|give|me|a|an|this|high|vibe|set|setlist|in|exact|order|please|for|the|my)\b/gi,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim();
    const seed = cleanedPrompt
      ? cleanedPrompt
      : preferredTasteSeed({ message, selectedGenres, genreAffinities });
    tracks = [
      `${seed} warm up`,
      `${seed} peak time`,
      `${seed} euphoric closer`,
    ];
  }

  const total = tracks.length;
  const steps = tracks.map((track, index) => {
    const stage = pickStage(index, total);
    const meta = STAGE_META[stage];
    const next = tracks[index + 1] ?? null;
    return {
      track,
      stage,
      energy: energyForStage(stage, index, total),
      vibe: meta.vibe,
      tip: meta.tip,
      transition: meta.transition,
      enable8d: meta.enable8d,
      bassBoost: meta.bassBoost,
      bridge: includeBridges
        ? next
          ? `Bridge idea: loop the outro of “${track}” under the intro of “${next}”.`
          : `Bridge idea: extend “${track}” with an 8-bar 8D pad tail.`
        : "",
      followUp: includeBridges
        ? next
          ? `${next} — extended mix`
          : `${track} — extended mix`
        : "",
    };
  });
  const peak = steps.reduce(
    (best, step) => (step.energy > best.energy ? step : best),
    steps[0],
  );

  return {
    actionType: "high_vibe_set",
    reply: `Built a ${total}-track high-vibe arc in your exact order. The peak lands on “${peak.track}” — keep the sequence and ride the stage cues.`,
    set: {
      title: "High Vibe Set",
      vibe: "A staged build through tension, drive, peak, and euphoric lift.",
      steps,
    },
  };
}

function normalizePlayRequest(payload, message) {
  const fallback = fallbackPlayRequest(message);
  const query =
    extractPlayQuery(
      asString(payload?.playRequest?.query, fallback.playRequest.query),
    ) || fallback.playRequest.query;
  return {
    action: {
      type: "play_request",
      query,
      enable8d: asBoolean(
        payload?.playRequest?.enable8d,
        fallback.playRequest.enable8d,
      ),
      bassBoost: asBoolean(
        payload?.playRequest?.bassBoost,
        fallback.playRequest.bassBoost,
      ),
    },
    reply: asString(payload?.reply, fallback.reply, 400),
  };
}

function normalizeHighVibeSet(
  payload,
  {
    message,
    orderedTracks,
    includeBridges,
    selectedGenres = [],
    genreAffinities = {},
  },
) {
  const fallback = fallbackHighVibeSet({
    message,
    orderedTracks,
    includeBridges,
    selectedGenres,
    genreAffinities,
  });
  const rawSteps = Array.isArray(payload?.set?.steps)
    ? payload.set.steps
    : [];
  const sourceTracks = orderedTracks.length
    ? orderedTracks
    : rawSteps
        .map((step) => asString(step?.track, "", MAX_TRACK_LENGTH))
        .filter(Boolean);

  if (sourceTracks.length === 0) {
    return {
      action: {
        type: "high_vibe_set",
        title: fallback.set.title,
        vibe: fallback.set.vibe,
        steps: fallback.set.steps,
      },
      reply: asString(payload?.reply, fallback.reply, 400),
    };
  }

  const total = sourceTracks.length;
  const steps = sourceTracks.map((track, index) => {
    const raw =
      rawSteps.find(
        (step) =>
          asString(step?.track, "", MAX_TRACK_LENGTH).toLowerCase() ===
          track.toLowerCase(),
      ) ??
      rawSteps[index] ??
      {};
    const stage = normalizeStage(raw?.stage, pickStage(index, total));
    const meta = STAGE_META[stage];
    const next = sourceTracks[index + 1] ?? null;
    return {
      order: index + 1,
      track,
      stage,
      energy: asEnergy(raw?.energy, energyForStage(stage, index, total)),
      vibe: asString(raw?.vibe, meta.vibe),
      tip: asString(raw?.tip, meta.tip, 300),
      transition: asString(raw?.transition, meta.transition, 300),
      enable8d: asBoolean(raw?.enable8d, meta.enable8d),
      bassBoost: asBoolean(raw?.bassBoost, meta.bassBoost),
      bridge: includeBridges
        ? asString(
            raw?.bridge,
            next ? `${next} intro loop / bridge tool` : "8D pad bridge lift",
            300,
          )
        : "",
      followUp: includeBridges
        ? asString(
            raw?.followUp,
            next ? `${next} — extended mix` : `${track} — extended mix`,
            300,
          )
        : "",
    };
  });

  return {
    action: {
      type: "high_vibe_set",
      title: asString(payload?.set?.title, fallback.set.title),
      vibe: asString(payload?.set?.vibe, fallback.set.vibe),
      steps,
    },
    reply: asString(payload?.reply, fallback.reply, 400),
  };
}

function normalizePayload(payload, context) {
  if (!payload || typeof payload !== "object") {
    return context.workflow === "setlist"
      ? normalizeHighVibeSet({}, context)
      : normalizePlayRequest({}, context.message);
  }

  const actionType =
    payload.actionType === "high_vibe_set" ? "high_vibe_set" : "play_request";

  if (context.workflow === "setlist" || actionType === "high_vibe_set") {
    return normalizeHighVibeSet(payload, context);
  }
  return normalizePlayRequest(payload, context.message);
}

export function buildPrompt({
  message,
  orderedTracks,
  includeBridges,
  workflow,
  selectedGenres,
  genreAffinities,
  recentSearches,
}) {
  const lines = [];
  if (selectedGenres.length > 0) {
    lines.push(
      `User taste genres: ${selectedGenres.join(", ")}.`,
    );
  }
  const affinityEntries = Object.entries(genreAffinities)
    .filter(([, score]) => typeof score === "number")
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8);
  if (affinityEntries.length > 0) {
    lines.push(
      `Genre affinities by repeat searches/plays (higher means stronger preference): ${affinityEntries
        .map(([genre, score]) => `${genre}=${score}`)
        .join(", ")}.`,
    );
  }
  if (recentSearches.length > 0) {
    lines.push(`Recent searches: ${recentSearches.slice(0, 10).join(" | ")}.`);
  }
  lines.push(
    "Use taste context to personalize recommendations, but always respect the explicit song, artist, vibe, or exact setlist request.",
  );
  if (workflow === "setlist") {
    lines.push("Workflow: high_vibe_set.");
    if (orderedTracks.length > 0) {
      lines.push(
        "The DJ supplied this ordered track list. Keep the exact order and return exactly one step for each track, using the track text verbatim:",
      );
      orderedTracks.forEach((track, index) => {
        lines.push(`${index + 1}. ${track}`);
      });
    } else {
      lines.push("No ordered tracks were supplied. Build a set from the message.");
    }
    lines.push(
      `Complementary bridge/follow-up suggestions requested: ${
        includeBridges ? "yes" : "no"
      }.`,
    );
  } else {
    lines.push("Workflow: play_request.");
    lines.push(
      "Interpret the message as a single song or vibe request and include optional 8D and bass boost switches.",
    );
  }
  lines.push(`User message: ${message || "(not provided)"}`);
  lines.push("Return the JSON object now.");
  return lines.join("\n");
}

function parseJsonResponse(text) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

async function callGemini({
  message,
  orderedTracks,
  includeBridges,
  workflow,
  selectedGenres,
  genreAffinities,
  recentSearches,
}) {
  const apiKey =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    "";
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");

  const model = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: SYSTEM_INSTRUCTION }],
        },
        contents: [
          {
            role: "user",
            parts: [
              {
                text: buildPrompt({
                  message,
                  orderedTracks,
                  includeBridges,
                  workflow,
                  selectedGenres,
                  genreAffinities,
                  recentSearches,
                }),
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 1,
          maxOutputTokens: 4_096,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(
        `Gemini request failed (${response.status})${detail ? `: ${detail}` : "."}`,
      );
    }

    const data = await response.json();
    const parts = data?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts)
      ? parts
          .map((part) => (typeof part?.text === "string" ? part.text : ""))
          .join("")
      : "";
    if (!text.trim()) throw new Error("Gemini returned an empty response.");
    return parseJsonResponse(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function createAiDjResponse({
  message,
  orderedTracks,
  includeBridges,
  workflow,
  selectedGenres,
  genreAffinities,
  recentSearches,
}) {
  const context = {
    message,
    orderedTracks,
    includeBridges,
    workflow,
    selectedGenres,
    genreAffinities,
    recentSearches,
  };
  let payload = null;
  let source = "fallback";
  let model = null;

  try {
    payload = await callGemini(context);
    source = "gemini";
    model = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown error.";
    console.warn(`[ai-dj] Falling back to local planner: ${reason}`);
  }

  const normalized = normalizePayload(payload, context);
  return {
    ...normalized,
    meta: {
      source,
      model,
      degraded: source !== "gemini",
      workflow,
    },
  };
}

export function registerAiDjRoutes(app) {
  app.post("/api/ai-dj", async (request, response) => {
    const body = request.body ?? {};
    const message = asString(body.message, "", MAX_MESSAGE_LENGTH);
    const orderedTracks = Array.isArray(body.orderedTracks)
      ? body.orderedTracks
          .map((track) => asString(track, "", MAX_TRACK_LENGTH))
          .filter(Boolean)
          .slice(0, MAX_TRACKS)
      : [];
    const requestedWorkflow =
      body.workflow === "setlist" || body.workflow === "vibe"
        ? body.workflow
        : undefined;

    if (!message && orderedTracks.length === 0) {
      response.status(400).json({
        error: "Send a message or provide at least one ordered track.",
      });
      return;
    }

    const workflow = classifyWorkflow(
      message,
      orderedTracks,
      requestedWorkflow,
    );
    const includeBridges = body.includeBridges === true;
    const selectedGenres = Array.isArray(body.selectedGenres)
      ? body.selectedGenres
          .filter((genre) => typeof genre === "string")
          .map((genre) => genre.trim().toLowerCase().slice(0, 40))
          .filter(Boolean)
          .slice(0, 12)
      : [];
    const genreAffinities =
      body.genreAffinities && typeof body.genreAffinities === "object"
        ? Object.fromEntries(
            Object.entries(body.genreAffinities)
              .filter(
                ([genre, score]) =>
                  typeof genre === "string" &&
                  typeof score === "number" &&
                  Number.isFinite(score),
              )
              .map(([genre, score]) => [
                genre.trim().toLowerCase().slice(0, 40),
                Math.min(100, Math.max(0, score)),
              ])
              .slice(0, 16),
          )
        : {};
    const recentSearches = Array.isArray(body.recentSearches)
      ? body.recentSearches
          .filter((search) => typeof search === "string")
          .map((search) => search.trim().slice(0, 160))
          .filter(Boolean)
          .slice(0, 10)
      : [];

    try {
      const result = await createAiDjResponse({
        message,
        orderedTracks,
        includeBridges,
        workflow,
        selectedGenres,
        genreAffinities,
        recentSearches,
      });
      response.json(result);
    } catch (error) {
      response.status(502).json({
        error:
          error instanceof Error
            ? error.message
            : "The AI DJ could not build a response.",
      });
    }
  });
}
