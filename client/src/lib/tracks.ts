export type TrackResult = {
  id: string;
  title: string;
  duration: number | null;
  thumbnail: string | null;
  channelTitle: string;
  ecosystemQuery: string;
  genreTags?: string[];
};

const stripTrackQualifiers = (title: string) =>
  title
    .replace(/\s*[\[(](?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?|visuali[sz]er|4k|hd)[^\])]*[\])]/gi, "")
    .replace(/\s*[-|]\s*(?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?)(?:\s|$).*$/i, "")
    .trim();

export function normalizeTrack(value: Partial<TrackResult> & { id: string; title: string }): TrackResult {
  const title = value.title.trim();
  const cleanTitle = stripTrackQualifiers(title);
  const channelTitle = value.channelTitle?.trim() || "YouTube";
  const thumbnail =
    value.thumbnail ||
    `https://i.ytimg.com/vi/${encodeURIComponent(value.id)}/maxresdefault.jpg`;

  return {
    id: value.id,
    title,
    channelTitle,
    duration:
      typeof value.duration === "number" && Number.isFinite(value.duration)
        ? value.duration
        : null,
    thumbnail,
    ecosystemQuery:
      value.ecosystemQuery?.trim() ||
      (channelTitle === "YouTube"
        ? `${cleanTitle} similar songs`
        : `${channelTitle} songs`),
    genreTags: Array.isArray(value.genreTags)
      ? value.genreTags.filter((tag): tag is string => typeof tag === "string")
      : undefined,
  };
}

export function getThumbnailFallbacks(track: TrackResult): string[] {
  const official = [
    "maxresdefault",
    "sddefault",
    "hqdefault",
    "mqdefault",
    "default",
  ].map(
    (quality) =>
      `https://i.ytimg.com/vi/${encodeURIComponent(track.id)}/${quality}.jpg`,
  );
  return [
    ...new Set(
      [...official, track.thumbnail].filter(
        (url): url is string => url !== null,
      ),
    ),
  ];
}
