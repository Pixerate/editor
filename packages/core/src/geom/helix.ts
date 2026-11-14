/**
 * Helices for data visuals (#811): a strand wound around an axis, seen side on, with its depth,
 * so a picture can draw over/under (a braid, a rope, DNA). `splitByDepth` cuts a strand into
 * front and back runs exactly where it crosses the axis plane. Pure geometry; ports to Swift line
 * for line (`PixerateGeometry/Helix.swift`).
 */
import type { Vec2 } from './types';

/** How the winding's width changes along the axis. A function takes t in [0, 1]. */
export type HelixEnvelope = 'none' | 'pinch' | 'start' | 'end' | ((t: number) => number);

export interface HelixOptions {
	/** Half the winding's width in px (default 12). */
	amplitude?: number;
	/** Whole turns along the axis (default 2). */
	turns?: number;
	/** Starting angle in radians (default 0). Strands of a braid of n differ by 2π/n. */
	phase?: number;
	/**
	 * `none` (default) keeps the width; `pinch` closes it at both ends; `start` opens it from
	 * nothing at the start; `end` closes it at the end.
	 */
	envelope?: HelixEnvelope;
	/** Straight pieces in the polyline (default 48 per turn, at least 8). */
	samples?: number;
}

export interface Helix {
	/** The strand as a polyline, from the axis's start to its end. */
	points: Vec2[];
	/** Depth at each point, from -1 (behind) to 1 (in front of the axis plane). */
	depth: number[];
	/** Path data (`M` and `L`, 3 decimals). */
	d: string;
	/** The polyline's length. */
	length: number;
}

export interface HelixRun {
	/** In front of the axis plane (depth ≥ 0). */
	front: boolean;
	points: Vec2[];
	d: string;
	/** Where the run starts and ends, as lengths along the whole strand. */
	from: number;
	to: number;
	length: number;
}

function fmt(v: number): string {
	const rounded = Math.round(v * 1000) / 1000;
	return Object.is(rounded, -0) ? '0' : String(rounded);
}

function polylineD(points: readonly Vec2[]): string {
	let d = '';
	for (let i = 0; i < points.length; i++) d += `${i === 0 ? 'M' : 'L'}${fmt(points[i].x)} ${fmt(points[i].y)}`;
	return d;
}

function envelopeAt(envelope: HelixEnvelope, t: number): number {
	if (typeof envelope === 'function') return envelope(t);
	if (envelope === 'pinch') return Math.sin(Math.PI * t);
	if (envelope === 'start') return Math.sin((Math.PI * t) / 2);
	if (envelope === 'end') return Math.cos((Math.PI * t) / 2);
	return 1;
}

/** A strand wound around the axis from `axis[0]` to `axis[1]`, offset to the axis's left at phase π/2. */
export function helix(axis: readonly [Vec2, Vec2], options: HelixOptions = {}): Helix {
	const [a, b] = axis;
	const amplitude = options.amplitude ?? 12;
	const turns = options.turns ?? 2;
	const phase = options.phase ?? 0;
	const envelope = options.envelope ?? 'none';
	const samples = Math.max(1, Math.round(options.samples ?? Math.max(8, Math.ceil(Math.abs(turns) * 48))));
	const len = Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
	const ux = len === 0 ? 1 : (b.x - a.x) / len;
	const uy = len === 0 ? 0 : (b.y - a.y) / len;
	// The normal: the axis turned a quarter anticlockwise on screen.
	const nx = uy, ny = -ux;
	const points: Vec2[] = [];
	const depth: number[] = [];
	let length = 0;
	for (let i = 0; i <= samples; i++) {
		const t = i / samples;
		const angle = 2 * Math.PI * turns * t + phase;
		const off = amplitude * envelopeAt(envelope, t) * Math.sin(angle);
		const p = { x: a.x + (b.x - a.x) * t + nx * off, y: a.y + (b.y - a.y) * t + ny * off };
		if (i > 0) {
			const q = points[i - 1];
			length += Math.sqrt((p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y));
		}
		points.push(p);
		depth.push(Math.cos(angle));
	}
	return { points, depth, d: polylineD(points), length };
}

/**
 * Cuts a polyline into runs in front of (depth ≥ 0) and behind (depth < 0) the axis plane. Each
 * cut sits exactly where the depth, taken as linear between points, is zero; a point with zero
 * depth belongs to the side before it.
 */
export function splitByDepth(points: readonly Vec2[], depth: readonly number[]): HelixRun[] {
	const n = Math.min(points.length, depth.length);
	if (n === 0) return [];
	const side: boolean[] = new Array(n);
	let first = true;
	for (let i = 0; i < n; i++) if (depth[i] !== 0) { first = depth[i] > 0; break; }
	for (let i = 0; i < n; i++) side[i] = depth[i] > 0 ? true : depth[i] < 0 ? false : i === 0 ? first : side[i - 1];
	const runs: HelixRun[] = [];
	let run: Vec2[] = [{ x: points[0].x, y: points[0].y }];
	let runFrom = 0;
	let at = 0;
	const close = (front: boolean, to: number) => {
		runs.push({ front, points: run, d: polylineD(run), from: runFrom, to, length: to - runFrom });
	};
	for (let i = 1; i < n; i++) {
		const p = points[i - 1], q = points[i];
		const seg = Math.sqrt((q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y));
		if (side[i] !== side[i - 1]) {
			const f = depth[i - 1] === depth[i] ? 0 : depth[i - 1] / (depth[i - 1] - depth[i]);
			const cut = { x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f };
			const cutAt = at + seg * f;
			if (f > 0) run.push(cut);
			close(side[i - 1], cutAt);
			run = [cut];
			runFrom = cutAt;
		}
		at += seg;
		run.push({ x: q.x, y: q.y });
	}
	close(side[n - 1], at);
	return runs;
}
