import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { Extension } from "@tiptap/core";

export const transformAwareScrollPluginKey = new PluginKey("transformAwareScroll");

export interface TransformAwareScrollOptions {
  /** Comfort padding margin in px (default: 12) */
  padding?: number;
  /** Scroll axis to adjust ('both' | 'vertical' | 'horizontal', default: 'both') */
  axis?: "both" | "vertical" | "horizontal";
  /** Explicit scroll container or resolver function. If omitted, walks up ancestors for overflow auto/scroll. */
  container?: HTMLElement | null | (() => HTMLElement | null);
}

export interface TransformScrollAdjustmentParams {
  coords: { top: number; bottom: number; left: number; right: number };
  containerRect: {
    top: number;
    bottom: number;
    left: number;
    right: number;
    width: number;
    height: number;
  };
  clientHeight: number;
  clientWidth: number;
  padding?: number;
  axis?: "both" | "vertical" | "horizontal";
}

export interface TransformScrollAdjustmentResult {
  deltaX: number;
  deltaY: number;
}

/**
 * Pure calculation function that determines horizontal and vertical scroll deltas
 * scaled by container CSS transforms (scaleX and scaleY).
 */
export function calculateTransformScrollAdjustment(
  params: TransformScrollAdjustmentParams
): TransformScrollAdjustmentResult {
  const { coords, containerRect, clientHeight, clientWidth } = params;
  const padding = params.padding ?? 12;
  const axis = params.axis ?? "both";

  const scaleY =
    clientHeight > 0 && containerRect.height > 0
      ? containerRect.height / clientHeight
      : 1;
  const scaleX =
    clientWidth > 0 && containerRect.width > 0
      ? containerRect.width / clientWidth
      : 1;

  const safeScaleY = Number.isFinite(scaleY) && scaleY > 0 ? scaleY : 1;
  const safeScaleX = Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1;

  let deltaY = 0;
  let deltaX = 0;

  if (axis !== "horizontal") {
    if (coords.bottom > containerRect.bottom - padding) {
      deltaY = (coords.bottom - (containerRect.bottom - padding)) / safeScaleY;
    } else if (coords.top < containerRect.top + padding) {
      deltaY = (coords.top - (containerRect.top + padding)) / safeScaleY;
    }
  }

  if (axis !== "vertical") {
    if (coords.right > containerRect.right - padding) {
      deltaX = (coords.right - (containerRect.right - padding)) / safeScaleX;
    } else if (coords.left < containerRect.left + padding) {
      deltaX = (coords.left - (containerRect.left + padding)) / safeScaleX;
    }
  }

  return { deltaX, deltaY };
}

/**
 * Traverses element ancestors searching for computed overflow of auto or scroll.
 * Falls back to document.scrollingElement or document.documentElement.
 */
export function findScrollContainer(element: HTMLElement | null): HTMLElement | null {
  if (!element || typeof window === "undefined") return null;

  let current: HTMLElement | null = element;
  while (current && current !== document.body && current !== document.documentElement) {
    const style = window.getComputedStyle(current);
    const isScrollable =
      /(auto|scroll)/i.test(style.overflowY) ||
      /(auto|scroll)/i.test(style.overflowX) ||
      /(auto|scroll)/i.test(style.overflow);

    if (
      isScrollable &&
      (current !== element ||
        current.scrollHeight > current.clientHeight ||
        current.scrollWidth > current.clientWidth)
    ) {
      return current;
    }
    current = current.parentElement;
  }

  const scrollingElement =
    (element.ownerDocument?.scrollingElement as HTMLElement | null) ??
    (typeof document !== "undefined"
      ? ((document.scrollingElement ?? document.documentElement) as HTMLElement | null)
      : null);

  return scrollingElement;
}

function resolveContainer(
  view: EditorView,
  options?: TransformAwareScrollOptions
): HTMLElement | null {
  if (options?.container) {
    if (typeof options.container === "function") {
      return options.container();
    }
    return options.container;
  }
  return findScrollContainer(view.dom);
}

const viewRafMap = new WeakMap<EditorView, number>();

/**
 * Cancels any pending requestAnimationFrame scroll for the given EditorView.
 */
export function cancelScheduledScroll(view: EditorView): void {
  const rafId = viewRafMap.get(view);
  if (rafId !== undefined) {
    if (typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(rafId);
    }
    viewRafMap.delete(view);
  }
}

/**
 * Synchronously calculates and adjusts container scroll positions for the caret.
 * Returns true if an adjustment was made, false otherwise.
 */
export function scrollCaretIntoViewNow(
  view: EditorView,
  options?: TransformAwareScrollOptions
): boolean {
  if (!view || (view as any).isDestroyed) return false;

  const container = resolveContainer(view, options);
  if (!container) return false;

  const { selection } = view.state;
  if (!selection) return false;

  try {
    const coords = view.coordsAtPos(selection.head);
    if (!coords) return false;

    const containerRect = container.getBoundingClientRect();
    const padding = options?.padding ?? 12;
    const axis = options?.axis ?? "both";

    const { deltaX, deltaY } = calculateTransformScrollAdjustment({
      coords,
      containerRect,
      clientHeight: container.clientHeight,
      clientWidth: container.clientWidth,
      padding,
      axis,
    });

    let adjusted = false;

    if (deltaY !== 0) {
      container.scrollTop = Math.max(0, container.scrollTop + deltaY);
      adjusted = true;
    }

    if (deltaX !== 0) {
      container.scrollLeft = Math.max(0, container.scrollLeft + deltaX);
      adjusted = true;
    }

    return adjusted;
  } catch {
    // coordsAtPos may throw if position is momentarily unmapped during layout
    return false;
  }
}

/**
 * Debounces transform-aware caret scroll into view using requestAnimationFrame.
 */
export function scrollCaretIntoView(
  view: EditorView,
  options?: TransformAwareScrollOptions
): void {
  if (!view || (view as any).isDestroyed) return;

  cancelScheduledScroll(view);

  if (typeof requestAnimationFrame === "undefined") {
    scrollCaretIntoViewNow(view, options);
    return;
  }

  const rafId = requestAnimationFrame(() => {
    viewRafMap.delete(view);
    scrollCaretIntoViewNow(view, options);
  });
  viewRafMap.set(view, rafId);
}

/**
 * Creates a ProseMirror Plugin that intercepts ProseMirror's default DOM scrolling
 * and adjusts caret position taking CSS transforms and scale into account.
 */
export function createTransformAwareScrollPlugin(
  options?: TransformAwareScrollOptions
): Plugin {
  return new Plugin({
    key: transformAwareScrollPluginKey,
    props: {
      handleScrollToSelection(view) {
        scrollCaretIntoView(view, options);
        return true;
      },
    },
    view(editorView) {
      return {
        update(view, prevState) {
          if (!prevState.selection.eq(view.state.selection)) {
            if (view.hasFocus()) {
              scrollCaretIntoView(view, options);
            }
          }
        },
        destroy() {
          cancelScheduledScroll(editorView);
        },
      };
    },
  });
}

/**
 * TipTap Extension wrapping createTransformAwareScrollPlugin.
 */
export const TransformAwareScroll = Extension.create<TransformAwareScrollOptions>({
  name: "transformAwareScroll",

  addOptions() {
    return {
      padding: 12,
      axis: "both",
      container: null,
    };
  },

  addProseMirrorPlugins() {
    return [createTransformAwareScrollPlugin(this.options)];
  },
});

export const createTransformAwareScrollExtension = (
  options?: TransformAwareScrollOptions
) => TransformAwareScroll.configure(options);
