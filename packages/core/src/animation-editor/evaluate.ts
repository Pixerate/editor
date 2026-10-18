import { normalizeTokenColor, hexToRgba, rgbaToHex } from '../tokens/color.js';
import { createVectorMorph, type VectorMorph } from '../vector/blend.js';
import { bezierPathLength, bezierPathPointAtLength } from '../canvas/pathops/bezier.js';
import { createVectorEffect } from '../vector/appearance.js';
import { applyMatrix, invertMatrix, multiplyMatrices, nodeMatrix, rotateMatrix, scaleMatrix, translateMatrix, vectorPathWorldBezier, isIdentityMatrix, type AffineMatrix } from '../vector/geometry.js';
import { vectorDocumentToSvg, type VectorSvgExportOptions } from '../vector/svg.js';
import type { VectorDocument, VectorEffect, VectorGradient, VectorNode, VectorPaint, VectorPathNode } from '../vector/types.js';
import { activeSegment, compileMotionScene, indexMotionNodes, motionTrackKey, segmentProgress, trackValue, type MotionNodeEntry, type MotionProperty, type MotionTimeline } from './compile.js';
import type { MotionRect, MotionScene } from './types.js';

/** The artwork as it stands at one time, and where the camera looks. */
export interface MotionFrame {
	time: number;
	document: VectorDocument;
	camera: MotionRect;
}

export interface MotionFrameOptions {
	/** Control values (`{ accent: "#0ea5e9" }`): each recolours its control's default colour. */
	values?: Record<string, string>;
	/** Draw-on as a Trim Paths effect (default true). Off leaves strokes whole. */
	draw?: boolean;
	/** Apply moves, turns, scales and follows (default true). Off leaves nodes where they rest. */
	offsets?: boolean;
}

/** Id of the trim effect that draws strokes on. */
export const MOTION_DRAW_EFFECT_ID = '~draw';

const TRANSFORM_PROPS: MotionProperty[] = ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'follow'];
const tidy = (v: number) => Math.round(v * 1e6) / 1e6 || 0;

/** A copy of the scene with each control's default colour replaced by its value (exact, case-insensitive matches). */
export function applyMotionControlValues(scene: MotionScene, values: Record<string, string> | undefined): MotionScene {
	if (!values || !scene.controls?.length) return scene;
	const map = new Map<string, string>();
	for (const control of scene.controls) {
		const value = values[control.name];
		if (typeof value === 'string' && normalizeTokenColor(value) !== null) map.set(control.default.toLowerCase(), value);
	}
	if (!map.size) return scene;
	const walk = (v: unknown): unknown => {
		if (typeof v === 'string') return map.get(v.toLowerCase()) ?? v;
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
		return v;
	};
	return { ...scene, artwork: walk(scene.artwork) as VectorDocument, shots: walk(scene.shots) as MotionScene['shots'] };
}

/** `color` with its alpha multiplied by `alpha` (as `#rrggbbaa`), or `color` when unreadable. */
function fadeColor(color: string, alpha: number): string {
	const hex = normalizeTokenColor(color);
	if (hex === null) return color;
	const c = hexToRgba(hex)!;
	return rgbaToHex(c.r, c.g, c.b, c.a * alpha);
}

function fadePaint(paint: VectorPaint | undefined, alpha: number): VectorPaint | undefined {
	if (alpha >= 1 || paint == null || paint === 'none') return paint;
	if (typeof paint === 'string') return fadeColor(paint, alpha);
	if ('stops' in paint && Array.isArray(paint.stops)) return { ...(paint as VectorGradient), stops: paint.stops.map((s) => ({ ...s, opacity: (s.opacity ?? 1) * alpha })) } as VectorGradient;
	return paint;
}

/** Applies `fn` to the node if it is a path, else to every path inside it. */
function mapPaths(node: VectorNode, fn: (path: VectorPathNode) => VectorPathNode): VectorNode {
	if (node.type === 'path') return fn(node);
	return { ...node, children: node.children.map((c) => mapPaths(c, fn)) };
}

const morphCache = new WeakMap<VectorNode, WeakMap<VectorNode, VectorMorph>>();
function morphBetween(a: VectorNode, b: VectorNode): VectorMorph {
	let inner = morphCache.get(a);
	if (!inner) morphCache.set(a, (inner = new WeakMap()));
	let morph = inner.get(b);
	if (!morph) inner.set(b, (morph = createVectorMorph(a, b, { id: a.id })));
	return morph;
}

/** A shape node by id as it rests in its own parent, mapped into `entry`'s parent space. */
function shapeIn(entry: MotionNodeEntry, shape: MotionNodeEntry): VectorNode {
	if (shape === entry) return entry.node;
	const m = multiplyMatrices(multiplyMatrices(nodeMatrix(shape.node), shape.parentWorld), invertMatrix(entry.parentWorld));
	return { ...shape.node, ...(isIdentityMatrix(m) ? { transform: undefined } : { transform: m as VectorNode['transform'] }) } as VectorNode;
}

/** The node's own shape at `time` (a morph in progress, or the shape it last became). */
function shapeAt(entry: MotionNodeEntry, timeline: MotionTimeline, nodes: Map<string, MotionNodeEntry>, time: number): VectorNode | null {
	const track = timeline.tracks.get(motionTrackKey(entry.node.id, 'shape'));
	if (!track?.length) return null;
	const s = activeSegment(track, time);
	const fromId = String(s ? s.from : track[0].from);
	if (!s) return fromId === entry.node.id ? null : (nodes.get(fromId) ? shapeIn(entry, nodes.get(fromId)!) : null);
	const a = nodes.get(fromId);
	const b = nodes.get(String(s.to));
	if (!a || !b) return null;
	const { eased } = segmentProgress(s, time);
	const u = Math.min(1, Math.max(0, eased));
	if (u <= 0) return a === entry ? null : shapeIn(entry, a);
	if (u >= 1) return b === entry ? null : shapeIn(entry, b);
	return morphBetween(shapeIn(entry, a), shapeIn(entry, b)).at(u);
}

/** Where a follow puts the node's centre (parent space), and the path's angle in degrees. */
function followAt(entry: MotionNodeEntry, timeline: MotionTimeline, nodes: Map<string, MotionNodeEntry>, time: number): { x: number; y: number; angle: number } | null {
	const track = timeline.tracks.get(motionTrackKey(entry.node.id, 'follow'));
	const s = activeSegment(track, time) ?? track?.[0];
	if (!s?.path) return null;
	const path = nodes.get(s.path);
	if (!path || path.node.type !== 'path') return null;
	const progress = Number(trackValue(track, time));
	if (!(progress >= 0)) return null;
	try {
		const bezier = vectorPathWorldBezier(path.node, path.parentWorld, { effects: false });
		const at = bezierPathPointAtLength(bezier, Math.min(1, Math.max(0, progress)) * bezierPathLength(bezier));
		if (!at) return null;
		const p = applyMatrix(invertMatrix(entry.parentWorld), { x: at.point[0], y: at.point[1] });
		return { x: p.x, y: p.y, angle: s.rotate ? (at.angle * 180) / Math.PI : 0 };
	} catch {
		return null;
	}
}

/**
 * The transform a node's offsets, turn, scale and follow add (parent space), or null when none.
 * `raw` ignores behaviours (the pose a pulse or shake swings towards, as Flair is given it).
 */
export function motionNodeOffset(entry: MotionNodeEntry, timeline: MotionTimeline, time: number, nodes = indexMotionNodes([entry.node]), raw = false): { matrix: AffineMatrix; dx: number; dy: number; rotation: number; scaleX: number; scaleY: number } | null {
	const read = (p: MotionProperty, rest: number) => {
		const v = trackValue(timeline.tracks.get(motionTrackKey(entry.node.id, p)), time, raw);
		return typeof v === 'number' ? v : rest;
	};
	if (!TRANSFORM_PROPS.some((p) => timeline.tracks.has(motionTrackKey(entry.node.id, p)))) return null;
	let dx = read('x', 0);
	let dy = read('y', 0);
	let rotation = read('rotation', 0);
	const scaleX = read('scaleX', 1);
	const scaleY = read('scaleY', 1);
	const follow = followAt(entry, timeline, nodes, time);
	if (follow) {
		dx += follow.x - entry.center.x;
		dy += follow.y - entry.center.y;
		rotation += follow.angle;
	}
	const c = entry.center;
	const matrix = multiplyMatrices(multiplyMatrices(scaleMatrix(scaleX, scaleY, c), rotateMatrix(rotation, c)), translateMatrix(dx, dy));
	return { matrix, dx, dy, rotation, scaleX, scaleY };
}

/**
 * The scene at `time` (ms): the artwork with every change applied, and the camera. A pure
 * function of time, so frames can be drawn in any order (and the same frames come out every time).
 */
export function motionFrameAt(scene: MotionScene, time: number, options: MotionFrameOptions = {}): MotionFrame {
	const s = applyMotionControlValues(scene, options.values);
	const timeline = compileMotionScene(s);
	const nodes = indexMotionNodes(s.artwork.nodes);
	const drawOn = options.draw !== false;
	const value = (id: string, p: MotionProperty) => trackValue(timeline.tracks.get(motionTrackKey(id, p)), time);
	const animated = new Set(timeline.segments.map((seg) => seg.node));

	const visit = (node: VectorNode): VectorNode => {
		let out: VectorNode = node.type === 'group' ? { ...node, children: node.children.map(visit) } : node;
		if (!animated.has(node.id)) return out;
		const entry = nodes.get(node.id);
		if (!entry) return out;
		const id = node.id;

		const shape = shapeAt(entry, timeline, nodes, time);
		if (shape) {
			const { name, visible, opacity, locked } = node;
			out = { ...shape, id, ...(name ? { name } : {}), ...(locked ? { locked } : {}), visible, ...(opacity !== undefined ? { opacity } : {}) } as VectorNode;
			if (out.visible === undefined) delete out.visible;
		}

		// Live path effect parameters.
		const effectTracks = [...timeline.tracks.keys()].filter((k) => k.startsWith(`${id}\u0000effect:`));
		if (effectTracks.length && out.effects?.length) {
			out = {
				...out,
				effects: out.effects.map((effect) => {
					let params = effect.params as unknown as Record<string, unknown>;
					for (const key of effectTracks) {
						const [, effectId, param] = key.split('\u0000')[1].split(':');
						if (effectId !== effect.id) continue;
						const v = trackValue(timeline.tracks.get(key), time);
						if (typeof v === 'number') params = { ...params, [param]: v };
					}
					return params === (effect.params as unknown) ? effect : ({ ...effect, params } as VectorEffect);
				})
			};
		}

		const fill = value(id, 'fill');
		const stroke = value(id, 'stroke');
		const strokeWidth = value(id, 'strokeWidth');
		const fillOpacity = value(id, 'fillOpacity');
		const drawStart = value(id, 'drawStart');
		const drawEnd = value(id, 'drawEnd');
		const draw = drawOn && (drawStart !== undefined || drawEnd !== undefined);
		if (fill !== undefined || stroke !== undefined || strokeWidth !== undefined || fillOpacity !== undefined || draw) {
			out = mapPaths(out, (path) => {
				let p: VectorPathNode = path;
				if (typeof fill === 'string') p = { ...p, fill };
				if (typeof stroke === 'string') p = { ...p, stroke };
				if (typeof strokeWidth === 'number') p = { ...p, strokeWidth: Math.max(0, tidy(strokeWidth)) };
				if (typeof fillOpacity === 'number' && fillOpacity < 1) p = { ...p, fill: fadePaint(p.fill, Math.max(0, fillOpacity)) };
				if (draw) {
					const start = Math.min(1, Math.max(0, typeof drawStart === 'number' ? drawStart : 0));
					const end = Math.min(1, Math.max(0, typeof drawEnd === 'number' ? drawEnd : 1));
					if (start > 0 || end < 1) {
						const trim = createVectorEffect('trim', MOTION_DRAW_EFFECT_ID, { start: tidy(start * 100), end: tidy(end * 100) })!;
						p = { ...p, effects: [trim, ...(p.effects ?? []).filter((e) => e.id !== MOTION_DRAW_EFFECT_ID)] };
					}
				}
				return p;
			});
		}

		const opacity = value(id, 'opacity');
		if (typeof opacity === 'number') {
			const o = Math.min(1, Math.max(0, tidy(opacity)));
			out = { ...out, opacity: o };
			if (o >= 1) delete out.opacity;
		}

		const offset = options.offsets === false ? null : motionNodeOffset(entry, timeline, time, nodes);
		if (offset && !isIdentityMatrix(offset.matrix)) {
			const m = multiplyMatrices(nodeMatrix(out), offset.matrix).map(tidy) as unknown as VectorNode['transform'];
			out = { ...out, transform: m };
		}
		return out;
	};

	const document: VectorDocument = { ...s.artwork, nodes: s.artwork.nodes.map(visit) };
	const cam = trackValue(timeline.tracks.get(motionTrackKey('', 'camera')), time);
	const box = Array.isArray(cam) ? cam : [0, 0, s.artwork.width, s.artwork.height];
	return { time, document, camera: { x: tidy(box[0]), y: tidy(box[1]), width: tidy(box[2]), height: tidy(box[3]) } };
}

export interface MotionSvgOptions extends MotionFrameOptions, VectorSvgExportOptions {}

/** The scene at `time` as a standalone SVG (the camera becomes the `viewBox`). */
export function motionFrameToSvg(scene: MotionScene, time: number, options: MotionSvgOptions = {}): string {
	const frame = motionFrameAt(scene, time, options);
	return withViewBox(vectorDocumentToSvg(frame.document, options), frame.camera);
}

/** Replaces the root `viewBox` of an SVG string. */
export function withViewBox(svg: string, box: MotionRect): string {
	const f = (n: number) => String(Math.round(n * 1000) / 1000);
	return svg.replace(/viewBox="[^"]*"/, `viewBox="${f(box.x)} ${f(box.y)} ${f(box.width)} ${f(box.height)}"`);
}
