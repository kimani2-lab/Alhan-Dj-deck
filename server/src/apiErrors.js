const ERROR_DETAILS = {
  TRACK_UNAVAILABLE: {
    status: 422,
    message: "This track is unavailable on YouTube. Try another track.",
    retryable: false,
  },
  UPSTREAM_TIMEOUT: {
    status: 504,
    message: "The audio service took too long to respond. Please try again.",
    retryable: true,
  },
  UPSTREAM_RATE_LIMITED: {
    status: 503,
    message: "YouTube is temporarily limiting requests. Please try again later.",
    retryable: true,
  },
  DOWNLOAD_FAILED: {
    status: 502,
    message: "The audio download failed. Please try again.",
    retryable: true,
  },
  INVALID_REQUEST: {
    status: 400,
    message: "Please provide a valid track or search query.",
    retryable: false,
  },
  INTERNAL_ERROR: {
    status: 500,
    message: "Something went wrong on the audio server. Please try again.",
    retryable: true,
  },
};

export function createAudioError(code) {
  const error = new Error(ERROR_DETAILS[code]?.message ?? ERROR_DETAILS.INTERNAL_ERROR.message);
  error.code = ERROR_DETAILS[code] ? code : "INTERNAL_ERROR";
  return error;
}

const CLIENT_ABORT_CODES = new Set([
  "ERR_STREAM_PREMATURE_CLOSE",
  "ECONNRESET",
  "ABORT_ERR",
]);

export function isClientAbortError(error, request, response) {
  if (request?.aborted) return true;
  if (response?.destroyed && !response?.writableEnded) return true;

  const code = error?.code;
  if (typeof code === "string" && CLIENT_ABORT_CODES.has(code)) return true;
  if (error?.name === "AbortError") return true;

  return false;
}

export function classifyAudioError(error) {
  const message =
    error instanceof Error
      ? `${error.message}\n${error.stderr ?? ""}`
      : String(error ?? "");
  const normalizedMessage = message.toLowerCase();
  let code = error?.code;

  if (!ERROR_DETAILS[code]) {
    if (
      /requested format is not available|video.{0,30}(?:unavailable|not available)|(?:unavailable|not available).{0,30}video|has been removed|private video|members-only/i.test(
        message,
      )
    ) {
      code = "TRACK_UNAVAILABLE";
    } else if (/timed?\s*out|timeout|aborterror|aborted/i.test(normalizedMessage)) {
      code = "UPSTREAM_TIMEOUT";
    } else if (
      /sign in to confirm|bot.check|captcha|rate.limit|too many requests|http error 429|http 429|cookie.*(?:required|invalid|expired)|(?:required|invalid|expired).*cookie|http error 403|http 403/i.test(
        message,
      )
    ) {
      code = "UPSTREAM_RATE_LIMITED";
    } else if (/ffmpeg|conversion|convert(?:ing)?|download failed|failed to download/i.test(message)) {
      code = "DOWNLOAD_FAILED";
    } else if (error?.status === 400 || error?.type === "entity.parse.failed") {
      code = "INVALID_REQUEST";
    } else {
      code = "INTERNAL_ERROR";
    }
  }

  const details = ERROR_DETAILS[code];
  return {
    status: details.status,
    body: {
      ok: false,
      error: {
        code,
        message: details.message,
        retryable: details.retryable,
      },
    },
  };
}

function getRawErrorDetails(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      stderr: error.stderr,
      videoId: error.videoId,
    };
  }
  return { value: error };
}

export function audioErrorMiddleware(error, request, response, _next) {
  if (isClientAbortError(error, request, response)) {
    if (!response.destroyed && !response.writableEnded) response.destroy();
    return;
  }

  const videoId =
    error?.videoId ??
    request.params?.videoId ??
    request.params?.id ??
    request.query?.id ??
    request.body?.videoId ??
    request.body?.id;
  console.error("[api] request failed", {
    method: request.method,
    path: request.originalUrl,
    videoId,
    error: getRawErrorDetails(error),
  });

  if (response.headersSent) {
    if (!response.destroyed) response.end();
    return;
  }

  const classified = classifyAudioError(error);
  response
    .status(classified.status)
    .type("application/json")
    .json(classified.body);
}
