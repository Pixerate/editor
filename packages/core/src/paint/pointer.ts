/**
 * Pointer Events to stroke samples, for any host: pressure and tilt from pens, coalesced events
 * for the full pen rate, positions mapped to the host's coordinates (world units on an infinite
 * canvas) by a function it passes. Structurally typed: no DOM import.
 */

import type { PathSample } from './path-stroke';

/** The Pointer Event fields read here. */
export interface PointerEventLike {
  clientX: number;
  clientY: number;
  pointerType?: string;
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
  /** Radians (Pointer Events Level 3). */
  altitudeAngle?: number;
  azimuthAngle?: number;
  timeStamp?: number;
  getCoalescedEvents?: () => PointerEventLike[];
}

/** A stroke sample with the event time (milliseconds). */
export interface PointerStrokeSample extends PathSample {
  t?: number;
}

/**
 * Pressure of a pointer sample: pens report it; mice report 0.5 while pressed and pens 0 on
 * `pointerup`, both of which mean "use full".
 */
export function pointerPressure(e: Pick<PointerEventLike, 'pointerType' | 'pressure'>): number {
  if (e.pointerType === 'pen' && typeof e.pressure === 'number' && e.pressure > 0) return Math.min(1, e.pressure);
  return 1;
}

/** One pointer event as a stroke sample at `toPoint(clientX, clientY)`. Only pens carry tilt. */
export function pointerStrokeSample(e: PointerEventLike, toPoint: (clientX: number, clientY: number) => { x: number; y: number }): PointerStrokeSample {
  const p = toPoint(e.clientX, e.clientY);
  const s: PointerStrokeSample = { x: p.x, y: p.y, pressure: pointerPressure(e) };
  if (typeof e.timeStamp === 'number' && Number.isFinite(e.timeStamp)) s.t = e.timeStamp;
  if (e.pointerType === 'pen') {
    if (typeof e.altitudeAngle === 'number' && e.altitudeAngle < Math.PI / 2 - 1e-6) {
      s.altitude = e.altitudeAngle;
      s.azimuth = e.azimuthAngle ?? 0;
    } else if (e.tiltX || e.tiltY) {
      s.tiltX = e.tiltX ?? 0;
      s.tiltY = e.tiltY ?? 0;
    }
  }
  return s;
}

/**
 * The stroke samples of a `pointermove` (its coalesced events when the browser gives them, else
 * the event itself), mapped by `toPoint`. Feed them to a stroke in order.
 */
export function pointerStrokeSamples(e: PointerEventLike, toPoint: (clientX: number, clientY: number) => { x: number; y: number }): PointerStrokeSample[] {
  const events = e.getCoalescedEvents?.() ?? [];
  return (events.length ? events : [e]).map((ev) => pointerStrokeSample(ev, toPoint));
}
