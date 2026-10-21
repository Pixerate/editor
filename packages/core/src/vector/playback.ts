// Agent playback on the vector canvas (see `tools/playback.ts`): where nodes are in document units,
// and how the commands that make something are acted out (a shape is dragged out corner to corner,
// a path is traced, text is clicked in and typed). Commands that take `ids` need nothing here:
// playback visits those nodes. Pure: plans read the document before the call and change nothing.
import type { CommandSpec } from '../commands/registry.js';
import type { PlaybackPoint, PlaybackRect, PlaybackRef, PlaybackStep } from '../tools/playback.js';
import type { VectorEditorController } from './controller.js';
import { IDENTITY_MATRIX, bezierToSubpaths, vectorNodeBounds, vectorParentMatrix } from './geometry.js';

/** The playback kind of a vector node (`{ kind: 'vector', id }`, as in `data-vector-id`). */
export const VECTOR_PLAYBACK_KIND = 'vector';

/** Finds `{ kind: 'vector', id }` (a node's document-space bounds) for agent playback. */
export function createVectorPlaybackLocator(controller: Pick<VectorEditorController, 'getState' | 'getNode'>): (ref: PlaybackRef) => PlaybackRect | null {
	return (ref) => {
		if (ref.kind !== VECTOR_PLAYBACK_KIND && ref.kind !== 'item') return null;
		const node = controller.getNode(ref.id);
		if (!node) return null;
		const b = vectorNodeBounds(node, vectorParentMatrix(controller.getState().document.nodes, ref.id) ?? IDENTITY_MATRIX);
		if (!b) return null;
		// A line or a dot still gets a box the cursor can ring.
		const w = Math.max(b.width, 4);
		const h = Math.max(b.height, 4);
		return { x: b.x - (w - b.width) / 2, y: b.y - (h - b.height) / 2, width: w, height: h };
	};
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Press at `from`, drag to `to`, release. */
const dragOut = (from: PlaybackPoint, to: PlaybackPoint): PlaybackStep[] => [
	{ type: 'move', to: from },
	{ type: 'press' },
	{ type: 'drag', to },
	{ type: 'release' }
];

const click = (at: PlaybackPoint): PlaybackStep[] => [{ type: 'move', to: at }, { type: 'press' }, { type: 'release' }];

const typed = (text: unknown): PlaybackStep[] => {
	if (typeof text !== 'string' || !text.trim()) return [];
	const line = text.replace(/\s+/g, ' ').trim();
	return [{ type: 'type', text: line.length > 60 ? `${line.slice(0, 59)}…` : line }];
};

/** The anchors of SVG path data, at most `max`, spread along the path. */
function pathPoints(d: string, max = 24): PlaybackPoint[] {
	let anchors: PlaybackPoint[];
	try {
		anchors = bezierToSubpaths(d).flatMap((s) => s.anchors.map((a) => ({ x: a.x, y: a.y })));
	} catch {
		return [];
	}
	if (anchors.length <= max) return anchors;
	const step = (anchors.length - 1) / (max - 1);
	return Array.from({ length: max }, (_, i) => anchors[Math.round(i * step)]!);
}

/** Traces `points` with the button down. */
function trace(points: readonly PlaybackPoint[]): PlaybackStep[] {
	if (!points.length) return [];
	const [first, ...rest] = points;
	const total = rest.reduce((sum, p, i) => sum + Math.hypot(p.x - (i ? rest[i - 1]! : first!).x, p.y - (i ? rest[i - 1]! : first!).y), 0);
	const ms = (p: PlaybackPoint, i: number) => {
		const prev = i ? rest[i - 1]! : first!;
		// About 900 ms for the whole path, shared by length.
		return total > 0 ? Math.max(16, (900 * Math.hypot(p.x - prev.x, p.y - prev.y)) / total) : 16;
	};
	return [{ type: 'move', to: first! }, { type: 'press' }, ...rest.map((p, i): PlaybackStep => ({ type: 'drag', to: p, ms: ms(p, i) })), { type: 'release' }];
}

type Planner = (params: Record<string, any>, controller: VectorEditorController) => PlaybackStep[] | null;

const PLANS: Record<string, Planner> = {
	addShape: (p) => {
		if (![p.x, p.y, p.width, p.height].every(num)) return null;
		return dragOut({ x: p.x, y: p.y }, { x: p.x + p.width, y: p.y + p.height });
	},
	addPath: (p) => (typeof p.d === 'string' ? trace(pathPoints(p.d)) : null),
	addText: (p) => {
		if (typeof p.path === 'string') {
			const points = pathPoints(p.path, 2);
			return points.length ? [...click(points[0]!), ...typed(p.text)] : null;
		}
		const x = num(p.x) ? p.x : 0;
		const y = num(p.y) ? p.y : 0;
		const start = num(p.width) && num(p.height) ? dragOut({ x, y }, { x: x + p.width, y: y + p.height }) : click({ x, y });
		return [...start, ...typed(p.text)];
	},
	placeSymbol: (p, controller) => {
		const doc = controller.getState().document;
		const t = Array.isArray(p.transform) && p.transform.length === 6 ? p.transform : null;
		const at = t ? { x: t[4], y: t[5] } : { x: num(p.x) ? p.x : doc.width / 2, y: num(p.y) ? p.y : doc.height / 2 };
		return click(at);
	},
	setTextStyle: (p, controller) => {
		const node = controller.getNode(p.id);
		if (node?.type !== 'text') return null;
		const rect = createVectorPlaybackLocator(controller)({ kind: VECTOR_PLAYBACK_KIND, id: p.id });
		if (!rect) return null;
		// Select the range by dragging across its share of the text's width.
		const length = Math.max(1, node.text.length);
		const start = Math.min(length, Math.max(0, num(p.start) ? p.start : 0));
		const end = Math.min(length, Math.max(start, num(p.end) ? p.end : length));
		const y = rect.y + rect.height / 2;
		return [
			{ type: 'focus', rect },
			...dragOut({ x: rect.x + (rect.width * start) / length, y }, { x: rect.x + (rect.width * end) / length, y })
		];
	},
	setMeshPoint: (p, controller) => {
		const shading = controller.getShading(p.id);
		const point = shading?.points[p.index] as PlaybackPoint | undefined;
		if (!point) return null;
		return num(p.x) && num(p.y) ? dragOut(point, { x: p.x, y: p.y }) : click(point);
	}
};

// Placing an image stylized to vectors: drag out its box (top-left x, y, `width` wide).
const placeImage: Planner = (p, controller) => {
	const doc = controller.getState().document;
	const x = num(p.x) ? p.x : 0;
	const y = num(p.y) ? p.y : 0;
	const w = num(p.width) ? p.width : doc.width - x;
	return dragOut({ x, y }, { x: x + w, y: y + w });
};

/**
 * Adds agent playback plans to vector commands whose effect has a place but no ids yet (shapes,
 * paths, text, symbols, stylized images) and to edits of a part of a node (a text range, a mesh
 * point). Other commands play from the ids in their params.
 */
export function withVectorPlayback(controller: VectorEditorController, prefix: string, commands: CommandSpec[]): CommandSpec[] {
	return commands.map((spec) => {
		if (!spec.id.startsWith(prefix)) return spec;
		const name = spec.id.slice(prefix.length);
		const props = (spec.params as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
		const planner = PLANS[name] ?? (/Image$/.test(name) && 'x' in props && 'width' in props ? placeImage : undefined);
		// Every vector command plays on the vector surface, whatever its prefix.
		const surface = spec.playbackSurface ?? spec.scope ?? 'vector';
		if (!planner || spec.plan) return { ...spec, playbackSurface: surface };
		return {
			...spec,
			playbackSurface: surface,
			plan: (_ctx: unknown, params: unknown) => planner((params ?? {}) as Record<string, any>, controller)
		};
	});
}
