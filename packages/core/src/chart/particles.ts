/**
 * Particles for data (#806): counts drawn as grains that settle into layers, so a quantity reads
 * as a pile, a band or a sediment that can be counted. Pure geometry with no renderer:
 * `settleParticles` packs particles into a container and says where each one rests and how thick
 * each layer is; `settleFrame` gives every position at a progress (frame-pure, `p = 1` exactly at
 * rest); `layoutChartParticles` turns a one-series chart into layers of grains, one per `unit`.
 * `@pixerate/editor/three` draws them as one instanced mesh.
 *
 * World units: x across the container, y up from its floor, z back into the picture, with the
 * container's corner at the origin (as in `layoutChart3d`).
 */
import type { ChartSpec } from './types.js';
import { chartSliceColor } from './spec.js';
import { formatChartNumber } from './scale.js';

/** A repeatable random source (mulberry32), so a seed always settles the same way. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The box particles settle in. */
export interface ParticleContainer {
	width: number;
	depth: number;
	/** Particles past this height don't fit and are counted in `overflow` (default unlimited). */
	height?: number;
}

/** One layer: consecutive particles that settle on top of the layer before. */
export interface ParticleLayerInput {
	count: number;
	label?: string;
	color?: string;
}

export interface SettleParticlesOptions {
	container: ParticleContainer;
	layers: readonly ParticleLayerInput[];
	/** A particle's diameter (world units). */
	size: number;
	/** Room between particles as a fraction of their size (default 0.15). */
	gap?: number;
	/** How far particles wander within their own cell, 0 (a neat grid) … 1 (to its edges; default 0.6). */
	jitter?: number;
	/** Seed for the order cells fill and the wander (default 1). */
	seed?: number;
}

/** A layer as it settled. */
export interface SettledLayer {
	label?: string;
	color?: string;
	/** Index of its first particle. */
	start: number;
	/** Particles placed (fewer than asked when the container is full). */
	count: number;
	/** Its extent in y: from the lowest particle's bottom to the highest's top. */
	bottom: number;
	top: number;
	thickness: number;
	/** How full its top level is, 0–1 (1: it ends on a whole level). */
	fill: number;
}

export interface SettledParticles {
	/** Particles placed. */
	count: number;
	size: number;
	/** Cell edge: size plus the gap. */
	cell: number;
	/** Rest centres, x y z for each particle in order. */
	positions: Float64Array;
	/** Layer index of each particle. */
	layerOf: Uint32Array;
	layers: SettledLayer[];
	/** Particles per level and the number of levels used. */
	perLevel: number;
	levels: number;
	/** Particles that did not fit under `container.height`. */
	overflow: number;
	container: ParticleContainer;
}

/**
 * Packs the layers' particles into the container, level by level from the floor: each level is a
 * grid of cells filled in a seeded random order, and each particle wanders within its own cell, so
 * no two overlap and every one stays inside. Layers follow on from each other, so a layer that ends
 * part-way through a level leaves a ragged top for the next to fill, as sediment does. The same
 * input and seed always settle the same way.
 */
export function settleParticles(options: SettleParticlesOptions): SettledParticles {
	const { container, layers, size } = options;
	if (!(size > 0)) throw new Error(`size must be a positive length (got ${size}).`);
	const gap = Math.max(0, options.gap ?? 0.15);
	const jitter = Math.min(1, Math.max(0, options.jitter ?? 0.6));
	const cell = size * (1 + gap);
	const cols = Math.floor(container.width / cell);
	const rows = Math.floor(container.depth / cell);
	if (cols < 1 || rows < 1) throw new Error(`The container (${container.width} × ${container.depth}) is too small for particles of size ${size}; make it at least ${Math.ceil(cell * 100) / 100} wide and deep, or the particles smaller.`);
	const perLevel = cols * rows;
	const maxLevels = container.height !== undefined ? Math.max(0, Math.floor(container.height / cell)) : Infinity;
	const capacity = maxLevels === Infinity ? Infinity : maxLevels * perLevel;
	const asked = layers.reduce((n, l) => n + Math.max(0, Math.floor(l.count)), 0);
	const count = Math.min(asked, capacity);
	const random = mulberry32(options.seed ?? 1);
	const x0 = (container.width - cols * cell) / 2;
	const z0 = (container.depth - rows * cell) / 2;
	const wander = ((cell - size) / 2) * jitter;
	const positions = new Float64Array(count * 3);
	const layerOf = new Uint32Array(count);
	let order: number[] = [];
	const settledLayers: SettledLayer[] = [];
	let i = 0;
	for (let li = 0; li < layers.length; li++) {
		const layer = layers[li]!;
		const start = i;
		const want = Math.max(0, Math.floor(layer.count));
		let bottom = Infinity;
		let top = -Infinity;
		let topLevel = -1;
		let inTop = 0;
		for (let k = 0; k < want && i < count; k++, i++) {
			const level = Math.floor(i / perLevel);
			if (level > topLevel) {
				topLevel = level;
				inTop = 0;
			}
			inTop++;
			const slot = i % perLevel;
			if (slot === 0) {
				// A new level: its cells in a fresh seeded order (Fisher–Yates).
				order = Array.from({ length: perLevel }, (_, c) => c);
				for (let c = perLevel - 1; c > 0; c--) {
					const j = Math.floor(random() * (c + 1));
					[order[c], order[j]] = [order[j]!, order[c]!];
				}
			}
			const c = order[slot]!;
			const x = x0 + ((c % cols) + 0.5) * cell + (random() * 2 - 1) * wander;
			const z = z0 + (Math.floor(c / cols) + 0.5) * cell + (random() * 2 - 1) * wander;
			const y = (level + 0.5) * cell + (random() * 2 - 1) * wander;
			positions[i * 3] = x;
			positions[i * 3 + 1] = y;
			positions[i * 3 + 2] = z;
			layerOf[i] = li;
			bottom = Math.min(bottom, y - size / 2);
			top = Math.max(top, y + size / 2);
		}
		const placed = i - start;
		settledLayers.push({
			...(layer.label !== undefined ? { label: layer.label } : {}),
			...(layer.color !== undefined ? { color: layer.color } : {}),
			start,
			count: placed,
			bottom: placed ? bottom : 0,
			top: placed ? top : 0,
			thickness: placed ? top - bottom : 0,
			fill: placed ? inTop / perLevel : 0
		});
	}
	return { count, size, cell, positions, layerOf, layers: settledLayers, perLevel, levels: count ? Math.floor((count - 1) / perLevel) + 1 : 0, overflow: asked - count, container };
}

export interface SettleFrameOptions {
	/** How far above its rest each particle starts falling (default the pile's height plus two cells). */
	drop?: number;
	/** Each particle's share of the overall progress for its fall, 0.05–1 (default 0.3); the last still falls this long. */
	fall?: number;
	/** Write into this array (length 3 × count) instead of a new one. */
	out?: Float32Array;
}

/**
 * Every particle's centre at progress `p` (0–1): particles drop in order (layer by layer, then
 * level by level), each falling for `fall` of the progress and speeding up as it falls. Frame-pure,
 * and `p = 1` is exactly the rest positions. A particle that has not started yet comes back with
 * `visible[i] = 0`, so a renderer can hide it.
 */
export function settleFrame(settled: SettledParticles, p: number, options: SettleFrameOptions = {}): { positions: Float32Array; visible: Uint8Array } {
	const n = settled.count;
	const out = options.out ?? new Float32Array(n * 3);
	const visible = new Uint8Array(n);
	const fall = Math.min(1, Math.max(0.05, options.fall ?? 0.3));
	const drop = options.drop ?? settled.levels * settled.cell + settled.cell * 2;
	const progress = Math.min(1, Math.max(0, Number.isFinite(p) ? p : 1));
	for (let i = 0; i < n; i++) {
		const x = settled.positions[i * 3]!;
		const y = settled.positions[i * 3 + 1]!;
		const z = settled.positions[i * 3 + 2]!;
		const start = n > 1 ? (i / (n - 1)) * (1 - fall) : 0;
		const t = progress >= 1 ? 1 : Math.min(1, Math.max(0, (progress - start) / fall));
		out[i * 3] = x;
		out[i * 3 + 1] = t >= 1 ? y : y + drop * (1 - t * t);
		out[i * 3 + 2] = z;
		visible[i] = progress >= 1 || progress > start ? 1 : 0;
	}
	return { positions: out, visible };
}

/** How a chart's categories become layers of particles. */
export interface ChartParticlesOptions {
	/** How much one particle stands for (default: a round number giving at most about 600 particles). */
	unit?: number;
	/** Layer order from the floor up: the categories' order (default), largest first, or smallest first. */
	order?: 'categories' | 'largest-first' | 'smallest-first';
	/** Container footprint in world units (default 3 × 2). */
	width?: number;
	depth?: number;
	/** Particle size (default fitted so the pile stands about as tall as it is wide). */
	size?: number;
	seed?: number;
}

/** A one-series chart as layers of particles: which category each layer is, and the settled pile. */
export interface ChartParticlesLayout {
	seriesId: string;
	unit: number;
	/** Category index of each layer, from the floor up. */
	categories: number[];
	settled: SettledParticles;
	/** Each layer's label for the overlay: the category, its value and its particle count. */
	labels: string[];
	/** What the reader needs to know, in sentences (the unit, rounding). */
	notes: string[];
}

const niceUnit = (total: number, most: number) => {
	if (!(total > 0)) return 1;
	const raw = total / most;
	const power = 10 ** Math.floor(Math.log10(raw));
	for (const step of [1, 2, 5, 10]) if (step * power >= raw) return step * power;
	return 10 * power;
};

/**
 * The first visible series of `spec` as a pile: each category is a layer of particles, one per
 * `unit` (values round to whole particles, negative values to none), in `order` from the floor up.
 * The notes say what one particle stands for, so a caption can.
 */
export function layoutChartParticles(spec: ChartSpec, options: ChartParticlesOptions = {}): ChartParticlesLayout {
	const si = spec.series.findIndex((s) => !s.hidden);
	const series = spec.series[si];
	if (!series) throw new Error('The chart has no visible series to draw as particles.');
	const values = spec.categories.map((_, i) => {
		const v = series.values[i];
		return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0;
	});
	const total = values.reduce((a, b) => a + b, 0);
	const unit = options.unit ?? niceUnit(total, 600);
	if (!(unit > 0)) throw new Error(`unit must be a positive number (got ${options.unit}).`);
	const indices = values.map((_, i) => i);
	if (options.order === 'largest-first') indices.sort((a, b) => values[b]! - values[a]! || a - b);
	else if (options.order === 'smallest-first') indices.sort((a, b) => values[a]! - values[b]! || a - b);
	const counts = indices.map((i) => Math.round(values[i]! / unit));
	const width = options.width ?? 3;
	const depth = options.depth ?? 2;
	const particles = counts.reduce((a, b) => a + b, 0);
	// Fit the size so the pile stands about as tall as it is wide.
	const size = options.size ?? Math.max(0.02, Math.cbrt((width * depth * width) / Math.max(1, particles)) / 1.15);
	const settled = settleParticles({
		container: { width, depth },
		layers: indices.map((i, k) => ({ count: counts[k]!, label: spec.categories[i], color: chartSliceColor(spec, i) })),
		size,
		seed: options.seed ?? 1
	});
	const format = series.format ?? spec.yAxis.format ?? {};
	const labels = indices.map((i, k) => `${spec.categories[i]} · ${formatChartNumber(values[i]!, format)} (${counts[k]} ${counts[k] === 1 ? 'grain' : 'grains'})`);
	const notes = [`One grain is ${formatChartNumber(unit, format)} ${series.name ? `of ${series.name}` : ''}`.trim() + '; values are rounded to whole grains.'];
	if (spec.series.filter((s) => !s.hidden).length > 1) notes.push(`Only "${series.name}" is drawn as particles; the other series are left out.`);
	return { seriesId: series.id, unit, categories: indices, settled, labels, notes };
}
