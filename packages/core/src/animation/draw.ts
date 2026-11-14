/**
 * Drawing a line on in pieces (#812). One visual line is often several drawn paths: a thin
 * lead-in then a thick span, or a strand that passes behind and in front. They should draw on as
 * one continuous stroke, so each piece takes its place `{ from, to }` along a shared length and
 * shows the part the moving head has passed. Frame-pure: the picture at progress `p` depends on
 * `p` alone, and `p = 1` is exactly the line at rest (every piece whole). Ports to Swift line for
 * line (`PixerateCore/DrawPieces.swift`).
 */
import { evaluateEasing, type AnimationEasing } from './easing.js';

/** One drawn path's place along the shared line, as lengths from the line's start. */
export interface DrawPiece {
	from: number;
	to: number;
	/** The element's id, for `drawPiecesToFlair`. */
	id?: string;
}

export interface DrawPiecesOptions {
	/** The whole line's length (default: the furthest `to`). */
	total?: number;
	/** Where in the overall progress the line starts drawing, 0–1 (default 0). */
	at?: number;
	/** How much of the overall progress the drawing takes, 0–1 (default `1 - at`). */
	span?: number;
	/** How the head moves along the line (default `linear`): any animation easing, or a function of 0–1. */
	ease?: AnimationEasing | string | ((t: number) => number);
}

/** A piece at one progress: how much of it shows, from its start. */
export interface DrawnPiece {
	/** Length shown, from the piece's start: 0 to its length. */
	visible: number;
	/** The piece's length. */
	length: number;
	/** `visible / length` (1 for an empty piece once the head has reached it). */
	fraction: number;
	/** `stroke-dasharray` that shows it: `"<visible> <length>"`. */
	dasharray: string;
	/** Whether anything shows; hide the element otherwise, since round caps draw a dot for a zero dash. */
	shown: boolean;
}

export interface DrawPieces {
	/** The shared line's length. */
	total: number;
	/** The head's position along the line at progress `p` (0 before the line starts, `total` at rest). */
	headAt(p: number): number;
	/** Every piece at progress `p`, in the pieces' order. */
	drawAt(p: number): DrawnPiece[];
	/**
	 * Each piece's window in the overall progress: where the head reaches its start and its end.
	 * Exact for any easing that only rises; found by bisection.
	 */
	windows: { start: number; end: number }[];
}

function fmt(v: number): string {
	const rounded = Math.round(v * 1000) / 1000;
	return Object.is(rounded, -0) ? '0' : String(rounded);
}

/**
 * Plans the drawing of one line from its pieces. A piece may overlap another (a highlight over
 * part of a span) or leave a gap (the line passes behind something); each shows what the head
 * has passed of it.
 */
export function drawPieces(pieces: readonly DrawPiece[], options: DrawPiecesOptions = {}): DrawPieces {
	for (const [i, piece] of pieces.entries()) {
		if (!Number.isFinite(piece.from) || !Number.isFinite(piece.to) || piece.to < piece.from) {
			throw new Error(`pieces[${i}] must have finite from ≤ to (got from ${piece.from}, to ${piece.to}).`);
		}
	}
	let furthest = 0;
	for (const piece of pieces) furthest = Math.max(furthest, piece.to);
	const total = options.total ?? furthest;
	if (!(total >= 0)) throw new Error(`total must be a length of 0 or more (got ${total}).`);
	const at = Math.min(1, Math.max(0, options.at ?? 0));
	const span = Math.min(1 - at, Math.max(0, options.span ?? 1 - at));
	const ease = options.ease;
	const curve = (t: number) => (typeof ease === 'function' ? ease(t) : evaluateEasing(ease ?? 'linear', t));
	const local = (p: number) => (p >= at + span ? 1 : p <= at ? 0 : Math.min(1, (p - at) / span));
	const headAt = (p: number): number => {
		if (!(p < 1)) return total;
		const u = local(p);
		if (u <= 0) return 0;
		if (u >= 1) return total;
		return Math.min(total, Math.max(0, total * curve(u)));
	};
	const drawAt = (p: number): DrawnPiece[] => {
		const head = headAt(p);
		return pieces.map((piece) => {
			const length = piece.to - piece.from;
			const visible = Math.min(length, Math.max(0, head - piece.from));
			const reached = head >= piece.from && head > 0;
			const fraction = length > 0 ? visible / length : reached ? 1 : 0;
			return { visible, length, fraction, dasharray: `${fmt(visible)} ${fmt(length)}`, shown: visible > 0 };
		});
	};
	/** The first overall progress at which the head reaches `s`, by bisection on `headAt`. */
	const progressAt = (s: number): number => {
		if (s <= 0) return at;
		let lo = at, hi = at + span;
		for (let i = 0; i < 60; i++) {
			const mid = (lo + hi) / 2;
			if (headAt(mid) >= s) hi = mid;
			else lo = mid;
		}
		return hi;
	};
	const windows = pieces.map((piece) => ({ start: progressAt(piece.from), end: progressAt(piece.to) }));
	return { total, headAt, drawAt, windows };
}

/** One draw-on of an SVG element, in the shape of Flair's `SvgAnimation` (`draw: true`). */
export interface DrawPieceAnimation {
	id: string;
	/** Ms from the start of the motion. */
	delay: number;
	/** Ms the draw takes. */
	ms: number;
	draw: true;
	ease: 'linear';
}

/**
 * The plan as Flair draw-ons over a motion `durationMs` long: each piece with an `id` draws from
 * its window's start to its end, linearly. Exact for a linear line; for an eased line each piece
 * follows the curve only at its ends.
 */
export function drawPiecesToFlair(plan: DrawPieces, pieces: readonly DrawPiece[], durationMs: number): DrawPieceAnimation[] {
	const out: DrawPieceAnimation[] = [];
	pieces.forEach((piece, i) => {
		if (!piece.id) return;
		const w = plan.windows[i];
		out.push({ id: piece.id, delay: Math.round(w.start * durationMs), ms: Math.max(1, Math.round((w.end - w.start) * durationMs)), draw: true, ease: 'linear' });
	});
	return out;
}
