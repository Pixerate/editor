/**
 * Pen samples along vector path data, so a path can be brushed like a hand-drawn stroke
 * (`strokePath`, the `stroke_path` tool): each subpath becomes one stroke, sampled at an even
 * spacing, with an optional pressure profile spread along its length (a taper).
 */

import { flattenChain, pathToContours } from '../canvas/pathops/bezier';
import type { PenPoint } from './engine';

/** How finely curves are flattened before resampling, in document pixels. */
const FLATTEN_TOLERANCE = 0.1;

/** The most samples one subpath may have (the stroke tools' point limit). */
export const MAX_PATH_SAMPLES = 20000;

export interface PathSampleOptions {
  /** Distance between samples in document pixels (default 2). */
  spacing?: number;
  /** Pressure along each subpath, spread evenly from its start to its end (default full pressure). */
  pressure?: readonly number[];
}

/** Pressure at `t` (0..1 along the length) of an evenly spread profile. */
function profileAt(profile: readonly number[], t: number): number {
  if (profile.length === 1) return profile[0];
  const at = t * (profile.length - 1);
  const i = Math.min(profile.length - 2, Math.floor(at));
  return profile[i] + (profile[i + 1] - profile[i]) * (at - i);
}

/**
 * Samples SVG path data (document pixels) into pen points, one array per subpath. Closed
 * subpaths end where they start. Throws a sentence when the path has nothing to brush.
 */
export function samplePath(d: string, options: PathSampleOptions = {}): PenPoint[][] {
  const spacing = options.spacing ?? 2;
  if (!(spacing >= 0.25 && spacing <= 100)) throw new Error(`spacing ${spacing} is out of range; use 0.25..100 document pixels.`);
  const profile = options.pressure;
  if (profile && (!profile.length || profile.some((p) => !(p >= 0 && p <= 1)))) throw new Error('pressure needs one or more values from 0 to 1, e.g. [0.2, 1, 0.2] for a taper.');
  let contours;
  try {
    contours = pathToContours(d);
  } catch (e) {
    throw new Error(`path is not SVG path data (${e instanceof Error ? e.message : String(e)}); give e.g. "M 10 10 C 40 0 80 60 120 30".`);
  }
  const out: PenPoint[][] = [];
  for (const contour of contours) {
    if (!contour.segments.length) continue;
    const line = flattenChain(contour.segments, FLATTEN_TOLERANCE);
    if (contour.closed && line.length) line.push(line[0]);
    // Even resampling along the flattened line.
    const lengths = [0];
    for (let i = 1; i < line.length; i++) lengths.push(lengths[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
    const total = lengths[lengths.length - 1];
    const n = Math.max(1, Math.ceil(total / spacing));
    if (n + 1 > MAX_PATH_SAMPLES) throw new Error(`The path is ${Math.round(total)} px long: too many samples at spacing ${spacing}; use a larger spacing (at least ${Math.ceil(total / (MAX_PATH_SAMPLES - 1))}).`);
    const points: PenPoint[] = [];
    let j = 0;
    for (let k = 0; k <= n; k++) {
      const at = (total * k) / n;
      while (j < line.length - 2 && lengths[j + 1] < at) j++;
      const span = lengths[j + 1] - lengths[j] || 1;
      const f = line.length > 1 ? Math.min(1, Math.max(0, (at - lengths[j]) / span)) : 0;
      const a = line[j];
      const b = line[Math.min(j + 1, line.length - 1)];
      const x = Math.round((a[0] + (b[0] - a[0]) * f) * 1000) / 1000;
      const y = Math.round((a[1] + (b[1] - a[1]) * f) * 1000) / 1000;
      points.push(profile ? { x, y, pressure: Math.round(profileAt(profile, k / n) * 1000) / 1000 } : { x, y });
    }
    out.push(points);
  }
  if (!out.length) throw new Error('path has no segments to brush; give SVG path data such as "M 10 10 L 200 80".');
  return out;
}
