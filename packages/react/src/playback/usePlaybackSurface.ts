import { useEffect, useRef, useState } from "react";
import { PresenceStore, type AgentPlayback, type PlaybackSurface } from "@pixerate/editor/tools";
import { useAgentPlayback } from "./AgentPlaybackContext";

/** A surface's behaviour; every function is read fresh on each call, so inline closures are fine. */
export type PlaybackSurfaceOptions = Omit<PlaybackSurface, "presence">;

/**
 * Attaches a playback surface under `id` (the tool provider's id, or its `playbackSurface`) while
 * mounted, and returns its cursors to draw with `<PresenceLayer>`. `playback` defaults to the
 * nearest `AgentPlaybackProvider`; with none, nothing is attached and calls run instantly.
 */
export function usePlaybackSurface(
  playback: AgentPlayback | null | undefined,
  id: string | null | undefined,
  options: PlaybackSurfaceOptions = {},
  /** Use this presence store (e.g. a director's, so its cursor and playback's are one) instead of a new one. */
  sharedPresence?: PresenceStore | null,
): PresenceStore {
  const ambient = useAgentPlayback();
  const target = playback === undefined ? ambient : playback;
  const [ownPresence] = useState(() => new PresenceStore());
  const presence = sharedPresence ?? ownPresence;
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    if (!target || !id) return;
    const o = () => latest.current;
    const surface: PlaybackSurface = {
      presence,
      locate: (ref) => o().locate?.(ref) ?? null,
      bounds: () => o().bounds?.() ?? null,
      visible: () => o().visible?.() ?? true,
      toViewport: (p) => o().toViewport?.(p) ?? p,
      fromViewport: (p) => o().fromViewport?.(p) ?? p,
      beginGesture: (key) => o().beginGesture?.(key),
      endGesture: () => o().endGesture?.(),
      reveal: () => o().reveal?.(),
      open: (ref) => o().open?.(ref),
      get defaultKind() {
        return o().defaultKind;
      },
    };
    const detach = target.attach(id, surface);
    return () => {
      detach();
      for (const a of presence.getState().actors) presence.remove(a.id);
    };
  }, [target, id, presence]);
  return presence;
}
