import { decodePng } from "@pixerate/editor/raster";

/** An RGBA picture. */
export interface Picture {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function readPng(png: Buffer | Uint8Array): Picture {
  const d = decodePng(png instanceof Uint8Array ? png : new Uint8Array(png));
  if (d.channels !== 4) throw new Error("Expected an RGBA PNG.");
  return { width: d.width, height: d.height, data: d.data };
}

/** How wide the left and right margins are that the sample stroke never reaches. */
const MARGIN = 24;

/** Each row's margin pixels: the backdrop there (paper, or the bands a smudge preview paints over). */
function marginRows(p: Picture): [number, number, number][][] {
  const m = Math.min(MARGIN, Math.floor(p.width / 8));
  const rows: [number, number, number][][] = [];
  for (let y = 0; y < p.height; y++) {
    const row: [number, number, number][] = [];
    for (let x = 0; x < m; x++) row.push(rgbOver(p, (y * p.width + x) * 4), rgbOver(p, (y * p.width + p.width - 1 - x) * 4));
    rows.push(row);
  }
  return rows;
}

const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const medianColour = (px: readonly [number, number, number][]): [number, number, number] => [median(px.map((c) => c[0])), median(px.map((c) => c[1])), median(px.map((c) => c[2]))];

/**
 * What the picture is drawn over, row by row: the median of each row's margins. Previews are
 * paper (textured, the same on every row) or, for brushes that move paint, horizontal bands of
 * colour, so a row's margins say what lies under the stroke on that row.
 */
function backdrop(p: Picture): { rows: [number, number, number][]; noise: number } {
  const rows = marginRows(p).map(medianColour);
  // How far the paper strays from its colour (its grain), over the top and bottom 4 rows: four
  // times the median, which reads like the 99th percentile of paper grain but moves only when a
  // stroke covers most of those rows (a vector S runs almost edge to edge; a vortex can pull bare
  // paper into the edges of the bands it previews over).
  const band = Math.min(4, Math.floor(p.height / 8));
  const d: number[] = [];
  for (let y = 0; y < p.height; y++) {
    if (y >= band && y < p.height - band) continue;
    const row = Array.from({ length: p.width }, (_, x) => rgbOver(p, (y * p.width + x) * 4));
    const c = medianColour(row);
    for (const px of row) d.push(dist(px, c));
  }
  d.sort((a, b) => a - b);
  return { rows, noise: 4 * (d[Math.floor(d.length * 0.5)] ?? 0) };
}

/** The colour behind the stroke: the median of every row's margins (alpha composited over white). */
export function paperOf(p: Picture): [number, number, number] {
  return medianColour(marginRows(p).flat());
}

/** A pixel's colour composited over white (canvas previews are transparent around the stroke). */
function rgbOver(p: Picture, i: number): [number, number, number] {
  const a = p.data[i + 3]! / 255;
  return [p.data[i]! * a + 255 * (1 - a), p.data[i + 1]! * a + 255 * (1 - a), p.data[i + 2]! * a + 255 * (1 - a)];
}

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/** Pixels that differ from what lies under them by more than the paper's grain does (and at least 16 of 441 in RGB): the marks. */
export function inkMask(p: Picture): Uint8Array {
  const { rows, noise } = backdrop(p);
  const threshold = Math.max(16, noise);
  const mask = new Uint8Array(p.width * p.height);
  for (let i = 0; i < mask.length; i++) mask[i] = dist(rgbOver(p, i * 4), rows[Math.floor(i / p.width)]!) > threshold ? 1 : 0;
  return mask;
}

/** The share of the picture the marks cover, 0–1. */
export function inkCoverage(p: Picture): number {
  const m = inkMask(p);
  let n = 0;
  for (const v of m) n += v;
  return n / m.length;
}

/** The mean colour of the marks (over white), or the paper's when there are none. */
export function inkColour(p: Picture): [number, number, number] {
  const m = inkMask(p);
  const sum = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < m.length; i++) {
    if (!m[i]) continue;
    const c = rgbOver(p, i * 4);
    sum[0] += c[0];
    sum[1] += c[1];
    sum[2] += c[2];
    n++;
  }
  return n ? [sum[0]! / n, sum[1]! / n, sum[2]! / n] : paperOf(p);
}

/** Nothing was drawn: under 0.2% of the picture differs from the paper. */
export function isBlank(p: Picture): boolean {
  return inkCoverage(p) < 0.002;
}

/** A mask shrunk by `f` in each direction: a cell is marked when any pixel in it is. */
function shrink(mask: Uint8Array, width: number, height: number, f: number): { cells: Uint8Array; w: number; h: number } {
  const w = Math.ceil(width / f);
  const h = Math.ceil(height / f);
  const cells = new Uint8Array(w * h);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (mask[y * width + x]) cells[Math.floor(y / f) * w + Math.floor(x / f)] = 1;
  return { cells, w, h };
}

/** A mask placed in the middle of a larger `width` × `height` one (zeros around it). */
function centre(mask: Uint8Array, w: number, h: number, width: number, height: number): Uint8Array {
  if (w === width && h === height) return mask;
  const out = new Uint8Array(width * height);
  const dx = Math.floor((width - w) / 2);
  const dy = Math.floor((height - h) / 2);
  for (let y = 0; y < h; y++) out.set(mask.subarray(y * w, (y + 1) * w), (y + dy) * width + dx);
  return out;
}

/**
 * How much a drafted brush's stroke looks like a reference stroke drawn the same way (same path),
 * each 0–1. The canvas and vector previews size the picture to the brush, so pictures of
 * different sizes are compared centred on the larger one.
 * - `coverage`: how close the amounts of paint are (a thin pen against a wide wash scores low).
 * - `colour`: how close the mean colours of the marks, and the papers, are.
 * - `structure`: overlap (IoU) of where the marks are, on an 8 px grid: the width, edges and scatter.
 * It is rough: it rewards the right width, colour and spread, not the right texture.
 */
export function strokeSimilarity(candidate: Picture, reference: Picture): { coverage: number; colour: number; structure: number; overall: number } {
  const width = Math.max(candidate.width, reference.width);
  const height = Math.max(candidate.height, reference.height);
  const cm = centre(inkMask(candidate), candidate.width, candidate.height, width, height);
  const rm = centre(inkMask(reference), reference.width, reference.height, width, height);
  const ca = cm.reduce((s, v) => s + v, 0) / cm.length;
  const ra = rm.reduce((s, v) => s + v, 0) / rm.length;
  const coverage = Math.max(ca, ra) === 0 ? 1 : Math.min(ca, ra) / Math.max(ca, ra);
  const colourDist = dist(inkColour(candidate), inkColour(reference)) / 441.7;
  const paperDist = dist(paperOf(candidate), paperOf(reference)) / 441.7;
  const colour = Math.max(0, 1 - 1.5 * colourDist) * (1 - 0.5 * Math.min(1, paperDist * 2));
  const a = shrink(cm, width, height, 8);
  const b = shrink(rm, width, height, 8);
  let both = 0;
  let either = 0;
  for (let i = 0; i < a.cells.length; i++) {
    both += a.cells[i]! & b.cells[i]!;
    either += a.cells[i]! | b.cells[i]!;
  }
  const structure = either === 0 ? 1 : both / either;
  return { coverage, colour, structure, overall: 0.3 * coverage + 0.35 * colour + 0.35 * structure };
}
