"use client";

import { Radio } from "lucide-react";
import { useState } from "react";
import { getThumbnailFallbacks, type TrackResult } from "../lib/tracks";

export default function TrackArtwork({
  track,
  className,
  alt = "",
}: {
  track: TrackResult;
  className: string;
  alt?: string;
}) {
  const [fallbackIndex, setFallbackIndex] = useState(0);
  const fallbacks = getThumbnailFallbacks(track);

  if (fallbackIndex >= fallbacks.length) {
    return (
      <span className={`${className} track-art-fallback`} aria-label="Artwork unavailable">
        <Radio size={16} />
      </span>
    );
  }

  return (
    // YouTube owns the thumbnail URL; render it directly and fall back through official image sizes.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className}
      src={fallbacks[fallbackIndex]}
      alt={alt}
      loading="lazy"
      onError={() => setFallbackIndex((index) => index + 1)}
    />
  );
}
