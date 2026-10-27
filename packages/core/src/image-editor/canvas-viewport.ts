/**
 * Sizing an on-screen editor canvas: its layout size in CSS pixels (what the projection, overlays
 * and pointer mapping use) and how many backing-store pixels each CSS pixel needs to look sharp.
 */

/** What `measureCanvasViewport` reads from the element that holds the canvas. */
export interface MeasurableElement {
  readonly clientWidth: number;
  readonly clientHeight: number;
  /** Layout size including borders, compared with the on-screen box to find the CSS transform scale. */
  readonly offsetWidth?: number;
  readonly offsetHeight?: number;
  getBoundingClientRect(): { width: number; height: number };
}

export interface CanvasViewport {
  /** Layout width in CSS pixels (pass as `RenderOptions.viewportWidth`). */
  width: number;
  /** Layout height in CSS pixels (pass as `RenderOptions.viewportHeight`). */
  height: number;
  /** Backing-store pixels per CSS pixel (pass as `RenderOptions.pixelRatio`). */
  pixelRatio: number;
}

/** The size `measureCanvasViewport` gives an element without layout (e.g. before it is shown, or in jsdom). */
export const DEFAULT_CANVAS_VIEWPORT: Readonly<{ width: number; height: number }> = { width: 800, height: 500 };

/** The longest side a viewport backing store may reach; the pixel ratio is lowered to fit. */
export const MAX_CANVAS_BACKING_SIDE = 8192;

const currentDevicePixelRatio = (): number => (typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);

/**
 * Measures the element a viewport canvas fills. `clientWidth` / `clientHeight` give the layout size
 * (they ignore CSS transforms); `getBoundingClientRect()` gives the size on screen. Their ratio is
 * the scale of any transform on the element or its ancestors, so the pixel ratio is
 * `devicePixelRatio × that scale`: a 220px node scaled to 500px on a 2× screen gets ~4.5 backing
 * pixels per CSS pixel instead of being stretched. `fallback` is the size of an element without
 * layout (default `DEFAULT_CANVAS_VIEWPORT`).
 */
export function measureCanvasViewport(
  el: MeasurableElement,
  devicePixelRatio: number = currentDevicePixelRatio(),
  fallback: { width: number; height: number } = DEFAULT_CANVAS_VIEWPORT
): CanvasViewport {
  const width = el.clientWidth || fallback.width;
  const height = el.clientHeight || fallback.height;
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const box = el.getBoundingClientRect();
  const layoutW = el.offsetWidth || el.clientWidth;
  const layoutH = el.offsetHeight || el.clientHeight;
  const sx = layoutW > 0 && box.width > 0 ? box.width / layoutW : 1;
  const sy = layoutH > 0 && box.height > 0 ? box.height / layoutH : 1;
  // The larger axis keeps a non-uniform scale sharp in both directions.
  let pixelRatio = dpr * Math.max(sx, sy);
  pixelRatio = Math.min(pixelRatio, MAX_CANVAS_BACKING_SIDE / Math.max(width, height));
  return { width, height, pixelRatio: Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1 };
}

/** Whether two measurements need different backing stores. */
export function sameCanvasViewport(a: CanvasViewport, b: CanvasViewport): boolean {
  return a.width === b.width && a.height === b.height && Math.abs(a.pixelRatio - b.pixelRatio) < 1e-3;
}

/**
 * Calls `onChange` when the element's viewport measurement changes: on resize (a
 * `ResizeObserver`), on window resize (browser zoom, moving to another screen) and after any CSS
 * transition or animation ends (a host scaling the element with a transform, which resizes nothing).
 * Returns a function that stops watching.
 */
export function watchCanvasViewport(el: MeasurableElement & Partial<Element>, onChange: (viewport: CanvasViewport) => void): () => void {
  let last = measureCanvasViewport(el);
  const check = () => {
    const next = measureCanvasViewport(el);
    if (sameCanvasViewport(next, last)) return;
    last = next;
    onChange(next);
  };
  const stops: Array<() => void> = [];
  if (typeof ResizeObserver !== 'undefined' && typeof Element !== 'undefined' && el instanceof Element) {
    const observer = new ResizeObserver(check);
    observer.observe(el);
    stops.push(() => observer.disconnect());
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    for (const type of ['resize', 'transitionend', 'animationend'] as const) {
      window.addEventListener(type, check, true);
      stops.push(() => window.removeEventListener(type, check, true));
    }
  }
  return () => stops.forEach((stop) => stop());
}
