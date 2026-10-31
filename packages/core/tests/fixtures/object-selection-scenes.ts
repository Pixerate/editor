/**
 * Synthetic photographs with known masks, for measuring Object Selection (GrabCut without a
 * model). Each scene is drawn at the demo's photo size (1200 × 800) with fractal texture, shading,
 * anti-aliased outlines and a slight blur, so it behaves more like a photo than flat colours do.
 * `OBJECT_SELECTION_CASES` pairs them with a box or a click, as a person or an agent would give.
 */
import type { CropBox, ImagePoint } from '../../src/image-editor';

export interface Scene {
  name: string;
  width: number;
  height: number;
  data: Uint8ClampedArray;
  /** Per pixel, how much of it is the object (0..1). */
  truth: Float32Array;
}

type Rgb = [number, number, number];

/** A small deterministic random generator (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fractal value noise in about −1..1, `octaves` octaves from a `cell` px grid down. */
function fractal(seed: number, cell: number, octaves = 4): (x: number, y: number) => number {
  const rnd = random(seed);
  const N = 256;
  const table = Float32Array.from({ length: N * N }, () => rnd() * 2 - 1);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const value = (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = smooth(x - xi);
    const fy = smooth(y - yi);
    const at = (i: number, j: number) => table[(((j & (N - 1)) * N) + (i & (N - 1)))];
    const a = at(xi, yi) * (1 - fx) + at(xi + 1, yi) * fx;
    const b = at(xi, yi + 1) * (1 - fx) + at(xi + 1, yi + 1) * fx;
    return a * (1 - fy) + b * fy;
  };
  return (x, y) => {
    let s = 0;
    let amp = 0.5;
    let f = 1 / cell;
    for (let o = 0; o < octaves; o++) {
      s += amp * value(x * f + o * 37, y * f + o * 91);
      amp *= 0.5;
      f *= 2;
    }
    return s * 1.4;
  };
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Draws a scene: `inside(x, y)` is the object's shape (sampled 4 × 4 per pixel for coverage),
 * `object` and `background` its colours at a point. Adds grain and a light blur.
 */
function draw(
  name: string,
  width: number,
  height: number,
  inside: (x: number, y: number) => boolean,
  object: (x: number, y: number) => Rgb,
  background: (x: number, y: number) => Rgb,
  seed = 1,
  soften = 0,
): Scene {
  const truth = new Float32Array(width * height);
  const rgb = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Coverage: one sample decides most pixels; 16 where a neighbour might differ.
      const c = inside(x + 0.5, y + 0.5);
      let cov = c ? 1 : 0;
      if (c !== inside(x - 0.5, y + 0.5) || c !== inside(x + 1.5, y + 0.5) || c !== inside(x + 0.5, y - 0.5) || c !== inside(x + 0.5, y + 1.5)) {
        let k = 0;
        for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) if (inside(x + (i + 0.5) / 4, y + (j + 0.5) / 4)) k++;
        cov = k / 16;
      }
      const p = y * width + x;
      truth[p] = cov;
      const col = cov === 1 ? object(x, y) : cov === 0 ? background(x, y) : mix(background(x, y), object(x, y), cov);
      rgb[p * 3] = col[0];
      rgb[p * 3 + 1] = col[1];
      rgb[p * 3 + 2] = col[2];
    }
  }
  // Haze softens edges: extra 3 × 3 box blurs.
  for (let k = 0; k < soften; k++) {
    const src = rgb.slice();
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        for (let ch = 0; ch < 3; ch++) {
          let s = 0;
          for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += src[((y + j) * width + x + i) * 3 + ch];
          rgb[(y * width + x) * 3 + ch] = s / 9;
        }
      }
    }
  }
  const rnd = random(seed * 7919);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      for (let ch = 0; ch < 3; ch++) {
        // A 3-tap blur across and down (a photo's slight softness) plus sensor grain.
        let s = 0;
        let n = 0;
        for (let j = Math.max(0, y - 1); j <= Math.min(height - 1, y + 1); j++) {
          for (let i = Math.max(0, x - 1); i <= Math.min(width - 1, x + 1); i++) {
            const wgt = (i === x ? 2 : 1) * (j === y ? 2 : 1);
            s += rgb[(j * width + i) * 3 + ch] * wgt;
            n += wgt;
          }
        }
        data[p * 4 + ch] = s / n + (rnd() - 0.5) * 8;
      }
      data[p * 4 + 3] = 255;
    }
  }
  return { name, width, height, data, truth };
}

const W = 1200;
const H = 800;

/**
 * A castle in mist against a pale sky (like the demo's castle photo): grey-blue stone only a
 * little darker than the clouds, a thin spire, soft edges, and haze that thickens towards the
 * foot until the walls fade into the misty wooded hill in front of them.
 */
export function hazeCastle(haze = 0.75): Scene {
  const tri = (x: number, y: number, cx: number, top: number, base: number, half: number) =>
    y >= top && y < base && Math.abs(x - cx) <= (half * (y - top)) / (base - top);
  const ridge = fractal(5, 60);
  const hill = (x: number, y: number) => y >= 640 + ridge(x, 0) * 40 - 30 * Math.cos((x - 600) / 400);
  const castle = (x: number, y: number) =>
    (x >= 450 && x < 750 && y >= 400 && y < 720 && !(y < 420 && Math.floor((x - 450) / 25) % 2 === 1)) ||
    (x >= 410 && x < 480 && y >= 330 && y < 720) ||
    (x >= 720 && x < 790 && y >= 330 && y < 720) ||
    tri(x, y, 445, 250, 330, 40) ||
    tri(x, y, 755, 250, 330, 40) ||
    (Math.abs(x - 600) < 5 && y >= 240 && y < 400) ||
    tri(x, y, 600, 140, 240, 6);
  const inside = (x: number, y: number) => castle(x, y) && !hill(x, y);
  const stone = fractal(3, 40);
  const cloud = fractal(4, 260);
  const trees = fractal(6, 14);
  const fog: Rgb = [222, 226, 231];
  const thickness = (y: number) => Math.min(1, 0.4 * haze + clamp01((y - 380) / 300) * haze);
  const object = (x: number, y: number): Rgb => {
    const window = y > 450 && y < 600 && x > 490 && x < 710 && (x - 490) % 60 < 14 && (y - 450) % 70 < 30;
    const base: Rgb = window ? [95, 100, 110] : [140 + stone(x, y) * 16, 148 + stone(x, y) * 16, 162 + stone(x, y) * 14];
    return mix(base, fog, thickness(y));
  };
  const background = (x: number, y: number): Rgb => {
    if (hill(x, y)) return mix([50 + trees(x, y) * 20, 70 + trees(x, y) * 25, 55 + trees(x, y) * 18], fog, 0.45 + 0.5 * haze * clamp01((760 - y) / 120));
    const sky = mix([200, 212, 226], [230, 232, 235], clamp01(y / 700));
    const c = cloud(x, y);
    return c > 0 ? mix(sky, [245, 246, 248], clamp01(c)) : mix(sky, [176, 186, 200], clamp01(-c * 0.8));
  };
  return draw(haze < 0.5 ? 'clear castle' : 'haze castle', W, H, inside, object, background, 2, Math.round(haze * 3));
}

/**
 * A brown and white dog on a field of brown earth and grass: its brown matches the earth, so
 * only the white patches and the outline tell them apart in places.
 */
export function sharedColours(): Scene {
  const ell = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1;
  const inside = (x: number, y: number) =>
    ell(x, y, 600, 430, 210, 110) ||
    ell(x, y, 830, 330, 85, 75) ||
    ell(x, y, 900, 350, 50, 30) ||
    (x > 440 && x < 480 && y > 450 && y < 640) ||
    (x > 520 && x < 560 && y > 470 && y < 650) ||
    (x > 660 && x < 700 && y > 470 && y < 650) ||
    (x > 730 && x < 770 && y > 450 && y < 640) ||
    ell(x, y, 380, 360, 60, 14);
  const patches = fractal(11, 90);
  const fur = fractal(12, 12);
  const earth = fractal(13, 140);
  const grain = fractal(14, 10);
  const object = (x: number, y: number): Rgb => {
    const white = patches(x, y) > 0.25;
    const shade = 1 - 0.25 * clamp01((y - 380) / 200) + fur(x, y) * 0.08;
    const c: Rgb = white ? [228, 222, 210] : [128, 94, 62];
    return [c[0] * shade, c[1] * shade, c[2] * shade];
  };
  const background = (x: number, y: number): Rgb => {
    const t = clamp01(earth(x, y) * 1.5 + 0.5);
    const c = mix([126, 92, 60], [78, 116, 56], t);
    const g = 1 + grain(x, y) * 0.12;
    return [c[0] * g, c[1] * g, c[2] * g];
  };
  return draw('shared colours', W, H, inside, object, background, 3);
}

/** A street lamp: a 5 px pole with a lamp head, against a textured wall and sky. */
export function thinPole(): Scene {
  const inside = (x: number, y: number) =>
    (Math.abs(x - 600) < 2.5 && y >= 170 && y < 740) ||
    (((x - 600) / 34) ** 2 + ((y - 160) / 22) ** 2 < 1) ||
    (Math.abs(x - 600) < 10 && y >= 720 && y < 750);
  const wall = fractal(21, 60);
  const sky = fractal(22, 200);
  const object = (x: number, y: number): Rgb => (y < 185 ? [40, 44, 40] : [58 + (x - 600) * 3, 60 + (x - 600) * 3, 64 + (x - 600) * 3]);
  const background = (x: number, y: number): Rgb => {
    if (y < 420) return mix([150, 180, 215], [205, 215, 228], clamp01(0.5 + sky(x, y) * 0.6));
    const brick = (Math.floor(y / 24) + Math.floor((x + (Math.floor(y / 24) % 2) * 30) / 60)) % 3;
    const c: Rgb = brick === 0 ? [168, 120, 96] : brick === 1 ? [150, 110, 90] : [176, 140, 112];
    const g = 1 + wall(x, y) * 0.15;
    return [c[0] * g, c[1] * g, c[2] * g];
  };
  return draw('thin pole', W, H, inside, object, background, 4);
}

/** An orange with shading and a shadow on a wooden table (`radius` px). */
export function orangeOnTable(radius = 150, cx = 600, cy = 400): Scene {
  const inside = (x: number, y: number) => (x - cx) ** 2 + (y - cy) ** 2 < radius * radius;
  const peel = fractal(31, Math.max(3, radius / 30));
  const wood = fractal(32, 120);
  const object = (x: number, y: number): Rgb => {
    const nx = (x - cx) / radius;
    const ny = (y - cy) / radius;
    const light = clamp01(0.55 + 0.45 * (-0.5 * nx - 0.6 * ny + 0.6 * Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny))));
    const p = 1 + peel(x, y) * 0.06;
    return [235 * light * p, 130 * light * p, 30 * light * p];
  };
  const background = (x: number, y: number): Rgb => {
    const ring = Math.sin((y + wood(x, y) * 40) / 7) * 0.5 + 0.5;
    const c = mix([150, 98, 58], [182, 128, 80], ring);
    // The orange's shadow, down and to the right.
    const d = Math.hypot(x - cx - radius * 0.25, (y - cy - radius * 0.3) * 1.4) / radius;
    const s = 1 - 0.45 * clamp01(1.3 - d);
    return [c[0] * s, c[1] * s, c[2] * s];
  };
  return draw(radius < 80 ? 'small orange' : 'orange', W, H, inside, object, background, 5);
}

/** Two discs joined by a thin bar (a dumbbell) on grey carpet. */
export function dumbbell(): Scene {
  const inside = (x: number, y: number) =>
    Math.hypot(x - 430, y - 400) < 90 || Math.hypot(x - 770, y - 400) < 90 || (x >= 430 && x < 770 && Math.abs(y - 400) < 6);
  const carpet = fractal(41, 6, 3);
  const metal = fractal(42, 50);
  const object = (x: number, y: number): Rgb => {
    const v = 50 + metal(x, y) * 14 + (Math.abs(y - 400) < 6 ? 60 : 0);
    return [v, v, v + 6];
  };
  const background = (x: number, y: number): Rgb => {
    const v = 150 + carpet(x, y) * 40;
    return [v, v - 4, v - 10];
  };
  return draw('dumbbell', W, H, inside, object, background, 6);
}

export type ObjectSelectionTarget = { rect: CropBox } | { point: ImagePoint };

export interface ObjectSelectionCase {
  /** What the case tests. */
  label: string;
  scene: () => Scene;
  target: ObjectSelectionTarget;
}

const box = (x0: number, y0: number, x1: number, y1: number): ObjectSelectionTarget => ({ rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });

/** One scene object per kind, built once. */
const once = <T>(make: () => T): (() => T) => {
  let v: T | undefined;
  return () => (v ??= make());
};
const scenes = {
  haze: once(() => hazeCastle(0.75)),
  clear: once(() => hazeCastle(0.3)),
  shared: once(sharedColours),
  pole: once(thinPole),
  orange: once(() => orangeOnTable()),
  small: once(() => orangeOnTable(40, 820, 260)),
  dumbbell: once(dumbbell),
};

export const OBJECT_SELECTION_CASES: ObjectSelectionCase[] = [
  { label: 'orange, tight box', scene: scenes.orange, target: box(440, 240, 760, 560) },
  { label: 'orange, loose box', scene: scenes.orange, target: box(330, 130, 870, 670) },
  { label: 'orange, click', scene: scenes.orange, target: { point: { x: 600, y: 400 } } },
  { label: 'small orange, box', scene: scenes.small, target: box(770, 210, 870, 310) },
  { label: 'small orange, click', scene: scenes.small, target: { point: { x: 820, y: 260 } } },
  { label: 'clear castle, box', scene: scenes.clear, target: box(390, 125, 810, 715) },
  { label: 'clear castle, click', scene: scenes.clear, target: { point: { x: 600, y: 470 } } },
  { label: 'haze castle, box', scene: scenes.haze, target: box(390, 125, 810, 715) },
  { label: 'haze castle, loose box', scene: scenes.haze, target: box(280, 60, 920, 780) },
  { label: 'haze castle, click', scene: scenes.haze, target: { point: { x: 600, y: 470 } } },
  { label: 'shared colours, box', scene: scenes.shared, target: box(350, 240, 970, 670) },
  { label: 'shared colours, click', scene: scenes.shared, target: { point: { x: 600, y: 430 } } },
  { label: 'thin pole, box', scene: scenes.pole, target: box(550, 120, 650, 770) },
  { label: 'dumbbell, box', scene: scenes.dumbbell, target: box(320, 290, 880, 510) },
  { label: 'dumbbell, click', scene: scenes.dumbbell, target: { point: { x: 430, y: 400 } } },
];

export interface ObjectSelectionScore {
  /** Intersection over union with the true mask, both at half coverage. */
  iou: number;
  /** Object pixels left out and background pixels taken, as shares of the object's area. */
  missed: number;
  extra: number;
}

/** Scores `value(x, y)` (the selection, 0..1) against the scene's true mask. */
export function scoreSelection(scene: Scene, value: (x: number, y: number) => number): ObjectSelectionScore {
  let both = 0;
  let missed = 0;
  let extra = 0;
  let area = 0;
  for (let y = 0; y < scene.height; y++) {
    for (let x = 0; x < scene.width; x++) {
      const t = scene.truth[y * scene.width + x] >= 0.5;
      const s = value(x, y) >= 0.5;
      if (t) area++;
      if (t && s) both++;
      else if (t) missed++;
      else if (s) extra++;
    }
  }
  return { iou: both / Math.max(1, both + missed + extra), missed: missed / Math.max(1, area), extra: extra / Math.max(1, area) };
}
