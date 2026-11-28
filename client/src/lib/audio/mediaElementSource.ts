const mediaElementSources = new WeakMap<
  HTMLAudioElement,
  MediaElementAudioSourceNode
>();

export function getMediaElementSource(
  context: AudioContext,
  element: HTMLAudioElement,
): MediaElementAudioSourceNode {
  const existing = mediaElementSources.get(element);
  if (existing) {
    if (existing.context !== context) {
      throw new Error(
        "An audio element cannot be connected to more than one AudioContext.",
      );
    }
    return existing;
  }

  const source = context.createMediaElementSource(element);
  mediaElementSources.set(element, source);
  return source;
}
