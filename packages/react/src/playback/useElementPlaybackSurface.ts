import { useRef, type RefObject } from "react";
import type { AgentPlayback, PlaybackRect, PlaybackRef, PresenceStore } from "@pixerate/editor/tools";
import { usePlaybackSurface } from "./usePlaybackSurface";

export interface ElementPlaybackSurfaceOptions {
  /** The kind of a bare `id` / `ids` argument (e.g. `parameter`). */
  defaultKind?: string;
  /**
   * A CSS selector for each ref kind the surface can find inside the element, e.g.
   * `{ parameter: (id) => \`[data-parameter-id="${CSS.escape(id)}"]\` }`.
   */
  selectors: Record<string, (id: string) => string>;
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
  return usePlaybackSurface(playback, id, {
    get defaultKind() {
      return latest.current.defaultKind;
    },
    locate: (ref: PlaybackRef): PlaybackRect | null => {
      const selector = latest.current.selectors[ref.kind]?.(ref.id);
      const b = box();
      const r = selector ? element.current?.querySelector(selector)?.getBoundingClientRect() : null;
      return b && r && r.width > 0 ? { x: r.left - b.left, y: r.top - b.top, width: r.width, height: r.height } : null;
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
    fromViewport: (p) => {
      const r = box();
      return { x: p.x - (r?.left ?? 0), y: p.y - (r?.top ?? 0) };
    },
    reveal: () => latest.current.reveal?.(),
  });
}
