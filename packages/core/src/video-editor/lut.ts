/**
 * 3D LUTs for grades: `.cube` files read into a lattice and applied with tetrahedral
 * interpolation, as ffmpeg's `lut3d=interp=tetrahedral` and grading apps apply them, so the
 * preview and the export agree. A grade's LUT (`VideoGrade.lut`) runs after its other steps and is
 * mixed with the picture before it by `strength`.
 */

/** A 3D LUT: `size`³ output colours, red changing fastest, then green, then blue (the `.cube` order). */
export interface VideoLut {
	title?: string;
	size: number;
	/** Input values mapped to the first and last lattice points, per channel (default 0 and 1). */
	domainMin: [number, number, number];
	domainMax: [number, number, number];
	/** `size³ × 3` output values. */
	data: Float32Array;
}

/** Largest `LUT_3D_SIZE` read (129³ rows is about 2 million). */
export const VIDEO_LUT_MAX_SIZE = 129;

/** Reads a `.cube` file's 3D table. Errors give the line and what is wrong. */
export function parseVideoCubeLut(text: string): VideoLut {
	let size = 0;
	let size1 = 0;
	let title: string | undefined;
	const domainMin: [number, number, number] = [0, 0, 0];
	const domainMax: [number, number, number] = [1, 1, 1];
	let data: Float32Array | null = null;
	let rows = 0;
	const lines = text.split(/\r\n|\r|\n/);
	const fail = (line: number, message: string): never => {
		throw new Error(`Line ${line + 1} of the .cube file: ${message}.`);
	};
	const numbers = (parts: string[], line: number) =>
		parts.map((p) => {
			const v = Number(p);
			if (!Number.isFinite(v)) fail(line, `"${p}" is not a number`);
			return v;
		});
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].replace(/#.*/, '').trim();
		if (!line) continue;
		const parts = line.split(/\s+/);
		const key = parts[0];
		if (/^[A-Za-z]/.test(key)) {
			if (rows) fail(i, `"${key}" comes after the table; keywords go before it`);
			if (key === 'TITLE') title = line.slice(5).trim().replace(/^"|"$/g, '');
			else if (key === 'LUT_3D_SIZE') {
				size = Number(parts[1]);
				if (!Number.isInteger(size) || size < 2 || size > VIDEO_LUT_MAX_SIZE) fail(i, `LUT_3D_SIZE must be a whole number from 2 to ${VIDEO_LUT_MAX_SIZE}, not "${parts[1] ?? ''}"`);
			} else if (key === 'LUT_1D_SIZE') size1 = Number(parts[1]) || 1;
			else if (key === 'DOMAIN_MIN' || key === 'DOMAIN_MAX') {
				const v = numbers(parts.slice(1), i);
				if (v.length !== 3) fail(i, `${key} needs 3 numbers`);
				(key === 'DOMAIN_MIN' ? domainMin : domainMax).splice(0, 3, ...v);
			} else if (key === 'LUT_3D_INPUT_RANGE') {
				const v = numbers(parts.slice(1), i);
				if (v.length !== 2 || !(v[1] > v[0])) fail(i, 'LUT_3D_INPUT_RANGE needs a minimum and a larger maximum');
				domainMin.fill(v[0]);
				domainMax.fill(v[1]);
			}
			continue;
		}
		if (!size) fail(i, size1 ? 'this is a 1D LUT (LUT_1D_SIZE); only 3D LUTs (LUT_3D_SIZE) are supported' : 'the table starts before LUT_3D_SIZE');
		data ??= new Float32Array(size * size * size * 3);
		const v = numbers(parts, i);
		if (v.length !== 3) fail(i, `a table row needs 3 numbers, not ${v.length}`);
		if (rows >= size ** 3) fail(i, `the table has more than the ${size ** 3} rows LUT_3D_SIZE ${size} needs`);
		data.set(v, rows * 3);
		rows++;
	}
	if (!size) throw new Error(size1 ? 'The .cube file is a 1D LUT (LUT_1D_SIZE); only 3D LUTs (LUT_3D_SIZE) are supported.' : 'The .cube file has no LUT_3D_SIZE line, so it is not a 3D LUT.');
	if (rows !== size ** 3) throw new Error(`The .cube file has ${rows} table rows; LUT_3D_SIZE ${size} needs ${size ** 3}.`);
	for (let c = 0; c < 3; c++) if (!(domainMax[c] > domainMin[c])) throw new Error('The .cube file\'s DOMAIN_MAX must be larger than its DOMAIN_MIN on every channel.');
	return { ...(title ? { title } : {}), size, domainMin, domainMax, data: data! };
}

/** A LUT of `size` points a side built from a colour function (each channel 0–1 in and out). */
export function videoLutFromFunction(size: number, fn: (rgb: [number, number, number]) => readonly [number, number, number], title?: string): VideoLut {
	const n = size - 1;
	const data = new Float32Array(size ** 3 * 3);
	let i = 0;
	for (let b = 0; b < size; b++)
		for (let g = 0; g < size; g++)
			for (let r = 0; r < size; r++) {
				data.set(fn([r / n, g / n, b / n]), i);
				i += 3;
			}
	return { ...(title ? { title } : {}), size, domainMin: [0, 0, 0], domainMax: [1, 1, 1], data };
}

/** A LUT as `.cube` text. */
export function videoLutToCube(lut: VideoLut): string {
	const f = (v: number) => (Math.round(v * 1e6) / 1e6).toString();
	const head = [...(lut.title ? [`TITLE "${lut.title.replace(/"/g, "'")}"`] : []), `LUT_3D_SIZE ${lut.size}`];
	if (lut.domainMin.some((v) => v !== 0) || lut.domainMax.some((v) => v !== 1)) head.push(`DOMAIN_MIN ${lut.domainMin.map(f).join(' ')}`, `DOMAIN_MAX ${lut.domainMax.map(f).join(' ')}`);
	const rows: string[] = [];
	for (let i = 0; i < lut.data.length; i += 3) rows.push(`${f(lut.data[i])} ${f(lut.data[i + 1])} ${f(lut.data[i + 2])}`);
	return `${head.join('\n')}\n${rows.join('\n')}\n`;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * A colour (each channel 0–1) through a LUT with tetrahedral interpolation: the lattice cube
 * around the colour is split into six tetrahedra along its grey diagonal, and the colour is mixed
 * from the four corners of the one it falls in. Greys stay on the diagonal, unlike trilinear.
 */
export function applyVideoLut(lut: VideoLut, rgb: readonly [number, number, number], out: [number, number, number] = [0, 0, 0]): [number, number, number] {
	const { size, data, domainMin, domainMax } = lut;
	const n = size - 1;
	const x = clamp01((rgb[0] - domainMin[0]) / (domainMax[0] - domainMin[0])) * n;
	const y = clamp01((rgb[1] - domainMin[1]) / (domainMax[1] - domainMin[1])) * n;
	const z = clamp01((rgb[2] - domainMin[2]) / (domainMax[2] - domainMin[2])) * n;
	const r0 = Math.min(n - 1, Math.floor(x));
	const g0 = Math.min(n - 1, Math.floor(y));
	const b0 = Math.min(n - 1, Math.floor(z));
	const fr = x - r0;
	const fg = y - g0;
	const fb = z - b0;
	// Offsets (in values) of a step along r, g and b.
	const sr = 3;
	const sg = 3 * size;
	const sb = 3 * size * size;
	const o = r0 * sr + g0 * sg + b0 * sb;
	// The path through the cube from (0,0,0) to (1,1,1) follows the largest fraction first.
	let a: number, c: number, w0: number, w1: number, w2: number, w3: number;
	if (fr > fg) {
		if (fg > fb) [a, c, w0, w1, w2, w3] = [sr, sr + sg, 1 - fr, fr - fg, fg - fb, fb];
		else if (fr > fb) [a, c, w0, w1, w2, w3] = [sr, sr + sb, 1 - fr, fr - fb, fb - fg, fg];
		else [a, c, w0, w1, w2, w3] = [sb, sb + sr, 1 - fb, fb - fr, fr - fg, fg];
	} else if (fb > fg) [a, c, w0, w1, w2, w3] = [sb, sb + sg, 1 - fb, fb - fg, fg - fr, fr];
	else if (fb > fr) [a, c, w0, w1, w2, w3] = [sg, sg + sb, 1 - fg, fg - fb, fb - fr, fr];
	else [a, c, w0, w1, w2, w3] = [sg, sg + sr, 1 - fg, fg - fr, fr - fb, fb];
	const d = sr + sg + sb;
	for (let k = 0; k < 3; k++) out[k] = clamp01(w0 * data[o + k] + w1 * data[o + a + k] + w2 * data[o + c + k] + w3 * data[o + d + k]);
	return out;
}

/**
 * How much a colour (0–1 sRGB) looks like skin, 0–1: its chroma (BT.601 Cb / Cr) against the
 * skin cluster, which holds for every complexion because skin differs mostly in lightness, not in
 * hue. Full weight inside the cluster, falling smoothly to 0 just outside it, and faded out near
 * black and white, where chroma means little. Used by `preserveSkinTones`.
 */
export function videoSkinToneWeight(r: number, g: number, b: number): number {
	const R = r * 255;
	const G = g * 255;
	const B = b * 255;
	const y = 0.299 * R + 0.587 * G + 0.114 * B;
	if (y < 20 || y > 250) return 0;
	const cb = 128 - 0.168736 * R - 0.331264 * G + 0.5 * B;
	const cr = 128 + 0.5 * R - 0.418688 * G - 0.081312 * B;
	const d = Math.hypot((cb - 108) / 20, (cr - 154) / 18);
	let w = d <= 1 ? 1 : d >= 1.5 ? 0 : 1 - smooth((d - 1) / 0.5);
	// Fade out over the darkest and brightest few steps.
	if (y < 40) w *= (y - 20) / 20;
	else if (y > 235) w *= (250 - y) / 15;
	return w;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * Runs RGBA pixels (0–255, e.g. `ImageData.data`) through a LUT in place, mixed by `strength`.
 * With `preserveSkinTones` (0–1) the mix is held back by that much on skin (see `videoSkinToneWeight`).
 */
export function applyVideoLutToPixels(lut: VideoLut, data: { length: number; [i: number]: number }, strength = 1, preserveSkinTones = 0): void {
	const s = clamp01(strength);
	if (!s) return;
	const skin = clamp01(preserveSkinTones);
	const rgb: [number, number, number] = [0, 0, 0];
	const out: [number, number, number] = [0, 0, 0];
	for (let i = 0; i < data.length; i += 4) {
		if (!data[i + 3]) continue;
		rgb[0] = data[i] / 255;
		rgb[1] = data[i + 1] / 255;
		rgb[2] = data[i + 2] / 255;
		applyVideoLut(lut, rgb, out);
		const k = skin ? s * (1 - skin * videoSkinToneWeight(rgb[0], rgb[1], rgb[2])) : s;
		for (let c = 0; c < 3; c++) data[i + c] = Math.round((rgb[c] + (out[c] - rgb[c]) * k) * 255);
	}
}

/**
 * An SVG approximation of a LUT for SVG frames, which have no 3D tables: per-channel curves taken
 * along the LUT's grey axis (`feComponentTransfer` tables), then the colour matrix that best fits
 * the rest (least squares over the lattice). Exact for LUTs that are curves or a matrix; close for
 * most looks. The preview and the export apply the LUT itself.
 */
export interface VideoLutSvgApproximation {
	/** Per-channel curve tables (`tableValues`), each 0–1. */
	tables: [number[], number[], number[]];
	/** A 3 × 4 matrix (rows r, g, b; columns r, g, b, offset) applied after the curves. */
	matrix: number[][];
}

const approximations = new WeakMap<VideoLut, VideoLutSvgApproximation>();

export function videoLutSvgApproximation(lut: VideoLut): VideoLutSvgApproximation {
	const cached = approximations.get(lut);
	if (cached) return cached;
	const points = 17;
	const tables: [number[], number[], number[]] = [[], [], []];
	for (let i = 0; i < points; i++) {
		const v = i / (points - 1);
		const out = applyVideoLut(lut, [v, v, v]);
		for (let k = 0; k < 3; k++) tables[k].push(out[k]);
	}
	const curve = (k: number, v: number) => {
		const x = clamp01(v) * (points - 1);
		const i = Math.min(points - 2, Math.floor(x));
		return tables[k][i] + (tables[k][i + 1] - tables[k][i]) * (x - i);
	};
	// Least squares: matrix rows minimising |M·[curve(x), 1] − lut(x)|² over a 9³ grid.
	const ata = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
	const atb = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
	const grid = 9;
	for (let b = 0; b < grid; b++)
		for (let g = 0; g < grid; g++)
			for (let r = 0; r < grid; r++) {
				const x: [number, number, number] = [r / (grid - 1), g / (grid - 1), b / (grid - 1)];
				const z = [curve(0, x[0]), curve(1, x[1]), curve(2, x[2]), 1];
				const y = applyVideoLut(lut, x);
				for (let i = 0; i < 4; i++) {
					for (let j = 0; j < 4; j++) ata[i][j] += z[i] * z[j];
					for (let k = 0; k < 3; k++) atb[k][i] += z[i] * y[k];
				}
			}
	const matrix = atb.map((rhs) => solve4(ata, rhs));
	const result = { tables, matrix };
	approximations.set(lut, result);
	return result;
}

/** Solves a 4 × 4 system by Gaussian elimination with partial pivoting (falls back to identity rows when singular). */
function solve4(a: number[][], b: number[]): number[] {
	const m = a.map((row, i) => [...row, b[i]]);
	for (let col = 0; col < 4; col++) {
		let pivot = col;
		for (let r = col + 1; r < 4; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
		if (Math.abs(m[pivot][col]) < 1e-12) continue;
		[m[col], m[pivot]] = [m[pivot], m[col]];
		for (let r = 0; r < 4; r++) {
			if (r === col) continue;
			const f = m[r][col] / m[col][col];
			for (let c = col; c < 5; c++) m[r][c] -= f * m[col][c];
		}
	}
	return m.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[4] / row[i]));
}

/** Where LUT files come from: their text for a `src` (default: `fetch`). */
export type VideoLutLoader = (src: string) => Promise<string | VideoLut>;

/**
 * Loaded LUTs by `src`, read once and shared by the preview, SVG frames and agent tools
 * (`VideoEditorController.luts`). Listeners hear when one loads or fails.
 */
export class VideoLutCache {
	private readonly ready = new Map<string, VideoLut>();
	private readonly pending = new Map<string, Promise<VideoLut>>();
	private readonly failed = new Map<string, string>();
	private readonly listeners = new Set<() => void>();

	constructor(
		private readonly loader: VideoLutLoader = async (src) => {
			const res = await fetch(src);
			if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
			return res.text();
		}
	) {}

	/** The LUT if loaded, without starting to load it. */
	peek(src: string): VideoLut | undefined {
		return this.ready.get(src);
	}

	/** The LUT if loaded; otherwise `undefined`, and loading starts (once) unless it failed. */
	get(src: string): VideoLut | undefined {
		const lut = this.ready.get(src);
		if (!lut && !this.failed.has(src)) void this.load(src).catch(() => {});
		return lut;
	}

	/** Why loading a LUT failed, if it did. */
	error(src: string): string | undefined {
		return this.failed.get(src);
	}

	/** The LUT, loading and reading it if needed. Rejects with a readable error. */
	load(src: string): Promise<VideoLut> {
		const ready = this.ready.get(src);
		if (ready) return Promise.resolve(ready);
		const failed = this.failed.get(src);
		if (failed) return Promise.reject(new Error(failed));
		let pending = this.pending.get(src);
		if (!pending) {
			pending = Promise.resolve()
				.then(() => this.loader(src))
				.then((v) => (typeof v === 'string' ? parseVideoCubeLut(v) : v))
				.then(
					(lut) => {
						this.pending.delete(src);
						this.ready.set(src, lut);
						this.emit();
						return lut;
					},
					(e: unknown) => {
						this.pending.delete(src);
						const message = `The LUT "${src}" could not be read: ${e instanceof Error ? e.message : String(e)}`;
						this.failed.set(src, message);
						this.emit();
						throw new Error(message);
					}
				);
			this.pending.set(src, pending);
		}
		return pending;
	}

	/** Uses a LUT the host already has (`.cube` text or a parsed LUT), under `src`. */
	set(src: string, lut: VideoLut | string): VideoLut {
		const parsed = typeof lut === 'string' ? parseVideoCubeLut(lut) : lut;
		this.ready.set(src, parsed);
		this.failed.delete(src);
		this.emit();
		return parsed;
	}

	/** Forgets a failure so the next `get` tries again. */
	retry(src: string): void {
		if (this.failed.delete(src)) this.emit();
	}

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	private emit() {
		for (const l of [...this.listeners]) l();
	}
}
