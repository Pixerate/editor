// Export mapping adapted from effectcraft-main/crates/lottie/src/{anim,shapes,export}.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors).
import { resolveEasing, reverseCubicBezier } from '../animation/easing.js';
import { toBezierPath, type BezierPath } from '../canvas/pathops/bezier.js';
import { normalizeTokenColor } from '../tokens/color.js';
import { expandVectorAppearances } from '../vector/appearance.js';
import { IDENTITY_MATRIX, nodeMatrix, vectorPathWorldBezier, type AffineMatrix } from '../vector/geometry.js';
import type { VectorNode, VectorPaint, VectorPathNode } from '../vector/types.js';
import { compileMotionScene, indexMotionNodes, motionTrackKey, trackValue, type MotionNodeEntry, type MotionProperty, type MotionSegment } from './compile.js';
import { motionFrameAt, motionNodeOffset } from './evaluate.js';
import type { MotionScene } from './types.js';

/**
 * Export to Lottie (Bodymovin JSON, v5): the scene as one shape layer whose groups mirror the
 * artwork. Lottie players (lottie-web, rlottie, the iOS and Android libraries) then play it.
 *
 * - Each node is an outer group carrying its animated pose (anchor at its centre, position,
 *   scale, rotation, opacity) around an inner group carrying its own transform. Paths keep their
 *   own transform in their points.
 * - Paths become `sh` shapes with solid fills (`fl`) and strokes (`st`). Drawing on becomes trim
 *   paths (`tm`), and colours, stroke width and fill opacity animate on the fill and stroke.
 * - The camera becomes the transform of a root group.
 * - A change is written as keyframes with Lottie's bezier easing when a cubic-bezier ease (run
 *   backwards for a mirrored repeat) is all that drives that property over that stretch.
 *   Everything else is sampled at `fps` into linear keyframes: springs, elastic, behaviours,
 *   stepped time, geometric zooms, additive layers, follows and camera moves.
 *
 * Gradients, dashes, reveal clips and skews of groups are not carried over; `notes` says so.
 */

/** A Lottie property: static (`a: 0`) or keyframed (`a: 1`). */
export type LottieValue = { a: 0; k: number | number[] } | { a: 1; k: LottieKeyframe[] };

export interface LottieKeyframe {
	/** Frame. */
	t: number;
	/** Value from this key on. */
	s: number[];
	/** Out tangent of the ease to the next key (`x1`, `y1`). */
	o?: { x: number[]; y: number[] };
	/** In tangent of the ease to the next key (`x2`, `y2`). */
	i?: { x: number[]; y: number[] };
	/** Hold until the next key. */
	h?: 1;
}

/** A Lottie shape item (group, path, fill, stroke, trim, transform): plain JSON. */
export type LottieShape = { ty: string; nm?: string; [key: string]: unknown };

/** A Lottie animation: plain Bodymovin JSON. */
export interface LottieAnimation {
	v: string;
	fr: number;
	ip: number;
	op: number;
	w: number;
	h: number;
	nm: string;
	ddd: 0;
	assets: [];
	layers: Record<string, unknown>[];
	/** One marker per shot (`cm` its label, else its id). */
	markers: { tm: number; cm: string; dr: number }[];
}

export interface LottieExportOptions {
	/** Frame rate and sampling rate (default: the scene's `fps`, else 30). */
	fps?: number;
	/** Decimal places (default 3). */
	precision?: number;
}

export interface LottieExport {
	lottie: LottieAnimation;
	/** Keyframes that sample changes Lottie cannot ease the same way. */
	sampled: number;
	/** What could not be carried over, in sentences. */
	notes: string[];
}

type Vec = number[];
type Bezier4 = [number, number, number, number];

const STATIC_TR = (): LottieShape => ({
	ty: 'tr',
	p: { a: 0, k: [0, 0] },
	a: { a: 0, k: [0, 0] },
	s: { a: 0, k: [100, 100] },
	r: { a: 0, k: 0 },
	o: { a: 0, k: 100 },
	sk: { a: 0, k: 0 },
	sa: { a: 0, k: 0 }
});

/** `#rrggbb` (or anything `normalizeTokenColor` reads) as Lottie's 0–1 RGBA. */
function rgba(color: unknown): Vec | null {
	const hex = typeof color === 'string' ? normalizeTokenColor(color) : null;
	if (!hex) return null;
	const n = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
	return [n(1), n(3), n(5), hex.length >= 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1];
}

/** A path as Lottie shape data per contour: vertices with in / out tangents relative to them. */
function lottieContours(path: BezierPath, round: (n: number) => number): { c: boolean; v: Vec[]; i: Vec[]; o: Vec[] }[] {
	const out: { c: boolean; v: Vec[]; i: Vec[]; o: Vec[] }[] = [];
	let cur: { c: boolean; v: Vec[]; i: Vec[]; o: Vec[] } | null = null;
	let px = 0;
	let py = 0;
	const add = (x: number, y: number, inX: number, inY: number) => {
		cur!.v.push([x, y]);
		cur!.i.push([inX - x, inY - y]);
		cur!.o.push([0, 0]);
		px = x;
		py = y;
	};
	for (const cmd of path) {
		if (cmd.type === 'M') {
			if (cur) out.push(cur);
			cur = { c: false, v: [], i: [], o: [] };
			add(cmd.x, cmd.y, cmd.x, cmd.y);
		} else if (!cur) continue;
		else if (cmd.type === 'L') add(cmd.x, cmd.y, cmd.x, cmd.y);
		else if (cmd.type === 'Q') {
			const c1 = [px + (2 / 3) * (cmd.x1 - px), py + (2 / 3) * (cmd.y1 - py)];
			const c2 = [cmd.x + (2 / 3) * (cmd.x1 - cmd.x), cmd.y + (2 / 3) * (cmd.y1 - cmd.y)];
			cur.o[cur.o.length - 1] = [c1[0] - px, c1[1] - py];
			add(cmd.x, cmd.y, c2[0], c2[1]);
		} else if (cmd.type === 'C') {
			cur.o[cur.o.length - 1] = [cmd.x1 - px, cmd.y1 - py];
			add(cmd.x, cmd.y, cmd.x2, cmd.y2);
		} else if (cmd.type === 'Z') {
			cur.c = true;
			// A closing segment that ends on the first vertex folds into it.
			const n = cur.v.length;
			if (n > 1 && Math.abs(cur.v[n - 1][0] - cur.v[0][0]) < 1e-9 && Math.abs(cur.v[n - 1][1] - cur.v[0][1]) < 1e-9) {
				cur.i[0] = cur.i[n - 1];
				cur.v.pop();
				cur.i.pop();
				cur.o.pop();
			}
			out.push(cur);
			cur = null;
		}
	}
	if (cur) out.push(cur);
	return out.map((c) => ({ c: c.c, v: c.v.map((p) => p.map(round)), i: c.i.map((p) => p.map(round)), o: c.o.map((p) => p.map(round)) }));
}

/** The node's own matrix as Lottie transform parts (no skew), or null when it skews. */
function staticParts(m: AffineMatrix): { p: Vec; s: Vec; r: number } | null {
	const sx = Math.hypot(m[0], m[1]);
	if (!(sx > 1e-12)) return null;
	const sy = (m[0] * m[3] - m[1] * m[2]) / sx;
	if (Math.abs(m[2] + (m[1] / sx) * sy) > 1e-6 || Math.abs(m[3] - (m[0] / sx) * sy) > 1e-6) return null;
	return { p: [m[4], m[5]], s: [sx * 100, sy * 100], r: (Math.atan2(m[1], m[0]) * 180) / Math.PI };
}

/** A scene as a Lottie animation. */
export function toLottie(scene: MotionScene, options: LottieExportOptions = {}): LottieExport {
	const fps = options.fps ?? scene.fps ?? 30;
	const precision = options.precision ?? 3;
	const round = (n: number) => Math.round(n * 10 ** precision) / 10 ** precision;
	const frame = (ms: number) => round((ms * fps) / 1000);
	const timeline = compileMotionScene(scene);
	const nodes = indexMotionNodes(scene.artwork.nodes);
	const notes: string[] = [];
	let sampled = 0;
	const track = (id: string, p: MotionProperty) => timeline.tracks.get(motionTrackKey(id, p)) ?? [];
	// Additive layers (blend "add"), on their own tracks when the editor has them.
	const layers = (id: string, p: MotionProperty) => timeline.tracks.get(`${motionTrackKey(id, p)}\u0000add`) ?? [];
	const end = timeline.duration;

	/** The Lottie bezier for a segment's ease, if its change can be one eased keyframe. */
	const curveOf = (s: MotionSegment): Bezier4 | undefined => {
		if (s.behavior || s.steps || s.geometric) return undefined;
		const e = s.reverse ? reverseCubicBezier(s.ease) : resolveEasing(s.ease);
		if (!e || e === 'hold' || e.type !== 'cubic-bezier') return undefined;
		return [e.x1, e.y1, e.x2, e.y2];
	};

	/**
	 * A property's keyframes: one eased key per stretch where every active segment shares that
	 * stretch and one cubic-bezier ease, linear keys at `fps` elsewhere.
	 */
	const animate = (segments: readonly MotionSegment[], value: (t: number) => Vec, exact = true): LottieValue => {
		const rest = value(0).map(round);
		if (!segments.length) return { a: 0, k: rest.length === 1 ? rest[0] : rest };
		const keys: LottieKeyframe[] = [];
		const key = (t: number, v: Vec, ease?: Bezier4 | 'linear' | 'hold') => {
			const k: LottieKeyframe = { t: frame(t), s: v.map(round) };
			if (ease === 'hold') k.h = 1;
			else {
				const [x1, y1, x2, y2] = ease === 'linear' || !ease ? [0, 0, 1, 1] : ease;
				k.o = { x: [round(x1)], y: [round(y1)] };
				k.i = { x: [round(x2)], y: [round(y2)] };
			}
			if (keys.length && keys[keys.length - 1].t === k.t) keys[keys.length - 1] = k;
			else keys.push(k);
		};
		const times = [...new Set([0, ...segments.flatMap((s) => [s.start, s.end]), end])].filter((t) => t >= 0 && t <= end).sort((a, b) => a - b);
		for (let n = 0; n + 1 < times.length; n++) {
			const a = times[n];
			const b = times[n + 1];
			const active = segments.filter((s) => s.start < b && s.end > a);
			if (!active.length) {
				key(a, value(a), 'hold');
				continue;
			}
			const first = active[0];
			const curve = exact && active.every((s) => s.start === a && s.end === b && JSON.stringify(curveOf(s)) === JSON.stringify(curveOf(first))) ? curveOf(first) : undefined;
			if (curve) {
				key(a, value(a), curve);
				continue;
			}
			const count = Math.max(1, Math.ceil(((b - a) * fps) / 1000));
			for (let k = 0; k < count; k++) {
				const t = a + ((b - a) * k) / count;
				key(t, value(t), 'linear');
				sampled++;
			}
		}
		// Changes that cut (no length) land on their frame.
		for (const s of segments) if (s.end <= s.start) key(s.start, value(s.start), 'hold');
		keys.sort((x, y) => x.t - y.t);
		key(end, value(end), 'hold');
		const last = keys[keys.length - 1];
		delete last.o;
		delete last.i;
		delete last.h;
		return { a: 1, k: keys };
	};

	/** The node's offset as Lottie transform parts at `t` (anchor at its centre). */
	const poseAt = (entry: MotionNodeEntry, t: number) => {
		const o = motionNodeOffset(entry, timeline, t, nodes);
		if (!o) return { p: [entry.center.x, entry.center.y], s: [100, 100], r: 0 };
		const m = o.matrix;
		const sx = Math.hypot(m[0], m[1]);
		const sy = sx > 1e-12 ? (m[0] * m[3] - m[1] * m[2]) / sx : 0;
		const c = entry.center;
		return { p: [m[0] * c.x + m[2] * c.y + m[4], m[1] * c.x + m[3] * c.y + m[5]], s: [sx * 100, sy * 100], r: (Math.atan2(m[1], m[0]) * 180) / Math.PI };
	};

	/** The outer group's transform: the node's animated pose and opacity. */
	const poseTransform = (entry: MotionNodeEntry): LottieShape => {
		const id = entry.node.id;
		const tr = STATIC_TR();
		const c = [entry.center.x, entry.center.y].map(round);
		const own = (p: MotionProperty) => track(id, p);
		const layered = (['x', 'y', 'rotation', 'scaleX', 'scaleY'] as MotionProperty[]).some((p) => layers(id, p).length);
		const moving = (['x', 'y', 'rotation', 'scaleX', 'scaleY', 'follow'] as MotionProperty[]).some((p) => own(p).length) || layered;
		if (moving) {
			// Position, rotation and scale are separate in Lottie, so each is exact on its own; follows and layers mix them and are sampled.
			const mixed = own('follow').length > 0 || layered;
			tr.a = { a: 0, k: c };
			tr.p = animate(mixed ? [...own('x'), ...own('y'), ...own('follow'), ...layers(id, 'x'), ...layers(id, 'y')] : [...own('x'), ...own('y')], (t) => poseAt(entry, t).p, !mixed);
			tr.r = animate(mixed ? [...own('rotation'), ...own('follow'), ...layers(id, 'rotation')] : own('rotation'), (t) => [poseAt(entry, t).r], !mixed);
			tr.s = animate(mixed ? [...own('scaleX'), ...own('scaleY'), ...layers(id, 'scaleX'), ...layers(id, 'scaleY')] : [...own('scaleX'), ...own('scaleY')], (t) => poseAt(entry, t).s, !mixed);
			// Lottie needs the position where the anchor is when nothing moves it.
			if ((tr.p as LottieValue).a === 0) tr.p = { a: 0, k: poseAt(entry, 0).p.map(round) };
		}
		const opacity = own('opacity');
		const rest = entry.node.opacity ?? 1;
		tr.o = opacity.length ? animate(opacity, (t) => [Math.min(1, Math.max(0, Number(trackValue(opacity, t) ?? rest))) * 100]) : { a: 0, k: round(rest * 100) };
		return tr;
	};

	/** The outermost of a path and its groups whose track sets `p` (a group's paint goes to each path in it). */
	const owner = (path: VectorPathNode, p: MotionProperty): string | undefined => {
		const entry = nodes.get(path.id);
		if (!entry) return undefined;
		return [...entry.ancestors, path.id].find((id) => timeline.tracks.has(motionTrackKey(id, p)));
	};

	const paintOf = (paint: VectorPaint | undefined, what: string, id: string): Vec | null => {
		if (paint === undefined || paint === null || paint === 'none') return null;
		const c = rgba(paint);
		if (!c) notes.push(`"${id}": its ${what} is a gradient, which is not exported; it is left unpainted.`);
		return c;
	};

	const pathShapes = (path: VectorPathNode): LottieShape[] => {
		const items: LottieShape[] = [];
		const shapeSegments = [...timeline.tracks.entries()].filter(([k]) => k.startsWith(`${path.id}\u0000`) && (k.endsWith('\u0000shape') || k.includes('\u0000effect:'))).flatMap(([, v]) => v);
		const geometryAt = (t: number): BezierPath => {
			if (!shapeSegments.length) return vectorPathWorldBezier(path);
			const now = indexMotionNodes(motionFrameAt(scene, t, { draw: false, offsets: false }).document.nodes).get(path.id)?.node;
			return now && now.type === 'path' ? vectorPathWorldBezier(expandVectorAppearances([now])[0] as VectorPathNode) : vectorPathWorldBezier(path);
		};
		const rest = lottieContours(toBezierPath(geometryAt(0)), round);
		rest.forEach((contour, n) => {
			let ks: LottieValue | { a: 0; k: unknown } = { a: 0, k: contour };
			if (shapeSegments.length) {
				// Lottie tweens shapes vertex by vertex: only a morph that keeps every contour's vertex count can be keyed.
				const keys: LottieKeyframe[] = [];
				let fits = true;
				const count = Math.max(1, Math.ceil((end * fps) / 1000));
				for (let k = 0; k <= count && fits; k++) {
					const t = (end * k) / count;
					const c = lottieContours(toBezierPath(geometryAt(t)), round)[n];
					if (!c || c.v.length !== contour.v.length || c.c !== contour.c) fits = false;
					else keys.push({ t: frame(t), s: [c as unknown as number], ...(k < count ? { o: { x: [0], y: [0] }, i: { x: [1], y: [1] } } : {}) } as LottieKeyframe);
				}
				if (fits) {
					ks = { a: 1, k: keys };
					sampled += keys.length;
				} else notes.push(`"${path.id}": its morph changes how many points the outline has, which Lottie cannot tween; it shows its starting shape.`);
			}
			items.push({ ty: 'sh', nm: `${path.id} ${n + 1}`, ks });
		});
		const fillFrom = owner(path, 'fill');
		const strokeFrom = owner(path, 'stroke');
		const widthFrom = owner(path, 'strokeWidth');
		const fadeFrom = owner(path, 'fillOpacity');
		const drawFrom = owner(path, 'drawEnd');
		if (drawFrom) {
			const draw = track(drawFrom, 'drawEnd');
			items.push({ ty: 'tm', nm: 'Draw on', s: { a: 0, k: 0 }, e: animate(draw, (t) => [Math.min(1, Math.max(0, Number(trackValue(draw, t) ?? 1))) * 100]), o: { a: 0, k: 0 }, m: 1 });
		}
		if (owner(path, 'drawStart')) notes.push(`"${path.id}": drawing from a start other than 0 is not exported.`);
		const stroke = paintOf(path.stroke, 'stroke', path.id);
		if (stroke || strokeFrom) {
			const colour = strokeFrom ? track(strokeFrom, 'stroke') : [];
			items.push({
				ty: 'st',
				nm: 'Stroke',
				c: colour.length ? animate(colour, (t) => rgba(trackValue(colour, t)) ?? stroke ?? [0, 0, 0, 1]) : { a: 0, k: (stroke ?? [0, 0, 0, 1]).map(round) },
				o: { a: 0, k: 100 },
				w: widthFrom ? animate(track(widthFrom, 'strokeWidth'), (t) => [Math.max(0, Number(trackValue(track(widthFrom, 'strokeWidth'), t) ?? path.strokeWidth ?? 1))]) : { a: 0, k: round(path.strokeWidth ?? 1) },
				lc: path.strokeLinecap === 'round' ? 2 : path.strokeLinecap === 'square' ? 3 : 1,
				lj: path.strokeLinejoin === 'round' ? 2 : path.strokeLinejoin === 'bevel' ? 3 : 1,
				ml: 4
			});
			if (path.strokeDasharray?.length) notes.push(`"${path.id}": its dashes are not exported; the stroke is solid.`);
			if (path.strokeAlign && path.strokeAlign !== 'center') notes.push(`"${path.id}": its stroke is drawn centred (Lottie has no inside or outside strokes).`);
		}
		const fill = paintOf(path.fill, 'fill', path.id);
		if (fill || fillFrom) {
			const colour = fillFrom ? track(fillFrom, 'fill') : [];
			const fade = fadeFrom ? track(fadeFrom, 'fillOpacity') : [];
			items.push({
				ty: 'fl',
				nm: 'Fill',
				c: colour.length ? animate(colour, (t) => rgba(trackValue(colour, t)) ?? fill ?? [0, 0, 0, 1]) : { a: 0, k: (fill ?? [0, 0, 0, 1]).map(round) },
				o: fade.length ? animate(fade, (t) => [Math.min(1, Math.max(0, Number(trackValue(fade, t) ?? 1))) * 100]) : { a: 0, k: 100 },
				r: path.fillRule === 'evenodd' ? 2 : 1
			});
		}
		return items;
	};

	// Hidden nodes are never drawn (the stage gives them display="none"), so they are left out. Marking
	// their group `hd: true` is not enough: lottie-web honours `hd` on paths, fills and strokes but not on
	// groups. Follow routes and morph targets are sampled into keyframes, so nothing in the file needs them.
	const shown = (list: readonly VectorNode[]) => list.filter((n) => n.visible !== false);

	const nodeGroup = (node: VectorNode): LottieShape => {
		const entry = nodes.get(node.id)!;
		if (timeline.tracks.has(motionTrackKey(node.id, 'clipRect')) || timeline.tracks.has(motionTrackKey(node.id, 'clipCircle')))
			notes.push(`"${node.id}": its wipe, iris or split reveal is not exported (Lottie masks belong to layers); it fades with its opacity only.`);
		let inner: LottieShape[];
		const innerTr = STATIC_TR();
		if (node.type === 'path') inner = [...pathShapes(node)];
		else {
			// Later children draw on top: Lottie lists the top item first.
			inner = shown(node.children).reverse().map(nodeGroup);
			const m = nodeMatrix(node);
			if (m !== IDENTITY_MATRIX) {
				const parts = staticParts(m);
				if (!parts) notes.push(`"${node.id}": its transform skews, which is not exported; it is drawn without the skew.`);
				else {
					innerTr.p = { a: 0, k: parts.p.map(round) };
					innerTr.s = { a: 0, k: parts.s.map(round) };
					innerTr.r = { a: 0, k: round(parts.r) };
				}
			}
		}
		const body: LottieShape = { ty: 'gr', nm: `${node.id} (own)`, it: [...inner, innerTr] };
		return { ty: 'gr', nm: node.name ?? node.id, it: [body, poseTransform(entry)] };
	};

	const artwork = { ...scene.artwork, nodes: expandVectorAppearances(scene.artwork.nodes) };
	const content = shown(artwork.nodes).reverse().map(nodeGroup);
	if (artwork.background && rgba(artwork.background))
		content.push({ ty: 'gr', nm: 'Background', it: [{ ty: 'rc', nm: 'Background', p: { a: 0, k: [artwork.width / 2, artwork.height / 2] }, s: { a: 0, k: [artwork.width, artwork.height] }, r: { a: 0, k: 0 } }, { ty: 'fl', c: { a: 0, k: rgba(artwork.background)!.map(round) }, o: { a: 0, k: 100 }, r: 1 }, STATIC_TR()] });

	// The camera: a root transform that maps its box onto the canvas.
	const camera = track('', 'camera');
	const root = STATIC_TR();
	if (camera.length) {
		const box = (t: number) => (trackValue(camera, t) as number[] | undefined) ?? [0, 0, artwork.width, artwork.height];
		root.a = animate(camera, (t) => box(t).slice(0, 2), false);
		root.s = animate(camera, (t) => [(artwork.width / box(t)[2]) * 100, (artwork.height / box(t)[3]) * 100], false);
	}

	const op = Math.max(1, Math.ceil((end * fps) / 1000));
	const lottie: LottieAnimation = {
		v: '5.7.4',
		fr: fps,
		ip: 0,
		op,
		w: artwork.width,
		h: artwork.height,
		nm: scene.name,
		ddd: 0,
		assets: [],
		layers: [
			{
				ddd: 0,
				ind: 1,
				ty: 4,
				nm: scene.name,
				sr: 1,
				ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [0, 0, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } },
				ao: 0,
				shapes: [{ ty: 'gr', nm: 'Camera', it: [...content, root] }],
				ip: 0,
				op,
				st: 0,
				bm: 0
			}
		],
		markers: timeline.shots.map((s) => ({ tm: frame(s.start), cm: s.label ?? s.id, dr: frame(s.end - s.start) }))
	};
	return { lottie, sampled, notes: [...new Set(notes)] };
}
