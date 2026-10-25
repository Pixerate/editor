import { useRef, type RefObject } from "react";
import { locatePlaybackChrome, type AgentPlayback, type PlaybackChromeOptions, type PlaybackPoint, type PlaybackRect, type PlaybackRef, type PresenceStore } from "@pixerate/editor/tools";
import { usePlaybackSurface } from "./usePlaybackSurface";

export interface ElementPlaybackSurfaceOptions extends PlaybackChromeOptions {
  /** The kind of a bare `id` / `ids` argument (e.g. `parameter`). */
  defaultKind?: string;
  /**
   * A CSS selector for each ref kind the surface can find inside the element, e.g.
   * `{ parameter: (id) => \`[data-parameter-id="${CSS.escape(id)}"]\` }`. Refs they miss go to
   * `locate`, then `locateElement` (which may return an element outside this one).
   */
  selectors?: Record<string, (id: string) => string>;
  /** Bring the element on screen (switch to its tab) before the agent acts. */
  reveal?: () => void | Promise<void>;
}

/**
 * A playback surface for a plain DOM component: coordinates are pixels of `element`'s box, and
 * refs are found by the CSS selectors given per kind. Draw the cursors with `<PresenceLayer>`
 * inside the element (make it `position: relative`).
 */
export function useElementPlaybackSurface(
  playback: AgentPlayback | null | undefined,
  id: string | null | undefined,
  element: RefObject<HTMLElement | null>,
  options: ElementPlaybackSurfaceOptions,
): PresenceStore {
  const latest = useRef(options);
  latest.current = options;
  const box = () => element.current?.getBoundingClientRect() ?? null;
  const fromViewport = (p: PlaybackPoint) => {
    const r = box();
    return { x: p.x - (r?.left ?? 0), y: p.y - (r?.top ?? 0) };
  };
  return usePlaybackSurface(playback, id, {
    get defaultKind() {
      return latest.current.defaultKind;
    },
    locate: (ref: PlaybackRef): PlaybackRect | null => {
      const selector = latest.current.selectors?.[ref.kind]?.(ref.id);
      const b = box();
      const r = selector ? element.current?.querySelector(selector)?.getBoundingClientRect() : null;
      if (b && r && r.width > 0) return { x: r.left - b.left, y: r.top - b.top, width: r.width, height: r.height };
      return locatePlaybackChrome(ref, latest.current, fromViewport);
    },
    bounds: () => {
      const r = box();
      return r && r.width > 0 ? { x: 0, y: 0, width: r.width, height: r.height } : null;
    },
    visible: () => {
      const r = box();
      return !!r && r.width > 0 && r.height > 0 && !(typeof document !== "undefined" && document.visibilityState === "hidden");
    },
    toViewport: (p) => {
      const r = box();
      return { x: (r?.left ?? 0) + p.x, y: (r?.top ?? 0) + p.y };
    },
    fromViewport,
    reveal: () => latest.current.reveal?.(),
    get open() {
      return latest.current.open ? (ref: PlaybackRef) => latest.current.open?.(ref) : undefined;
    },
  });
}
