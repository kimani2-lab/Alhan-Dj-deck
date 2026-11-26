export const AUDIO_FIRST_FORMAT = "ba[ext=m4a]/ba[ext=webm]/ba/b/best";
export const AUDIO_FALLBACK_FORMAT = "ba/b/best";

export function isRequestedFormatUnavailable(error) {
  return (
    error instanceof Error &&
    /requested format is not available/i.test(error.message)
  );
}

export function buildAudioFormatFallbackArgs(args) {
  const formatIndex = args.findIndex(
    (argument) => argument === "-f" || argument === "--format",
  );
  if (formatIndex < 0 || !args[formatIndex + 1]) {
    throw new Error("yt-dlp format fallback requires a format selector.");
  }

  const fallbackArgs = [...args];
  fallbackArgs[formatIndex + 1] = AUDIO_FALLBACK_FORMAT;
  if (!fallbackArgs.includes("--no-check-formats")) {
    fallbackArgs.splice(formatIndex, 0, "--no-check-formats");
  }
  return fallbackArgs;
}

export async function runWithAudioFormatFallback(
  args,
  runAttempt,
  onRetry = () => {},
) {
  try {
    return await runAttempt(args, false);
  } catch (error) {
    if (!isRequestedFormatUnavailable(error)) throw error;

    const fallbackArgs = buildAudioFormatFallbackArgs(args);
    onRetry();
    return runAttempt(fallbackArgs, true);
  }
}
