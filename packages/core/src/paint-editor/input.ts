/**
 * Pen input helpers for the bindings: Pointer Events (structurally typed, no DOM import) into
 * `PenPoint`s, palm rejection by hand, and which hand the user draws with. The bindings feed
 * coalesced events into the stroke and draw predicted ones as a throwaway preview.
 */

import { penOrientation, type PenPoint } from './engine';
import { viewPenToDocument, type PaintView } from './view';
import { pointerPressure } from '../paint/pointer';

/** The Pointer Event fields the paint editor reads. */
export interface PointerSample {
  pointerType?: string;
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
  /** Radians (Pointer Events Level 3). */
  altitudeAngle?: number;
  azimuthAngle?: number;
  /** Degrees 0..359. */
  twist?: number;
  timeStamp?: number;
}

/** Which hand holds the pen: palm rejection ignores touches on that side of it. */
export type Hand = 'right' | 'left';

/**
 * Pressure of a pointer sample: pens report it; mice report 0.5 while pressed and pens 0 on
 * `pointerup`, both of which mean "use full" (see GOTCHAS). The shared `pointerPressure`.
 */
export function samplePressure(e: PointerSample): number {
  return pointerPressure(e);
}

/**
 * A pointer sample at document position (x, y) as a pen point. Only pens report tilt and twist;
 * a pen's lean and barrel rotation are turned with the view, so marks look the same on screen
 * whatever the canvas rotation and mirroring.
 */
export function pointerToPenPoint(e: PointerSample, x: number, y: number, view?: PaintView): PenPoint {
  const p: PenPoint = { x, y, pressure: samplePressure(e) };
  if (typeof e.timeStamp === 'number' && Number.isFinite(e.timeStamp)) p.t = e.timeStamp;
  if (e.pointerType !== 'pen') return p;
  const o = penOrientation({
    x,
    y,
    altitude: typeof e.altitudeAngle === 'number' ? e.altitudeAngle : undefined,
    azimuth: typeof e.azimuthAngle === 'number' ? e.azimuthAngle : undefined,
    tiltX: e.tiltX,
    tiltY: e.tiltY,
  });
  // A pen standing straight up with no tilt reported keeps no orientation (most pens without tilt report 0, 0).
  if (o && o.altitude < Math.PI / 2 - 1e-6) {
    p.altitude = o.altitude;
    p.azimuth = o.azimuth;
  }
  if (typeof e.twist === 'number' && Number.isFinite(e.twist) && e.twist !== 0) p.twist = e.twist;
  return view ? viewPenToDocument(view, p) : p;
}

/**
 * Palm rejection: whether a touch at `touch` (screen pixels) is probably the drawing hand resting
 * on the screen while the pen is at `pen`. A right hand rests below and to the right of the pen, a
 * left hand below and to the left.
 */
export function isPalmTouch(touch: { x: number; y: number }, pen: { x: number; y: number } | null, hand: Hand): boolean {
  if (!pen) return false;
  const dx = touch.x - pen.x;
  const dy = touch.y - pen.y;
  const side = hand === 'right' ? dx : -dx;
  return dy > -40 && side > -40 && Math.hypot(dx, dy) < 600;
}
