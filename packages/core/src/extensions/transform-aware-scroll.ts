import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/**
 * Transform-aware caret scrolling. ProseMirror scrolls the caret into view by adding the
 * caret's on-screen overflow to the scroll container's `scrollTop`/`scrollLeft`. When the
 * scroll container itself is drawn scaled (a CSS `transform: scale()` on it or an ancestor:
 * a pan/zoom canvas, a SvelteFlow node, a diagram card), on-screen pixels and scroll pixels
 * differ by the scale, so it over- or under-scrolls. This plugin divides by the scale.
 *
 * It only takes over when the nearest scrolled ancestor is scaled; otherwise it hands back to
 * ProseMirror, which also scrolls outer containers and the page.
 */

export const transformAwareScrollPluginKey = new PluginKey("transformAwareScroll");

export interface TransformAwareScrollOptions {
  /** Space kept between the caret and the container's edge, in CSS pixels on screen (default 12). */
  padding?: number;
  /** Axes to scroll: `both` (default), `vertical` or `horizontal`. */
  axis?: "both" | "vertical" | "horizontal";
  /**
   * The scroll container, or a function returning it. Default: the nearest ancestor that has
   * `overflow: auto | scroll` and content larger than its box.
   */
  container?: HTMLElement | null | (() => HTMLElement | null);
}

export interface TransformScrollAdjustmentParams {
  /** The caret's rectangle on screen (from `coordsAtPos`). */
  coords: { top: number; bottom: number; left: number; right: number };
  /** The container's rectangle on screen (`getBoundingClientRect`, so scaled). */
  containerRect: { top: number; bottom: number; left: number; right: number; width: number; height: number };
  /** The container's unscaled height, in layout pixels (`offsetHeight`). */
  clientHeight: number;
  /** The container's unscaled width, in layout pixels (`offsetWidth`). */
  clientWidth: number;
  /** Default 12. */
  padding?: number;
  /** Default `both`. */
  axis?: "both" | "vertical" | "horizontal";
}

export interface TransformScrollAdjustmentResult {
  /** Change to `scrollLeft`, in the container's (unscaled) pixels. */
  deltaX: number;
  /** Change to `scrollTop`, in the container's (unscaled) pixels. */
  deltaY: number;
}

const safeScale = (screen: number, layout: number) => {
  const scale = layout > 0 && screen > 0 ? screen / layout : 1;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
};

/**
 * The scroll change that brings the caret inside the container (less `padding`), in the
 * container's own pixels: the on-screen overflow divided by the container's scale.
 */
export function calculateTransformScrollAdjustment(params: TransformScrollAdjustmentParams): TransformScrollAdjustmentResult {
  const { coords, containerRect, clientHeight, clientWidth } = params;
  const padding = params.padding ?? 12;
  const axis = params.axis ?? "both";
  const scaleY = safeScale(containerRect.height, clientHeight);
  const scaleX = safeScale(containerRect.width, clientWidth);

  let deltaY = 0;
  let deltaX = 0;
  if (axis !== "horizontal") {
    if (coords.bottom > containerRect.bottom - padding) deltaY = (coords.bottom - (containerRect.bottom - padding)) / scaleY;
    else if (coords.top < containerRect.top + padding) deltaY = (coords.top - (containerRect.top + padding)) / scaleY;
  }
  if (axis !== "vertical") {
    if (coords.right > containerRect.right - padding) deltaX = (coords.right - (containerRect.right - padding)) / scaleX;
    else if (coords.left < containerRect.left + padding) deltaX = (coords.left - (containerRect.left + padding)) / scaleX;
  }
  return { deltaX, deltaY };
}

const SCROLLS = /(auto|scroll)/i;

/**
 * The nearest ancestor of `element` (itself included) that scrolls: `overflow: auto | scroll`
 * on an axis whose content is larger than its box. Null when there's none, so the page scrolls.
 */
export function findScrollContainer(element: HTMLElement | null): HTMLElement | null {
  if (!element || typeof window === "undefined") return null;
  const view = element.ownerDocument?.defaultView ?? window;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current === current.ownerDocument.body || current === current.ownerDocument.documentElement) return null;
    const style = view.getComputedStyle(current);
    const scrollsY = (SCROLLS.test(style.overflowY) || SCROLLS.test(style.overflow)) && current.scrollHeight > current.clientHeight;
    const scrollsX = (SCROLLS.test(style.overflowX) || SCROLLS.test(style.overflow)) && current.scrollWidth > current.clientWidth;
    if (scrollsY || scrollsX) return current;
  }
  return null;
}

function resolveContainer(view: EditorView, options?: TransformAwareScrollOptions): HTMLElement | null {
  if (options?.container) return typeof options.container === "function" ? options.container() : options.container;
  return findScrollContainer(view.dom as HTMLElement);
}

/** The container is drawn at a scale other than 1 (within 1%), so ProseMirror's own scrolling would be off. */
export function isScaledScrollContainer(container: HTMLElement): boolean {
  const rect = container.getBoundingClientRect();
  const scaleY = safeScale(rect.height, container.offsetHeight);
  const scaleX = safeScale(rect.width, container.offsetWidth);
  return Math.abs(scaleY - 1) > 0.01 || Math.abs(scaleX - 1) > 0.01;
}

const scheduled = new WeakMap<EditorView, number>();

/** Cancels a scroll `scrollCaretIntoView` scheduled for `view`. */
export function cancelScheduledScroll(view: EditorView): void {
  const id = scheduled.get(view);
  if (id === undefined) return;
  if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(id);
  scheduled.delete(view);
}

/** Scrolls the container so the caret is in view, now. True when it scrolled. */
export function scrollCaretIntoViewNow(view: EditorView, options?: TransformAwareScrollOptions): boolean {
  if (!view || view.isDestroyed) return false;
  const container = resolveContainer(view, options);
  if (!container) return false;
  try {
    const coords = view.coordsAtPos(view.state.selection.head);
    const { deltaX, deltaY } = calculateTransformScrollAdjustment({
      coords,
      containerRect: container.getBoundingClientRect(),
      clientHeight: container.offsetHeight,
      clientWidth: container.offsetWidth,
      padding: options?.padding,
      axis: options?.axis,
    });
    if (deltaY !== 0) container.scrollTop = Math.max(0, container.scrollTop + deltaY);
    if (deltaX !== 0) container.scrollLeft = Math.max(0, container.scrollLeft + deltaX);
    return deltaX !== 0 || deltaY !== 0;
  } catch {
    // coordsAtPos throws while a position is momentarily unmapped during layout
    return false;
  }
}

/** Scrolls the caret into view on the next animation frame (once per frame per view). */
export function scrollCaretIntoView(view: EditorView, options?: TransformAwareScrollOptions): void {
  if (!view || view.isDestroyed) return;
  cancelScheduledScroll(view);
  if (typeof requestAnimationFrame === "undefined") {
    scrollCaretIntoViewNow(view, options);
    return;
  }
  scheduled.set(
    view,
    requestAnimationFrame(() => {
      scheduled.delete(view);
      scrollCaretIntoViewNow(view, options);
    }),
  );
}

/**
 * A ProseMirror plugin that scrolls the caret into view itself when its scroll container is
 * scaled, and leaves it to ProseMirror otherwise.
 */
export function createTransformAwareScrollPlugin(options?: TransformAwareScrollOptions): Plugin {
  return new Plugin({
    key: transformAwareScrollPluginKey,
    props: {
      handleScrollToSelection(view) {
        const container = resolveContainer(view, options);
        if (!container || !isScaledScrollContainer(container)) return false;
        scrollCaretIntoView(view, options);
        return true;
      },
    },
    view: (editorView) => ({ destroy: () => cancelScheduledScroll(editorView) }),
  });
}

/** TipTap extension for `createTransformAwareScrollPlugin`. On by default in `createRichTextPreset`. */
export const TransformAwareScroll = Extension.create<TransformAwareScrollOptions>({
  name: "transformAwareScroll",
  addOptions() {
    return { padding: 12, axis: "both", container: null };
  },
  addProseMirrorPlugins() {
    return [createTransformAwareScrollPlugin(this.options)];
  },
});

export const createTransformAwareScrollExtension = (options?: TransformAwareScrollOptions) => TransformAwareScroll.configure(options);
