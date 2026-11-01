/**
 * Hand-drawn annotation gestures (`canvas.circle`, `canvas.underline`, `canvas.arrow`,
 * `canvas.bracket`, `canvas.strike`, `canvas.cross`, `canvas.check`): stroke points in canvas
 * coordinates, generated with a seeded human wobble (overshoot, slightly open loops, uneven
 * pressure). Pure geometry with no imports, so the command layer can use it.
 */

export type GesturePoint = [number, number];

export interface GestureRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A generated gesture: one stroke, as `drawStroke` takes it. */
export interface GestureStroke {
	points: GesturePoint[];
	/** Uneven pen pressure along the stroke (only applied to brushed strokes). */
	pressure: number[];
}

/** Seeded random numbers in [0, 1) (mulberry32). */
export function gestureRandom(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A stable 32-bit seed for any JSON value (FNV-1a over its JSON), so equal requests draw equal marks. */
export function gestureSeed(value: unknown): number {
	const text = JSON.stringify(value) ?? '';
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** The box around several rects. */
export function gestureUnion(rects: readonly GestureRect[]): GestureRect {
	if (!rects.length) throw new Error('Pass at least one rect.');
	const x = Math.min(...rects.map((r) => r.x));
	const y = Math.min(...rects.map((r) => r.y));
	const right = Math.max(...rects.map((r) => r.x + r.width));
	const bottom = Math.max(...rects.map((r) => r.y + r.height));
	return { x, y, width: right - x, height: bottom - y };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const centre = (r: GestureRect): GesturePoint => [r.x + r.width / 2, r.y + r.height / 2];

/** Smooth noise over t in [0, 1], in [-1, 1]: a few low-frequency sines with seeded phases. */
function smoothNoise(rand: () => number, octaves = 3): (t: number) => number {
	const waves = Array.from({ length: octaves }, (_, i) => ({ f: (i + 1) * (0.6 + rand() * 0.8), phase: rand() * Math.PI * 2, amp: 1 / (i + 1) }));
	const total = waves.reduce((sum, w) => sum + w.amp, 0);
	return (t) => waves.reduce((sum, w) => sum + w.amp * Math.sin(2 * Math.PI * w.f * t + w.phase), 0) / total;
}

/** Pen pressure that starts light, presses in the middle and lifts unevenly. */
function handPressure(rand: () => number): number[] {
	const r = (lo: number, hi: number) => Math.round((lo + rand() * (hi - lo)) * 100) / 100;
	return [r(0.35, 0.55), r(0.8, 0.95), r(0.9, 1), r(0.75, 0.95), r(0.4, 0.65)];
}

const round = (p: GesturePoint): GesturePoint => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];

/**
 * A wobbly line from `a` to `b`: bowed by `bow` (canvas units, + to the left of travel) and
 * shaken by up to `amp` units, tapered so both ends land exactly.
 */
function wobblyLine(a: GesturePoint, b: GesturePoint, rand: () => number, amp: number, bow = 0): GesturePoint[] {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const len = Math.hypot(dx, dy);
	if (len === 0) return [a];
	const nx = -dy / len;
	const ny = dx / len;
	const noise = smoothNoise(rand);
	const n = clamp(Math.ceil(len / 4), 8, 200);
	return Array.from({ length: n + 1 }, (_, i) => {
		const t = i / n;
		const off = bow * 4 * t * (1 - t) + amp * noise(t) * Math.sqrt(Math.sin(Math.PI * t));
		return [a[0] + dx * t + nx * off, a[1] + dy * t + ny * off] as GesturePoint;
	});
}

export interface CircleGestureOptions {
	/** Space between the rect and the loop, about this many canvas units at the ends of its axes (default 8). */
	padding?: number;
}

/**
 * A loose, slightly open ellipse around `rect`: it starts near the top left, goes round once
 * and overshoots past its start on a slightly wider path, so the ends never quite meet. It
 * never cuts into the rect.
 */
export function circleGesture(rect: GestureRect, seed: number, options: CircleGestureOptions = {}): GestureStroke {
	const rand = gestureRandom(seed);
	const pad = Math.max(0, options.padding ?? 8);
	const [cx, cy] = centre(rect);
	const tilt = (rand() - 0.5) * 0.08;
	// The rect's half-sizes in the loop's slightly tilted frame; an ellipse through the corners
	// of that box has semi-axes √2 times them.
	const c = Math.abs(Math.cos(tilt));
	const s = Math.abs(Math.sin(tilt));
	const a = ((rect.width / 2) * c + (rect.height / 2) * s) * Math.SQRT2 + pad;
	const b = ((rect.width / 2) * s + (rect.height / 2) * c) * Math.SQRT2 + pad;
	const dir = rand() < 0.7 ? -1 : 1; // mostly anticlockwise on screen, like most hands
	const start = -Math.PI * 0.75 + (rand() - 0.5) * 0.6;
	const sweep = Math.PI * 2 + Math.PI * (0.1 + rand() * 0.12);
	const jitter = 0.03 + rand() * 0.03;
	const drift = 0.04 + rand() * 0.05;
	const noise = smoothNoise(rand, 4);
	const perimeter = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
	const n = clamp(Math.ceil((perimeter * (sweep / (Math.PI * 2))) / 5), 48, 360);
	const points = Array.from({ length: n + 1 }, (_, i) => {
		const t = i / n;
		const angle = start + dir * sweep * t;
		// Only ever outward, so the loop never cuts into what it circles.
		const grow = 1 + jitter * (0.5 + 0.5 * noise(t)) + drift * t * t;
		const ex = a * grow * Math.cos(angle);
		const ey = b * grow * Math.sin(angle);
		return round([cx + ex * Math.cos(tilt) - ey * Math.sin(tilt), cy + ex * Math.sin(tilt) + ey * Math.cos(tilt)]);
	});
	return { points, pressure: handPressure(rand) };
}

export interface UnderlineGestureOptions {
	/** Gap below the rect's bottom edge, canvas units (default 4). */
	offset?: number;
	/** A wavy underline instead of a straight one (default false). */
	wave?: boolean;
}

/** A stroke under the rect's bottom edge, a little longer or shorter than it, never touching it. */
export function underlineGesture(rect: GestureRect, seed: number, options: UnderlineGestureOptions = {}): GestureStroke {
	const rand = gestureRandom(seed);
	const offset = Math.max(0, options.offset ?? 4);
	const amp = options.wave ? clamp(rect.width * 0.02, 2, 4) : 0;
	const shake = Math.min(1.5, offset * 0.4);
	const base = rect.y + rect.height + offset + amp + shake;
	const slope = Math.min(6, rect.width * 0.03);
	const x0 = rect.x - rect.width * (0.01 + rand() * 0.04);
	const x1 = rect.x + rect.width * (0.96 + rand() * 0.08);
	const line = wobblyLine([x0, base + rand() * slope], [x1, base + rand() * slope], rand, shake, (rand() - 0.5) * 2 * shake);
	const wavelength = clamp(rect.width / 8, 12, 28);
	const phase = rand() * Math.PI * 2;
	const points = amp ? line.map(([x, y]) => [x, y + amp * Math.sin((2 * Math.PI * (x - x0)) / wavelength + phase)] as GesturePoint) : line;
	return { points: points.map(round), pressure: handPressure(rand) };
}

/** Where the line from the rect's centre towards `toward` leaves the rect, pushed out by `gap`. */
export function gestureEdgePoint(rect: GestureRect, toward: GesturePoint, gap = 0): GesturePoint {
	const [cx, cy] = centre(rect);
	const dx = toward[0] - cx;
	const dy = toward[1] - cy;
	const len = Math.hypot(dx, dy);
	if (len === 0) return [cx, cy];
	const t = Math.min(dx ? rect.width / 2 / Math.abs(dx) : Infinity, dy ? rect.height / 2 / Math.abs(dy) : Infinity);
	return [cx + dx * t + (dx / len) * gap, cy + dy * t + (dy / len) * gap];
}

export type GestureEnd = GesturePoint | GestureRect;

const isRect = (end: GestureEnd): end is GestureRect => !Array.isArray(end);

export interface ArrowGestureOptions {
	/** Bend of the shaft, −1..1: how far its middle bulges, as a fraction of half its length (+ bends left of travel). Default: a gentle seeded bend. */
	curve?: number;
	/** Space left between a rect end and the arrow, canvas units (default 6). */
	gap?: number;
}

/**
 * A curved arrow from `from` to `to` with a hand-drawn head. A rect end is reached at its
 * nearest edge (on the line between the two ends' centres), `gap` units clear of it; a point
 * end is used as it is. The head is drawn in the same stroke: tip, one barb, back to the tip,
 * the other barb.
 */
export function arrowGesture(from: GestureEnd, to: GestureEnd, seed: number, options: ArrowGestureOptions = {}): GestureStroke {
	const rand = gestureRandom(seed);
	const gap = Math.max(0, options.gap ?? 6);
	const fromCentre = isRect(from) ? centre(from) : from;
	const toCentre = isRect(to) ? centre(to) : to;
	const start = isRect(from) ? gestureEdgePoint(from, toCentre, gap) : from;
	const tip = isRect(to) ? gestureEdgePoint(to, fromCentre, gap) : to;
	const dx = tip[0] - start[0];
	const dy = tip[1] - start[1];
	const len = Math.hypot(dx, dy);
	if (len < 4) throw new Error('The arrow\'s ends are too close together (or overlap): pass ends at least a few canvas units apart.');
	const curve = clamp(options.curve ?? (0.08 + rand() * 0.08) * (rand() < 0.5 ? -1 : 1), -1, 1);
	const nx = -dy / len;
	const ny = dx / len;
	// A quadratic's middle sits halfway to its control point, so the bulge is curve × half the length.
	const control: GesturePoint = [(start[0] + tip[0]) / 2 + nx * curve * len, (start[1] + tip[1]) / 2 + ny * curve * len];
	const noise = smoothNoise(rand);
	const amp = Math.min(2, len * 0.01);
	const n = clamp(Math.ceil(len / 4), 12, 200);
	const shaft = Array.from({ length: n + 1 }, (_, i): GesturePoint => {
		const t = i / n;
		const u = 1 - t;
		const x = u * u * start[0] + 2 * u * t * control[0] + t * t * tip[0];
		const y = u * u * start[1] + 2 * u * t * control[1] + t * t * tip[1];
		const off = amp * noise(t) * Math.sqrt(Math.sin(Math.PI * t));
		return [x + nx * off, y + ny * off];
	});
	// The head follows the shaft's direction where it arrives.
	const tx = tip[0] - control[0];
	const ty = tip[1] - control[1];
	const tl = Math.hypot(tx, ty) || 1;
	const head = clamp(len * 0.15, 8, 22);
	const barb = (angle: number, length: number): GesturePoint[] => {
		const c = Math.cos(angle);
		const s = Math.sin(angle);
		const bx = -(tx / tl) * c + (ty / tl) * s;
		const by = -(ty / tl) * c - (tx / tl) * s;
		return [1 / 3, 2 / 3, 1].map((f) => [tip[0] + bx * length * f, tip[1] + by * length * f] as GesturePoint);
	};
	// A barb that would reach into the target box (an arrow arriving at a shallow angle) is
	// narrowed until it clears it.
	const clear = (pts: GesturePoint[]) =>
		!isRect(to) || pts.every(([x, y]) => x <= to.x || x >= to.x + to.width || y <= to.y || y >= to.y + to.height);
	const fit = (angle: number) => {
		const length = head * (0.85 + rand() * 0.3);
		for (let k = 1; k > 0.05; k -= 0.15) {
			const pts = barb(angle * k, length);
			if (clear(pts)) return pts;
		}
		return barb(0, length);
	};
	const angle = () => ((25 + rand() * 8) * Math.PI) / 180;
	const first = fit(angle());
	const second = fit(-angle());
	const points = [...shaft, ...first, ...first.slice(0, -1).reverse(), tip, ...second];
	return { points: points.map(round), pressure: handPressure(rand) };
}

export type GestureSide = 'left' | 'right' | 'top' | 'bottom';

export interface BracketGestureOptions {
	/** `curly` (default) or `square`. */
	shape?: 'curly' | 'square';
	/** Gap between the rect and the bracket, canvas units (default 8). */
	padding?: number;
	/** How far the bracket reaches out from its ends, canvas units (default: from its span, 6..20). */
	depth?: number;
}

/**
 * A curly or square bracket on one `side` of `rect`, spanning it end to end. Its ends point at
 * the rect; a curly bracket's middle point faces away from it. It never enters the rect.
 */
export function bracketGesture(rect: GestureRect, side: GestureSide, seed: number, options: BracketGestureOptions = {}): GestureStroke {
	const rand = gestureRandom(seed);
	const pad = Math.max(0, options.padding ?? 8);
	const vertical = side === 'left' || side === 'right';
	const span = vertical ? rect.height : rect.width;
	const depth = Math.max(1, options.depth ?? clamp(span * 0.08, 6, 20));
	const from = vertical ? rect.y : rect.x;
	// The bracket's ends sit `pad` from the rect; `out` is the direction away from it.
	const edge = side === 'left' ? rect.x - pad : side === 'right' ? rect.x + rect.width + pad : side === 'top' ? rect.y - pad : rect.y + rect.height + pad;
	const out = side === 'left' || side === 'top' ? -1 : 1;
	const at = (s: number, d: number): GesturePoint => (vertical ? [edge + out * d, from + s * span] : [from + s * span, edge + out * d]);
	const noise = smoothNoise(rand);
	const shake = Math.min(1, depth * 0.06);
	const n = clamp(Math.ceil(span / 4), 24, 240);
	let points: GesturePoint[];
	if (options.shape === 'square') {
		const arm = depth * (0.8 + rand() * 0.2);
		const spine = Array.from({ length: n + 1 }, (_, i) => at(i / n, depth + shake * (1 + noise(i / n))));
		points = [at(0, depth - arm), at(0, depth * 0.5), ...spine, at(1, depth * 0.5), at(1, depth - arm * (0.85 + rand() * 0.15))];
	} else {
		// A brace: each end curls out to half depth, runs along, then points out to full depth in the middle.
		const e = clamp(depth / Math.max(span, 1), 0.04, 0.2);
		const brace = (s: number) => {
			const u = s <= 0.5 ? s : 1 - s;
			if (u < e) return (depth / 2) * Math.sin(((Math.PI / 2) * u) / e);
			if (u < 0.5 - e) return depth / 2;
			return depth / 2 + (depth / 2) * (1 - Math.cos(((Math.PI / 2) * (u - (0.5 - e))) / e));
		};
		points = Array.from({ length: n + 1 }, (_, i) => {
			const s = i / n;
			return at(s, brace(s) + shake * (1 + noise(s)) * Math.sin(Math.PI * s));
		});
	}
	return { points: points.map(round), pressure: handPressure(rand) };
}

/** A line struck through the middle of `rect`, slightly past both ends. */
export function strikeGesture(rect: GestureRect, seed: number): GestureStroke {
	const rand = gestureRandom(seed);
	const [, cy] = centre(rect);
	const slope = rect.height * 0.08;
	const x0 = rect.x - rect.width * (0.01 + rand() * 0.03);
	const x1 = rect.x + rect.width * (1.01 + rand() * 0.03);
	const y0 = cy + (rand() - 0.5) * rect.height * 0.1 + slope * (rand() - 0.5);
	const y1 = cy + (rand() - 0.5) * rect.height * 0.1 + slope * (rand() - 0.5);
	const points = wobblyLine([x0, y0], [x1, y1], rand, Math.min(1.5, rect.height * 0.05));
	return { points: points.map(round), pressure: handPressure(rand) };
}

/**
 * A cross over `rect`, corner to corner and a little past. It is one stroke, so after the first
 * diagonal the pen runs back along it to the middle and up the second one before drawing it
 * (the retraced part overlaps itself).
 */
export function crossGesture(rect: GestureRect, seed: number): GestureStroke {
	const rand = gestureRandom(seed);
	const over = () => 0.02 + rand() * 0.04;
	const left = () => rect.x - rect.width * over();
	const right = () => rect.x + rect.width * (1 + over());
	const top = () => rect.y - rect.height * over();
	const bottom = () => rect.y + rect.height * (1 + over());
	const amp = Math.min(1.5, Math.min(rect.width, rect.height) * 0.03);
	const first = wobblyLine([left(), top()], [right(), bottom()], rand, amp);
	const second = wobblyLine([right(), top()], [left(), bottom()], rand, amp);
	const mid1 = Math.floor(first.length / 2);
	const mid2 = Math.floor(second.length / 2);
	const points = [...first, ...first.slice(mid1, -1).reverse(), ...second.slice(1, mid2 + 1).reverse(), ...second];
	return { points: points.map(round), pressure: handPressure(rand) };
}

export interface CheckGestureOptions {
	/** Height of the tick, canvas units (default: 60% of the rect's smaller side, 12..48; 20 at a point). */
	size?: number;
}

/** A tick mark centred on a point, or in the middle of a rect. */
export function checkGesture(at: GestureEnd, seed: number, options: CheckGestureOptions = {}): GestureStroke {
	const rand = gestureRandom(seed);
	const [cx, cy] = isRect(at) ? centre(at) : at;
	const s = Math.max(4, options.size ?? (isRect(at) ? clamp(Math.min(at.width, at.height) * 0.6, 12, 48) : 20));
	const turn = ((rand() - 0.5) * 12 * Math.PI) / 180;
	const place = ([x, y]: GesturePoint): GesturePoint => [cx + s * (x * Math.cos(turn) - y * Math.sin(turn)), cy + s * (x * Math.sin(turn) + y * Math.cos(turn))];
	const p0: GesturePoint = [-0.42 + rand() * 0.08, -0.05 + rand() * 0.08];
	const p1: GesturePoint = [-0.12 + rand() * 0.06, 0.38 + rand() * 0.06];
	const p2: GesturePoint = [0.48 + rand() * 0.06, -0.5 + rand() * 0.06];
	const short = wobblyLine(place(p0), place(p1), rand, 0, -s * 0.03);
	const long = wobblyLine(place(p1), place(p2), rand, Math.min(1, s * 0.02), s * 0.06);
	return { points: [...short, ...long.slice(1)].map(round), pressure: [0.5, 0.95, 0.9, 0.7, 0.35] };
}
