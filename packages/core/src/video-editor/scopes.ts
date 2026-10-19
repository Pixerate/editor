/**
 * Colour scopes: a histogram, a luma waveform and a vectorscope, worked out from a frame's pixels,
 * plus exposure and clipping figures. Pure functions on RGBA pixels as `ImageData` holds them, so
 * the same numbers come from a preview canvas, a decoded export frame or a test.
 *
 * Luma and chroma use the Rec. 709 weights on the gamma-encoded values (Y′, Cb, Cr), as broadcast
 * scopes do: luma 0 is black and 1 white; Cb and Cr run from −0.5 to 0.5.
 */

/** RGBA pixels, 4 values (0–255) a pixel, rows top to bottom: an `ImageData` fits. */
export interface VideoPixels {
	width: number;
	height: number;
	data: ArrayLike<number>;
}

export type VideoScopeKind = 'histogram' | 'waveform' | 'vectorscope';
export const VIDEO_SCOPE_KINDS = ['histogram', 'waveform', 'vectorscope'] as const;

/** Rec. 709 luma of gamma-encoded RGB (each 0–1). */
export const videoLuma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Rec. 709 chroma (Cb, Cr), each −0.5 to 0.5, of gamma-encoded RGB (each 0–1). */
export function videoChroma(r: number, g: number, b: number): [number, number] {
	const y = videoLuma(r, g, b);
	return [(b - y) / 1.8556, (r - y) / 1.5748];
}

export interface VideoScopeOptions {
	/**
	 * Read at most about this many pixels, evenly spaced (default 262 144, a 512 × 512 picture), so
	 * a large frame costs no more than a small one. Counts are of the pixels read.
	 */
	maxPixels?: number;
}

/** Calls `visit(r, g, b, x, y)` (0–255 values) for evenly spaced pixels, at most about `maxPixels`. */
function eachPixel(pixels: VideoPixels, maxPixels: number | undefined, visit: (r: number, g: number, b: number, x: number, y: number) => void): number {
	const { width, height, data } = pixels;
	if (!(width > 0 && height > 0) || data.length < width * height * 4) throw new Error(`The pixels are not ${width} × ${height} RGBA: there are ${data.length} values, and ${width * height * 4} are needed.`);
	const step = Math.max(1, Math.sqrt((width * height) / Math.max(1, maxPixels ?? 262_144)));
	let count = 0;
	for (let fy = step / 2; fy < height; fy += step) {
		const y = Math.floor(fy);
		for (let fx = step / 2; fx < width; fx += step) {
			const x = Math.floor(fx);
			const i = (y * width + x) * 4;
			visit(data[i], data[i + 1], data[i + 2], x, y);
			count++;
		}
	}
	return count;
}

/** How many pixels fall in each of `bins` equal steps of red, green, blue and luma (bin 0 is darkest). */
export interface VideoHistogram {
	bins: number;
	r: number[];
	g: number[];
	b: number[];
	luma: number[];
	/** Pixels counted. */
	total: number;
}

// The nudge keeps a grey whose luma comes out a hair under its value (39.99999…) in its own step.
const binOf = (v: number, bins: number) => Math.min(bins - 1, Math.floor(((v + 1e-6) / 256) * bins));

export function videoHistogram(pixels: VideoPixels, options: VideoScopeOptions & { bins?: number } = {}): VideoHistogram {
	const bins = Math.max(1, Math.min(256, Math.round(options.bins ?? 256)));
	const out: VideoHistogram = { bins, r: Array(bins).fill(0), g: Array(bins).fill(0), b: Array(bins).fill(0), luma: Array(bins).fill(0), total: 0 };
	out.total = eachPixel(pixels, options.maxPixels, (r, g, b) => {
		out.r[binOf(r, bins)]++;
		out.g[binOf(g, bins)]++;
		out.b[binOf(b, bins)]++;
		out.luma[binOf(videoLuma(r, g, b), bins)]++;
	});
	return out;
}

/**
 * A luma waveform: the picture split into `columns` vertical strips, left to right, each counting
 * its pixels at each of `levels` luma steps. `data[column * levels + level]`; level 0 is black.
 */
export interface VideoWaveform {
	columns: number;
	levels: number;
	data: Uint32Array;
	/** The largest count, for scaling a drawing. */
	peak: number;
}

export function videoLumaWaveform(pixels: VideoPixels, options: VideoScopeOptions & { columns?: number; levels?: number } = {}): VideoWaveform {
	const columns = Math.max(1, Math.min(pixels.width, Math.round(options.columns ?? Math.min(pixels.width, 256))));
	const levels = Math.max(2, Math.min(256, Math.round(options.levels ?? 128)));
	const data = new Uint32Array(columns * levels);
	let peak = 0;
	eachPixel(pixels, options.maxPixels, (r, g, b, x) => {
		const c = Math.min(columns - 1, Math.floor((x / pixels.width) * columns));
		const i = c * levels + binOf(videoLuma(r, g, b), levels);
		if (++data[i] > peak) peak = data[i];
	});
	return { columns, levels, data, peak };
}

/**
 * A vectorscope: pixels counted on a `size` × `size` grid by chroma, Cb across (left −0.5, right
 * +0.5) and Cr up (top +0.5). The centre is grey; the further out, the more saturated; the angle
 * is the hue. `data[row * size + column]`.
 */
export interface VideoVectorscope {
	size: number;
	data: Uint32Array;
	peak: number;
}

/** Where chroma (Cb, Cr) falls on a vectorscope of `size` pixels, as `[column, row]`. */
export const videoVectorscopePoint = (cb: number, cr: number, size: number): [number, number] => [(cb + 0.5) * (size - 1), (0.5 - cr) * (size - 1)];

export function videoVectorscope(pixels: VideoPixels, options: VideoScopeOptions & { size?: number } = {}): VideoVectorscope {
	const size = Math.max(16, Math.min(512, Math.round(options.size ?? 128)));
	const data = new Uint32Array(size * size);
	let peak = 0;
	eachPixel(pixels, options.maxPixels, (r, g, b) => {
		const [cb, cr] = videoChroma(r / 255, g / 255, b / 255);
		const [x, y] = videoVectorscopePoint(cb, cr, size);
		const i = Math.round(y) * size + Math.round(x);
		if (++data[i] > peak) peak = data[i];
	});
	return { size, data, peak };
}

/** Exposure and colour figures for a frame (see `videoExposureStats`). Luma and levels run 0–1. */
export interface VideoExposureStats {
	/** Pixels read. */
	pixels: number;
	luma: { mean: number; median: number; min: number; max: number; p1: number; p99: number };
	/** Share (0–1) of pixels crushed to black (luma at or below `shadowLevel`) or blown to white (at or above `highlightLevel`). */
	clipped: { shadows: number; highlights: number; r: number; g: number; b: number };
	/** Mean and highest chroma, 0 (grey) to 1 (a full primary). */
	saturation: { mean: number; max: number };
	/** The mean colour as `#rrggbb`: far from grey means a colour cast. */
	average: string;
}

export interface VideoExposureOptions extends VideoScopeOptions {
	/** Luma (0–1) at or below which a pixel counts as crushed (default 0.02). */
	shadowLevel?: number;
	/** Luma or channel (0–1) at or above which a pixel counts as blown (default 0.98). */
	highlightLevel?: number;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const hex2 = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');

export function videoExposureStats(pixels: VideoPixels, options: VideoExposureOptions = {}): VideoExposureStats {
	const low = (options.shadowLevel ?? 0.02) * 255;
	const high = (options.highlightLevel ?? 0.98) * 255;
	const lumaBins = new Uint32Array(256);
	let sumY = 0;
	let sumR = 0;
	let sumG = 0;
	let sumB = 0;
	let sumSat = 0;
	let maxSat = 0;
	let shadows = 0;
	let highlights = 0;
	let cr = 0;
	let cg = 0;
	let cbl = 0;
	const total = eachPixel(pixels, options.maxPixels, (r, g, b) => {
		const y = videoLuma(r, g, b);
		lumaBins[Math.min(255, Math.round(y))]++;
		sumY += y;
		sumR += r;
		sumG += g;
		sumB += b;
		const [u, v] = videoChroma(r / 255, g / 255, b / 255);
		const sat = Math.min(1, Math.hypot(u, v) / 0.5);
		sumSat += sat;
		if (sat > maxSat) maxSat = sat;
		if (y <= low) shadows++;
		if (y >= high) highlights++;
		if (r >= high) cr++;
		if (g >= high) cg++;
		if (b >= high) cbl++;
	});
	const percentile = (p: number) => {
		const target = p * total;
		let seen = 0;
		for (let i = 0; i < 256; i++) {
			seen += lumaBins[i];
			if (seen >= target && seen > 0) return i / 255;
		}
		return 1;
	};
	let min = 0;
	while (min < 255 && !lumaBins[min]) min++;
	let max = 255;
	while (max > 0 && !lumaBins[max]) max--;
	return {
		pixels: total,
		luma: { mean: round3(sumY / total / 255), median: round3(percentile(0.5)), min: round3(min / 255), max: round3(max / 255), p1: round3(percentile(0.01)), p99: round3(percentile(0.99)) },
		clipped: { shadows: round3(shadows / total), highlights: round3(highlights / total), r: round3(cr / total), g: round3(cg / total), b: round3(cbl / total) },
		saturation: { mean: round3(sumSat / total), max: round3(maxSat) },
		average: `#${hex2(sumR / total)}${hex2(sumG / total)}${hex2(sumB / total)}`
	};
}

/** What a scope reading says in words: exposure, clipping and colour cast worth fixing. */
export function videoExposureNotes(stats: VideoExposureStats): string[] {
	const notes: string[] = [];
	const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;
	if (stats.clipped.shadows >= 0.05) notes.push(`${pct(stats.clipped.shadows)} of the picture is crushed to black; raise exposure or lower contrast.`);
	if (stats.clipped.highlights >= 0.02) notes.push(`${pct(stats.clipped.highlights)} of the picture is blown to white; lower exposure.`);
	else {
		const channels = (['r', 'g', 'b'] as const).filter((k) => stats.clipped[k] >= 0.05);
		if (channels.length) notes.push(`The ${channels.map((k) => ({ r: 'red', g: 'green', b: 'blue' })[k]).join(' and ')} channel${channels.length > 1 ? 's clip' : ' clips'} in ${pct(Math.max(...channels.map((k) => stats.clipped[k])))} of the picture; lower exposure or saturation.`);
	}
	if (stats.luma.mean < 0.2 && stats.clipped.shadows < 0.05) notes.push(`The picture is dark (mean luma ${stats.luma.mean}); raise exposure if it is not meant to be.`);
	if (stats.luma.mean > 0.75 && stats.clipped.highlights < 0.02) notes.push(`The picture is bright (mean luma ${stats.luma.mean}); lower exposure if it is not meant to be.`);
	if (stats.luma.p99 - stats.luma.p1 < 0.3 && stats.pixels > 1) notes.push(`The picture is flat (most of it lies between luma ${stats.luma.p1} and ${stats.luma.p99}); raise contrast.`);
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(stats.average.slice(i, i + 2), 16) / 255);
	const [u, v] = videoChroma(r, g, b);
	if (Math.hypot(u, v) > 0.04 && stats.saturation.mean < 0.35) {
		const warm = v - u;
		notes.push(`The picture has a ${Math.abs(warm) > Math.abs(v + u) * 0.5 ? (warm > 0 ? 'warm (orange)' : 'cool (blue)') : v > 0 ? 'magenta' : 'green'} cast (average ${stats.average}); adjust temperature and tint.`);
	}
	return notes;
}

/** A compact reading of a frame for agents: exposure figures, notes, and coarse histogram, waveform and vectorscope summaries. */
export interface VideoScopeSummary {
	stats: VideoExposureStats;
	notes: string[];
	/** Share of pixels (0–1) in each of `bins` equal luma and channel steps, darkest first. */
	histogram: { bins: number; luma: number[]; r: number[]; g: number[]; b: number[] };
	/** The picture in vertical strips, left to right: each strip's luma spread (0–1). */
	waveform: { start: number; end: number; min: number; median: number; max: number }[];
	/** The chroma of the most saturated tenth of the picture: its main hue (degrees on the vectorscope, red ≈ 103°) and strength (0–1). */
	vectorscope: { hue: number | null; strength: number; spread: number };
}

/** Vectorscope angle (degrees, anticlockwise from +Cb) of chroma. */
export const videoVectorscopeAngle = (cb: number, cr: number): number => (((Math.atan2(cr, cb) * 180) / Math.PI) % 360 + 360) % 360;

export function summarizeVideoScopes(pixels: VideoPixels, options: VideoExposureOptions & { bins?: number; columns?: number } = {}): VideoScopeSummary {
	const stats = videoExposureStats(pixels, options);
	const bins = Math.max(2, Math.min(64, Math.round(options.bins ?? 16)));
	const h = videoHistogram(pixels, { ...options, bins });
	const share = (a: number[]) => a.map((v) => round3(v / h.total));
	const columns = Math.max(1, Math.min(32, Math.round(options.columns ?? 8)));
	const w = videoLumaWaveform(pixels, { ...options, columns, levels: 256 });
	const waveform = Array.from({ length: w.columns }, (_, c) => {
		const counts = w.data.subarray(c * 256, c * 256 + 256);
		const n = counts.reduce((a, b) => a + b, 0);
		let lo = 0;
		while (lo < 255 && !counts[lo]) lo++;
		let hi = 255;
		while (hi > 0 && !counts[hi]) hi--;
		let seen = 0;
		let median = 0;
		for (let i = 0; i < 256; i++) {
			seen += counts[i];
			if (seen >= n / 2 && n) {
				median = i;
				break;
			}
		}
		return { start: round3(c / w.columns), end: round3((c + 1) / w.columns), min: round3(lo / 255), median: round3(median / 255), max: round3(hi / 255) };
	}).filter((_, c) => w.data.subarray(c * 256, c * 256 + 256).some((v) => v > 0));
	// The most saturated tenth: its mean direction is the picture's main hue.
	const chroma: [number, number, number][] = [];
	eachPixel(pixels, Math.min(options.maxPixels ?? 65_536, 65_536), (r, g, b) => {
		const [u, v] = videoChroma(r / 255, g / 255, b / 255);
		chroma.push([u, v, Math.hypot(u, v)]);
	});
	chroma.sort((a, b) => b[2] - a[2]);
	const top = chroma.slice(0, Math.max(1, Math.ceil(chroma.length / 10)));
	const mu = top.reduce((s, c) => s + c[0], 0) / top.length;
	const mv = top.reduce((s, c) => s + c[1], 0) / top.length;
	const strength = Math.min(1, top.reduce((s, c) => s + c[2], 0) / top.length / 0.5);
	const coherence = Math.hypot(mu, mv) / Math.max(1e-9, top.reduce((s, c) => s + c[2], 0) / top.length);
	return {
		stats,
		notes: videoExposureNotes(stats),
		histogram: { bins, luma: share(h.luma), r: share(h.r), g: share(h.g), b: share(h.b) },
		waveform,
		vectorscope: { hue: strength < 0.02 ? null : Math.round(videoVectorscopeAngle(mu, mv)), strength: round3(strength), spread: round3(1 - coherence) }
	};
}

/** Where the six 75% colour-bar targets sit on a vectorscope: name, Cb and Cr. */
export const VIDEO_VECTORSCOPE_TARGETS: readonly { name: string; rgb: [number, number, number]; cb: number; cr: number }[] = (
	[
		['R', [0.75, 0, 0]],
		['Mg', [0.75, 0, 0.75]],
		['B', [0, 0, 0.75]],
		['Cy', [0, 0.75, 0.75]],
		['G', [0, 0.75, 0]],
		['Yl', [0.75, 0.75, 0]]
	] as const
).map(([name, rgb]) => {
	const [cb, cr] = videoChroma(rgb[0], rgb[1], rgb[2]);
	return { name, rgb: [...rgb] as [number, number, number], cb, cr };
});

/** RGBA pixels of a drawn scope, ready for `new ImageData(data, width, height)`. */
export interface VideoScopeImage {
	width: number;
	height: number;
	data: Uint8ClampedArray<ArrayBuffer>;
}

function canvas(width: number, height: number): VideoScopeImage {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < data.length; i += 4) {
		data[i] = 12;
		data[i + 1] = 14;
		data[i + 2] = 18;
		data[i + 3] = 255;
	}
	return { width, height, data };
}

function plot(img: VideoScopeImage, x: number, y: number, rgb: readonly [number, number, number], alpha = 1, add = false) {
	const xi = Math.round(x);
	const yi = Math.round(y);
	if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) return;
	const i = (yi * img.width + xi) * 4;
	for (let k = 0; k < 3; k++) img.data[i + k] = add ? img.data[i + k] + rgb[k] * alpha : img.data[i + k] * (1 - alpha) + rgb[k] * alpha;
}

const GRID: [number, number, number] = [70, 76, 88];
/** Brightness for a count: log-scaled so a few pixels still show next to a large flat area. */
const glow = (count: number, peak: number) => (count ? 0.25 + 0.75 * (Math.log1p(count) / Math.log1p(Math.max(1, peak))) : 0);

/** A histogram drawn `width` × `height`: red, green and blue added together, with luma as a white outline. */
export function videoHistogramImage(h: VideoHistogram, width = 256, height = 128): VideoScopeImage {
	const img = canvas(width, height);
	for (const q of [0.25, 0.5, 0.75]) for (let y = 0; y < height; y++) plot(img, q * (width - 1), y, GRID);
	// Scale to the tallest bin away from the ends, so a clipped spike does not flatten everything else.
	const inner = (a: number[]) => (a.length > 2 ? a.slice(1, -1) : a);
	const peak = Math.max(1, ...inner(h.r), ...inner(h.g), ...inner(h.b), ...inner(h.luma));
	const height01 = (v: number) => Math.min(1, Math.sqrt(v / peak));
	for (let x = 0; x < width; x++) {
		const bin = Math.min(h.bins - 1, Math.floor((x / width) * h.bins));
		const channels: [number[], [number, number, number]][] = [
			[h.r, [200, 40, 40]],
			[h.g, [40, 180, 40]],
			[h.b, [50, 80, 220]]
		];
		for (const [a, rgb] of channels) {
			const top = height - height01(a[bin]) * height;
			for (let y = Math.ceil(top); y < height; y++) plot(img, x, y, rgb, 0.8, true);
		}
		plot(img, x, height - 1 - height01(h.luma[bin]) * (height - 1), [255, 255, 255]);
	}
	return img;
}

/** A luma waveform drawn `width` × `height`: white at the top, black at the bottom, lines at each quarter. */
export function videoWaveformImage(w: VideoWaveform, width = 256, height = 128): VideoScopeImage {
	const img = canvas(width, height);
	for (const q of [0, 0.25, 0.5, 0.75, 1]) for (let x = 0; x < width; x++) plot(img, x, (1 - q) * (height - 1), GRID);
	for (let x = 0; x < width; x++) {
		const c = Math.min(w.columns - 1, Math.floor((x / width) * w.columns));
		for (let y = 0; y < height; y++) {
			const level = Math.min(w.levels - 1, Math.floor(((height - 1 - y) / height) * w.levels));
			const a = glow(w.data[c * w.levels + level], w.peak);
			if (a) plot(img, x, y, [120, 255, 140], a);
		}
	}
	return img;
}

/** A vectorscope drawn `size` × `size`, with its outer circle, the skin-tone line and the colour-bar targets. */
export function videoVectorscopeImage(v: VideoVectorscope, size = v.size): VideoScopeImage {
	const img = canvas(size, size);
	const c = (size - 1) / 2;
	for (let a = 0; a < 720; a++) {
		const t = (a / 720) * 2 * Math.PI;
		plot(img, c + Math.cos(t) * c, c - Math.sin(t) * c, GRID);
	}
	// The skin-tone (I) line, at 123° on a vectorscope.
	const skin = (123 * Math.PI) / 180;
	for (let r = 0; r < c; r++) plot(img, c + Math.cos(skin) * r, c - Math.sin(skin) * r, [140, 110, 90]);
	for (const t of VIDEO_VECTORSCOPE_TARGETS) {
		const [x, y] = videoVectorscopePoint(t.cb, t.cr, size);
		const rgb = t.rgb.map((k) => 80 + k * 200) as [number, number, number];
		for (let k = -3; k <= 3; k++) {
			plot(img, x + k, y - 3, rgb);
			plot(img, x + k, y + 3, rgb);
			plot(img, x - 3, y + k, rgb);
			plot(img, x + 3, y + k, rgb);
		}
	}
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++) {
			const sy = Math.min(v.size - 1, Math.floor((y / size) * v.size));
			const sx = Math.min(v.size - 1, Math.floor((x / size) * v.size));
			const a = glow(v.data[sy * v.size + sx], v.peak);
			if (!a) continue;
			// Each point takes the hue it stands for, so the scope reads like a colour wheel.
			const cb = sx / (v.size - 1) - 0.5;
			const cr = 0.5 - sy / (v.size - 1);
			const r = Math.min(1, Math.max(0, 0.6 + 1.5748 * cr));
			const g = Math.min(1, Math.max(0, 0.6 - 0.1873 * cb - 0.4681 * cr));
			const b = Math.min(1, Math.max(0, 0.6 + 1.8556 * cb));
			plot(img, x, y, [r * 255, g * 255, b * 255], a);
		}
	return img;
}

/** One scope of a frame drawn `width` × `height` (a vectorscope is square: the smaller side). */
export function videoScopeImage(kind: VideoScopeKind, pixels: VideoPixels, width = 256, height = 128, options: VideoScopeOptions = {}): VideoScopeImage {
	if (kind === 'histogram') return videoHistogramImage(videoHistogram(pixels, { ...options, bins: Math.min(256, width) }), width, height);
	if (kind === 'waveform') return videoWaveformImage(videoLumaWaveform(pixels, { ...options, columns: Math.min(pixels.width, width), levels: Math.min(256, height) }), width, height);
	const size = Math.min(width, height);
	return videoVectorscopeImage(videoVectorscope(pixels, { ...options, size }), size);
}

/** A frame the preview drew: when, whether every picture in it had loaded, and its pixels. */
export interface VideoPreviewSnapshot {
	time: number;
	/** False while a picture is still loading or seeking (the frame shows a placeholder or a stale picture). */
	complete: boolean;
	pixels: VideoPixels;
}

/**
 * Where a preview's pixels can be read, for scopes and agents: a `VideoPreviewEngine` attaches its
 * canvas and says each time it draws. `VideoEditorController.previewPixels` is one, so a preview,
 * a scopes panel and the agent tools of one editor find each other without wiring.
 */
export class VideoPreviewPixels {
	private reader: (() => VideoPreviewSnapshot | null) | null = null;
	private drawnAt: { time: number; complete: boolean } | null = null;
	private readonly listeners = new Set<() => void>();

	/** Gives the canvas to read (the latest preview wins). Returns a function that takes it away again. */
	attach(reader: () => VideoPreviewSnapshot | null): () => void {
		this.reader = reader;
		this.drawnAt = null;
		return () => {
			if (this.reader !== reader) return;
			this.reader = null;
			this.drawnAt = null;
			this.emit();
		};
	}

	/** Whether a preview is attached. */
	get attached(): boolean {
		return this.reader !== null;
	}

	/** The preview drew the frame at `time`; `complete` is false while a picture was missing or stale. */
	drawn(time: number, complete: boolean): void {
		this.drawnAt = { time, complete };
		this.emit();
	}

	/** The last frame drawn, with its pixels; `null` without a preview. Throws when the canvas cannot be read. */
	read(): VideoPreviewSnapshot | null {
		if (!this.reader) return null;
		try {
			return this.reader();
		} catch (e) {
			const reason = e instanceof Error ? e.message : String(e);
			throw new Error(`The preview's pixels cannot be read (${reason}). Media from another origin must be served with CORS headers (Access-Control-Allow-Origin) for its pixels to be measured.`);
		}
	}

	/** Called after each frame the preview draws. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * The frame at `time` once it is complete: now, if the last frame drawn was it, else the next
	 * complete drawing of it. Fails after `timeout` ms (default 5000).
	 */
	next(time: number, timeout = 5000): Promise<VideoPreviewSnapshot> {
		const matches = () => this.drawnAt && this.drawnAt.complete && Math.abs(this.drawnAt.time - time) < 0.5;
		return new Promise((resolve, reject) => {
			const done = (fn: () => void) => {
				clearTimeout(timer);
				off();
				fn();
			};
			const check = () => {
				if (!this.reader) return done(() => reject(new Error('The preview was closed before it drew the frame.')));
				if (!matches()) return;
				try {
					const snap = this.read();
					done(() => (snap ? resolve(snap) : reject(new Error('The preview has no pixels to read.'))));
				} catch (e) {
					done(() => reject(e));
				}
			};
			const off = this.subscribe(check);
			const timer = setTimeout(() => done(() => reject(new Error(`The preview did not finish drawing ${Math.round(time)} ms within ${timeout} ms; its media may still be loading or may have failed to load. Try again, or check the asset sources.`))), timeout);
			check();
		});
	}

	private emit() {
		for (const l of [...this.listeners]) l();
	}
}

/** What a scopes panel shows for the preview's latest frame (see `readVideoScopesPanel`). */
export type VideoScopesPanelReading =
	| { ok: true; time: number; complete: boolean; images: Partial<Record<VideoScopeKind, VideoScopeImage>>; stats: VideoExposureStats; notes: string[] }
	| { ok: false; message: string };

/**
 * The preview's latest frame as a scopes panel draws it: an image per scope `kinds`, each
 * `width` × `height` (vectorscopes square), and the exposure figures. Reads at most `maxPixels`
 * (default 65 536) so it keeps up with playback. Says why when there is nothing to show.
 */
export function readVideoScopesPanel(feed: VideoPreviewPixels, kinds: readonly VideoScopeKind[] = VIDEO_SCOPE_KINDS, options: { width?: number; height?: number; maxPixels?: number } = {}): VideoScopesPanelReading {
	let snap: VideoPreviewSnapshot | null;
	try {
		snap = feed.read();
	} catch (e) {
		return { ok: false, message: e instanceof Error ? e.message : String(e) };
	}
	if (!snap) return { ok: false, message: feed.attached ? 'The preview has not drawn a frame yet.' : 'Show the preview to see its scopes.' };
	const width = options.width ?? 256;
	const height = options.height ?? 128;
	const opts = { maxPixels: options.maxPixels ?? 65_536 };
	const images: Partial<Record<VideoScopeKind, VideoScopeImage>> = {};
	for (const kind of kinds) images[kind] = videoScopeImage(kind, snap.pixels, width, height, opts);
	const stats = videoExposureStats(snap.pixels, opts);
	return { ok: true, time: snap.time, complete: snap.complete, images, stats, notes: videoExposureNotes(stats) };
}
