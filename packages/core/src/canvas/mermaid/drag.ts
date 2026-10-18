// Direct manipulation follows Ursula's family canvases (src/react/canvases/*.tsx) and the drop
// handling in src/react/canvas/Canvas.tsx (`onNodeDragStop`): drags become the same edits the
// adapters already understand (`moveNodes`, `resizeNode`, `addEdge`, `setNodeData`,
// `setEdgeData`, `setNodeParent`), planned here once for React, Svelte and agents.
import { familyUI } from '../../diagram/families/index.js';
import { faceY, scoreAt } from '../../diagram/journey/geometry.js';
import { sequenceGeometry } from '../../diagram/sequence/geometry.js';
import type { DiagramFamily, EditOp, MermaidDocument, Point } from '../../diagram/types.js';
import type { DiagramLayout } from './layout.js';
import type { DiagramDragKind, DiagramMark, DiagramScene, DiagramSceneTheme } from './scene-kit.js';

/** Which marks start which drag, by family and mark role. */
const DRAG_ROLES: Partial<Record<DiagramFamily, Record<string, DiagramDragKind>>> = {
	gantt: { bar: 'move', milestone: 'move', 'task-label': 'move' },
	journey: { task: 'move-x', 'task-label': 'move-x', actor: 'move-x', face: 'score', 'face-eye': 'score', 'face-mouth': 'score' },
	quadrant: { point: 'move', 'point-label': 'move' },
	mindmap: { topic: 'move', 'topic-label': 'move', 'topic-underline': 'move', icon: 'move' },
	sequence: {
		participant: 'move-x',
		'participant-label': 'move-x',
		'participant-figure': 'move-x',
		'participant-mirror': 'move-x',
		'participant-mirror-label': 'move-x',
		'participant-mirror-figure': 'move-x',
		lifeline: 'connect',
		message: 'order',
		'message-label': 'order',
		'message-number': 'order'
	},
	timeline: { period: 'move-x', 'period-label': 'move-x' },
	gitGraph: { commit: 'connect', 'commit-inner': 'connect', 'commit-reverse': 'connect' },
	c4: { element: 'move', boundary: 'move', 'boundary-label': 'move' },
	architecture: { icon: 'move', 'icon-glyph': 'move', 'icon-name': 'move', 'service-label': 'move', junction: 'move', group: 'move', 'group-label': 'move' }
};

/** Pointer travel (px) below which a press is a click, not a drag. */
export const DIAGRAM_DRAG_THRESHOLD = 3;

export interface DiagramDragOptions {
	theme?: Pick<DiagramSceneTheme, 'selection'>;
	/** Selected ids: a selected Gantt task gets its resize grip and dependency knob. */
	selection?: readonly string[];
}

/**
 * Marks which marks of a family picture can be dragged (`mark.drag`), and adds the grips Ursula
 * shows on a selected Gantt task (resize its duration; drag the knob to another task to make it
 * start after this one). Pass the result to the React / Svelte scene when the diagram is
 * editable; a read-only scene is drawn without it.
 */
export function withDiagramDragHandles(scene: DiagramScene, options: DiagramDragOptions = {}): DiagramScene {
	const roles = DRAG_ROLES[scene.family];
	if (!roles) return scene;
	const marks: DiagramMark[] = scene.marks.map((m) => (m.target && roles[m.role] ? { ...m, drag: roles[m.role] } : m));
	if (scene.family === 'gantt') {
		const colour = options.theme?.selection ?? '#2563eb';
		for (const id of options.selection ?? []) {
			const bar = scene.marks.find((m): m is Extract<DiagramMark, { kind: 'rect' }> => m.kind === 'rect' && m.role === 'bar' && m.target === id);
			if (!bar) continue;
			const right = bar.x + bar.width;
			marks.push(
				{ kind: 'rect', key: `resize-handle:${id}`, role: 'resize-handle', target: id, drag: 'resize', x: right - 4, y: bar.y, width: 8, height: bar.height, fill: colour, opacity: 0.35, radius: 2 },
				{ kind: 'circle', key: `link-handle:${id}`, role: 'link-handle', target: id, drag: 'connect', cx: right + 12, cy: bar.y + bar.height / 2, r: 5, fill: colour, stroke: '#ffffff', strokeWidth: 1.5 }
			);
		}
	}
	return { ...scene, marks };
}

/** A drag in progress, in scene (canvas) coordinates. */
export interface DiagramDrag {
	kind: DiagramDragKind;
	/** The node or edge the dragged mark targets. */
	target: string;
	/** Where the pointer went down. */
	start: Point;
	/** Where it is now. */
	pointer: Point;
	/** The node under the pointer (for `connect`), if any. */
	over?: string | null;
}

const constrain = (kind: DiagramDragKind, dx: number, dy: number): Point => (kind === 'move-x' ? [dx, 0] : kind === 'move-y' ? [0, dy] : [dx, dy]);

/** Whether the pointer has travelled far enough for a press to count as a drag. */
export function isDiagramDrag(drag: Pick<DiagramDrag, 'start' | 'pointer'>): boolean {
	return Math.hypot(drag.pointer[0] - drag.start[0], drag.pointer[1] - drag.start[1]) >= DIAGRAM_DRAG_THRESHOLD;
}

/** The innermost group whose box holds `point`, other than `exclude` and its descendants. */
function groupAt(doc: MermaidDocument, layout: DiagramLayout, point: Point, exclude: string): string | undefined {
	const inside = (id: string) => {
		let cur: string | undefined = id;
		for (let i = 0; cur && i < 50; i++) {
			if (cur === exclude) return true;
			cur = doc.graph.groups.find((g) => g.id === cur)?.parentId;
		}
		return false;
	};
	let best: { id: string; area: number } | undefined;
	for (const g of doc.graph.groups) {
		if (inside(g.id)) continue;
		const p = layout.positions[g.id];
		const s = layout.sizes[g.id];
		if (!p || !s || point[0] < p[0] || point[0] > p[0] + s.width || point[1] < p[1] || point[1] > p[1] + s.height) continue;
		const area = s.width * s.height;
		if (!best || area < best.area) best = { id: g.id, area };
	}
	return best?.id;
}

/**
 * The edits a finished drag makes, as one batch (apply it as one undo step), or `[]` when it
 * changes nothing (a click, a drop back where it started, `connect` onto empty space). Moves
 * become `moveNodes`, which each family's adapter reads its own way: new dates for a Gantt bar
 * (or another row), a new order for participants, tasks and periods, `[x, y]` for a quadrant
 * point, a new parent for a mindmap topic, a kept position for C4 and architecture (plus
 * `setNodeParent` when dropped into or out of a group). Dragging a group moves its contents.
 */
export function planDiagramDrag(doc: MermaidDocument, layout: DiagramLayout, drag: DiagramDrag): EditOp[] {
	if (doc.tier !== 'editable' || !isDiagramDrag(drag)) return [];
	const { graph } = doc;
	const dx = drag.pointer[0] - drag.start[0];
	const dy = drag.pointer[1] - drag.start[1];
	const node = graph.nodes.find((n) => n.id === drag.target);
	switch (drag.kind) {
		case 'move':
		case 'move-x':
		case 'move-y': {
			const [mx, my] = constrain(drag.kind, dx, dy);
			const group = graph.groups.find((g) => g.id === drag.target);
			if (group) {
				const ids = new Set([group.id]);
				for (let grew = true; grew; ) {
					grew = false;
					for (const item of [...graph.groups, ...graph.nodes])
						if (item.parentId && ids.has(item.parentId) && !ids.has(item.id)) {
							ids.add(item.id);
							grew = true;
						}
				}
				const moves = [...ids].flatMap((id) => {
					const p = layout.positions[id];
					return p ? [{ id, position: [p[0] + mx, p[1] + my] as Point }] : [];
				});
				return moves.length ? [{ type: 'moveNodes', moves }] : [];
			}
			const p = layout.positions[drag.target];
			if (!node || !p) return [];
			const position: Point = [p[0] + mx, p[1] + my];
			const ops: EditOp[] = [{ type: 'moveNodes', moves: [{ id: node.id, position }] }];
			// Families placed freely (C4, architecture) take a new parent from where the node lands.
			const ui = familyUI(doc.family);
			if (ui?.groups.supported && ui.arrange !== false && drag.kind === 'move') {
				const size = layout.sizes[node.id] ?? { width: 0, height: 0 };
				const into = groupAt(doc, layout, [position[0] + size.width / 2, position[1] + size.height / 2], node.id);
				if (into && into !== node.parentId) ops.push({ type: 'setNodeParent', ids: [node.id], parentId: into });
				else if (!into && node.parentId && ui.canDetach) ops.push({ type: 'setNodeParent', ids: [node.id], parentId: undefined });
			}
			return ops;
		}
		case 'resize': {
			const s = layout.sizes[drag.target];
			if (!node || !s) return [];
			return [{ type: 'resizeNode', id: node.id, size: [Math.max(1, s.width + dx), s.height] }];
		}
		case 'connect': {
			const over = drag.over;
			if (!over || over === drag.target || !graph.nodes.some((n) => n.id === drag.target) || !graph.nodes.some((n) => n.id === over)) return [];
			return [{ type: 'addEdge', edge: { source: drag.target, target: over } }];
		}
		case 'score': {
			if (!node || doc.family !== 'journey') return [];
			const from = typeof node.data?.score === 'number' ? node.data.score : 0;
			const score = scoreAt(faceY(from) + dy);
			return score === from ? [] : [{ type: 'setNodeData', id: node.id, data: { score } }];
		}
		case 'order': {
			if (doc.family !== 'sequence') return [];
			const rows = sequenceGeometry(graph).messages;
			const index = rows.findIndex((r) => r.edgeId === drag.target);
			if (index < 0) return [];
			const dropY = rows[index]!.y + dy;
			let best = index;
			let bestDist = Infinity;
			rows.forEach((r, i) => {
				const d = Math.abs(r.y - dropY);
				if (d < bestDist) {
					best = i;
					bestDist = d;
				}
			});
			return best === index ? [] : [{ type: 'setEdgeData', id: drag.target, data: { index: best } }];
		}
	}
}

const moveMark = (m: DiagramMark, dx: number, dy: number): DiagramMark => (dx || dy ? { ...m, offset: [(m.offset?.[0] ?? 0) + dx, (m.offset?.[1] ?? 0) + dy] } : m);

/**
 * The scene as it should look mid-drag: the dragged node's marks follow the pointer (along the
 * drag's axis; a journey face snaps to whole scores), a Gantt bar stretches while resized, and
 * `connect` draws a rubber band from the press to the pointer. Pure, so frameworks just render it.
 */
export function previewDiagramDrag(scene: DiagramScene, drag: DiagramDrag, options: DiagramDragOptions = {}): DiagramScene {
	if (!isDiagramDrag(drag)) return scene;
	const dx = drag.pointer[0] - drag.start[0];
	const dy = drag.pointer[1] - drag.start[1];
	const colour = options.theme?.selection ?? '#2563eb';
	let marks: DiagramMark[];
	switch (drag.kind) {
		case 'move':
		case 'move-x':
		case 'move-y':
		case 'order': {
			const [mx, my] = drag.kind === 'order' ? [0, dy] : constrain(drag.kind, dx, dy);
			marks = scene.marks.map((m) => (m.target === drag.target && m.drag ? moveMark(m, mx, my) : m));
			break;
		}
		case 'score': {
			const faces = scene.marks.filter((m) => m.target === drag.target && m.drag === 'score');
			const circle = faces.find((m): m is Extract<DiagramMark, { kind: 'circle' }> => m.kind === 'circle');
			const step = circle ? faceY(scoreAt(circle.cy + dy)) - circle.cy : dy;
			marks = scene.marks.map((m) => (m.target === drag.target && m.drag === 'score' ? moveMark(m, 0, step) : m));
			break;
		}
		case 'resize':
			marks = scene.marks.map((m) =>
				m.target !== drag.target
					? m
					: m.kind === 'rect' && m.role === 'bar'
						? { ...m, width: Math.max(1, m.width + dx) }
						: m.drag === 'resize' || m.drag === 'connect'
							? moveMark(m, dx, 0)
							: m
			);
			break;
		case 'connect':
			marks = [
				...scene.marks.map((m) => (drag.over && m.target === drag.over && m.drag ? { ...m, selected: true } : m)),
				{ kind: 'line', key: 'drag:rubber-band', role: 'drag-link', x1: drag.start[0], y1: drag.start[1], x2: drag.pointer[0], y2: drag.pointer[1], stroke: colour, strokeWidth: 2, dash: '6 4', markerEnd: 'arrowclosed' }
			];
			break;
	}
	return { ...scene, marks };
}

/** The undo label for a drag of `kind`. */
export function diagramDragLabel(kind: DiagramDragKind): string {
	return kind === 'resize' ? 'Resize' : kind === 'connect' ? 'Connect' : kind === 'score' ? 'Change score' : kind === 'order' ? 'Move message' : 'Move';
}

