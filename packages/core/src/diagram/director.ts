// Acting out diagram edits follows Ursula's remote control (src/remote/commands.ts `planCommand`,
// src/remote/draft.ts): a pure planner turns each edit into cursor steps on the canvas, and a
// whole-diagram write is drawn statement by statement. Shared pieces live in animation/presence.
import {
	PerformanceQueue,
	PresenceStore,
	realPresenceClock,
	tweenPresenceCursor,
	type PresenceActorInfo,
	type PresenceClock
} from '../animation/presence.js';
import type { DiagramController } from './controller.js';
import { validateDiagramEdit } from './controller.js';
import { applyEdits, parseMermaid } from './document.js';
import { changedItems, draftFrames } from './draft.js';
import type { EditOp, MermaidDocument, Point } from './types.js';

/** Where things are drawn on the canvas (absolute top-left and size), e.g. `mermaidToCanvas(...).layout`. */
export interface DiagramPlacement {
	positions: Readonly<Record<string, Point>>;
	sizes: Readonly<Record<string, { width: number; height: number }>>;
}

export type DiagramPerformanceStep =
	| { type: 'move'; to: { x: number; y: number }; ms: number }
	| { type: 'say'; text: string; ms: number }
	| { type: 'type'; text: string; ms: number }
	| { type: 'press' }
	| { type: 'release' }
	/** Drag a node (and the cursor) so its top-left ends at `to`; the node follows live. */
	| { type: 'drag'; id: string; to: { x: number; y: number }; position: Point; ms: number }
	| { type: 'commit' };

const center = (place: DiagramPlacement, id: string) => {
	const p = place.positions[id];
	if (!p) return null;
	const s = place.sizes[id] ?? { width: 160, height: 56 };
	return { x: p[0] + s.width / 2, y: p[1] + s.height / 2 };
};

/** Bottom-right of everything drawn, where a node without a better place appears. */
function freeSpot(place: DiagramPlacement): { x: number; y: number } {
	let maxX = 0;
	let maxY = 0;
	let any = false;
	for (const [id, [x, y]] of Object.entries(place.positions)) {
		const s = place.sizes[id] ?? { width: 160, height: 56 };
		maxX = Math.max(maxX, x + s.width);
		maxY = Math.max(maxY, y + s.height);
		any = true;
	}
	return any ? { x: maxX + 60, y: maxY / 2 } : { x: 80, y: 40 };
}

const NEW_NODE = { width: 160, height: 56 };

/**
 * Where a new node's centre goes beside `from`: one rank further along the diagram's
 * direction, then stepped sideways until it overlaps nothing drawn.
 */
function besideFree(place: DiagramPlacement, from: { x: number; y: number }, direction: string): { x: number; y: number } {
	const d = direction.toUpperCase();
	const along = d === 'LR' ? { x: 1, y: 0 } : d === 'RL' ? { x: -1, y: 0 } : d === 'BT' ? { x: 0, y: -1 } : { x: 0, y: 1 };
	const side = { x: along.y, y: along.x };
	const rects = Object.entries(place.positions).map(([id, [x, y]]) => ({ x, y, ...(place.sizes[id] ?? NEW_NODE) }));
	const free = (c: { x: number; y: number }) =>
		!rects.some((r) => c.x - NEW_NODE.width / 2 - 20 < r.x + r.width && c.x + NEW_NODE.width / 2 + 20 > r.x && c.y - NEW_NODE.height / 2 - 20 < r.y + r.height && c.y + NEW_NODE.height / 2 + 20 > r.y);
	const base = { x: from.x + along.x * 240, y: from.y + along.y * 140 };
	for (let i = 0; i < 24; i++) {
		const k = i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2);
		const c = { x: base.x + side.x * k * 200, y: base.y + side.y * k * 90 };
		if (free(c)) return c;
	}
	return base;
}

/**
 * Plans how an agent acts out one edit on the canvas: where the cursor goes, what it
 * clicks, drags or types, and when the edit commits. Pure: the same document, placement
 * and edit give the same steps. `next` is the edit that follows in the same call (a new
 * node is placed beside the node an edge will connect it from).
 */
export function planDiagramEdit(doc: MermaidDocument, place: DiagramPlacement, op: EditOp, speed = 1, next?: EditOp): DiagramPerformanceStep[] {
	const ms = (n: number) => Math.round(n / Math.max(0.1, speed));
	const at = (id: string) => center(place, id);
	const click = (to: { x: number; y: number } | null): DiagramPerformanceStep[] =>
		to ? [{ type: 'move', to, ms: ms(380) }, { type: 'press' }, { type: 'release' }] : [];
	const edgeMid = (id: string) => {
		const e = doc.graph.edges.find((x) => x.id === id);
		const a = e && at(e.source);
		const b = e && at(e.target);
		return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
	};
	switch (op.type) {
		case 'addNode': {
			const from = next?.type === 'addEdge' && next.edge.target === op.node.id ? at(next.edge.source) : null;
			const to = op.position
				? { x: op.position[0] + 80, y: op.position[1] + 28 }
				: from
					? besideFree(place, from, doc.graph.direction)
					: freeSpot(place);
			const label = op.node.label ?? op.node.id;
			return [...click(to), { type: 'type', text: label, ms: ms(Math.min(900, 60 * label.length + 200)) }, { type: 'commit' }];
		}
		case 'addEdge': {
			const a = at(op.edge.source);
			const b = at(op.edge.target) ?? (a ? { x: a.x + 260, y: a.y } : null);
			if (!a || !b) return [{ type: 'commit' }];
			return [
				{ type: 'move', to: a, ms: ms(380) },
				{ type: 'press' },
				{ type: 'move', to: b, ms: ms(520) },
				{ type: 'release' },
				...(op.edge.label ? [{ type: 'type' as const, text: op.edge.label, ms: ms(500) }] : []),
				{ type: 'commit' }
			];
		}
		case 'moveNodes': {
			const steps: DiagramPerformanceStep[] = [];
			for (const move of op.moves) {
				const from = at(move.id);
				const size = place.sizes[move.id] ?? { width: 160, height: 56 };
				if (!from) continue;
				steps.push(
					{ type: 'move', to: from, ms: ms(380) },
					{ type: 'press' },
					{ type: 'drag', id: move.id, to: { x: move.position[0] + size.width / 2, y: move.position[1] + size.height / 2 }, position: move.position, ms: ms(520) },
					{ type: 'release' }
				);
			}
			return [...steps, { type: 'commit' }];
		}
		case 'renameNode':
		case 'renameGroup':
			return [...click(at(op.id)), { type: 'press' }, { type: 'release' }, { type: 'type', text: op.label, ms: ms(Math.min(900, 60 * op.label.length + 200)) }, { type: 'commit' }];
		case 'removeNodes':
			return [...click(at(op.ids[0]!)), { type: 'say', text: 'Delete', ms: ms(300) }, { type: 'commit' }];
		case 'removeEdges':
			return [...click(edgeMid(op.ids[0]!)), { type: 'say', text: 'Delete', ms: ms(300) }, { type: 'commit' }];
		case 'setEdgeLabel':
			return [...click(edgeMid(op.id)), { type: 'type', text: op.label, ms: ms(500) }, { type: 'commit' }];
		case 'reconnectEdge': {
			const a = at(op.source);
			const b = at(op.target);
			return [...click(edgeMid(op.id)), ...(a && b ? [{ type: 'move' as const, to: a, ms: ms(300) }, { type: 'press' as const }, { type: 'move' as const, to: b, ms: ms(500) }, { type: 'release' as const }] : []), { type: 'commit' }];
		}
		case 'setNodeShape':
		case 'setNodeStyles':
		case 'setNodeClasses':
		case 'setNodeLink':
		case 'setNodeData':
		case 'resizeNode':
			return [...click(at(op.id)), { type: 'commit' }];
		case 'groupNodes': {
			const points = op.nodeIds.map(at).filter((p): p is { x: number; y: number } => !!p);
			if (!points.length) return [{ type: 'commit' }];
			const min = { x: Math.min(...points.map((p) => p.x)) - 90, y: Math.min(...points.map((p) => p.y)) - 40 };
			const max = { x: Math.max(...points.map((p) => p.x)) + 90, y: Math.max(...points.map((p) => p.y)) + 40 };
			return [{ type: 'move', to: min, ms: ms(380) }, { type: 'press' }, { type: 'move', to: max, ms: ms(520) }, { type: 'release' }, { type: 'type', text: op.label, ms: ms(500) }, { type: 'commit' }];
		}
		default:
			return [{ type: 'commit' }];
	}
}

export interface DiagramDirectorOptions {
	/** Where nodes are drawn now, e.g. `() => mermaidToCanvas(controller.getDocument()).layout`. */
	placement: () => DiagramPlacement;
	clock?: PresenceClock;
	/** 1 = natural speed; 2 = twice as fast. */
	speed?: number;
	/** Hide each actor's cursor this long after its last call (ms, default 1500; 0 keeps it). */
	linger?: number;
	/** Most frames when a whole-diagram write is drawn statement by statement (default 40). */
	maxDraftFrames?: number;
}

export type DiagramPerformanceResult = { ok: true; document: MermaidDocument } | { ok: false; message: string };

/**
 * Acts out agent edits on a Mermaid diagram: each actor's cursor moves to the node or edge,
 * clicks, drags, connects and types, the edit lands, and everything one call changes is one
 * undo step, while the user keeps editing. Calls queue per actor. A batch is checked against
 * the diagram before the cursor moves; if the diagram changed underneath and an edit no
 * longer applies, the call's earlier edits are rolled back and the call fails with a sentence.
 * A whole-diagram write (`playSource`) is drawn statement by statement.
 */
export class DiagramDirector {
	readonly presence: PresenceStore;
	private readonly clock: PresenceClock;
	private readonly queue: PerformanceQueue;

	constructor(
		private readonly controller: DiagramController,
		presence: PresenceStore,
		private readonly options: DiagramDirectorOptions
	) {
		this.presence = presence;
		this.clock = options.clock ?? realPresenceClock;
		this.queue = new PerformanceQueue(presence, {
			clock: this.clock,
			linger: options.linger,
			beginGesture: (key) => controller.beginGesture(key),
			endGesture: () => controller.endGesture()
		});
	}

	/** Acts out `ops` in order for `actor` as one undo step. */
	perform(actor: PresenceActorInfo, ops: readonly EditOp[], label = 'Edit diagram'): Promise<DiagramPerformanceResult> {
		// All-or-nothing: the whole batch must apply before the cursor moves.
		let check = this.controller.getDocument();
		if (this.controller.getState().readOnly) return Promise.resolve({ ok: false, message: 'The diagram is read-only.' });
		for (const op of ops) {
			const problem = validateDiagramEdit(check, op);
			if (problem) return Promise.resolve({ ok: false, message: problem });
			check = applyEdits(check, [op]);
		}
		return this.queue.run(actor, async () => {
			const mark = this.controller.history.mark();
			const fail = (message: string): DiagramPerformanceResult => {
				this.controller.history.revertTo(mark);
				return { ok: false, message };
			};
			// Placing or dragging stores positions; pin the rest of an auto-laid diagram first so
			// it does not shift around them (see GOTCHAS.md).
			if (ops.some((op) => op.type === 'addNode' || op.type === 'moveNodes')) {
				const problem = this.pin(label);
				if (problem) return fail(problem);
			}
			for (let i = 0; i < ops.length; i++) {
				const op = ops[i]!;
				const steps = planDiagramEdit(this.controller.getDocument(), this.options.placement(), op, this.options.speed, ops[i + 1]);
				for (const step of steps) {
					const problem = await this.act(actor.id, step, op, label);
					if (problem) return fail(problem);
				}
			}
			return { ok: true, document: this.controller.getDocument() };
		});
	}

	/**
	 * Replaces the diagram with `source`, drawing it statement by statement when it extends
	 * what is there (Ursula's draft playback): each frame lands, the cursor points at what
	 * appeared, and the whole write is one undo step. Otherwise it lands at once.
	 */
	playSource(actor: PresenceActorInfo, source: string, label = 'Replace diagram'): Promise<DiagramPerformanceResult> {
		if (this.controller.getState().readOnly) return Promise.resolve({ ok: false, message: 'The diagram is read-only.' });
		return this.queue.run(actor, async () => {
			const frames = draftFrames(this.controller.getSource(), source, { maxFrames: this.options.maxDraftFrames }) ?? [source];
			const pause = Math.round(260 / Math.max(0.1, this.options.speed ?? 1));
			for (const frame of frames) {
				const before = this.controller.getDocument().graph;
				const result = this.controller.apply({ type: 'replaceSource', source: frame }, label);
				if (!result.ok) return result;
				const fresh = changedItems(before, result.document.graph);
				const target = fresh.length ? center(this.options.placement(), fresh[fresh.length - 1]!) : null;
				const actorNow = this.presence.get(actor.id);
				if (target && actorNow) await tweenPresenceCursor(this.presence, this.clock, actor.id, actorNow, target, pause);
				else await this.clock.wait(pause);
			}
			return { ok: true, document: this.controller.getDocument() };
		});
	}

	/** Stores the drawn position of every node and group that has none yet. */
	private pin(label: string): string | null {
		const doc = this.controller.getDocument();
		const stored = doc.meta.layout ?? {};
		const known = new Set([...doc.graph.nodes, ...doc.graph.groups].map((x) => x.id));
		const moves = Object.entries(this.options.placement().positions)
			.filter(([id]) => known.has(id) && !stored[id])
			.map(([id, position]) => ({ id, position }));
		if (!moves.length) return null;
		const result = this.controller.apply({ type: 'moveNodes', moves }, label);
		return result.ok ? null : result.message;
	}

	/** Runs one step; returns a problem sentence when the edit can no longer be applied. */
	private async act(id: string, step: DiagramPerformanceStep, op: EditOp, label: string): Promise<string | null> {
		const where = () => {
			const a = this.presence.get(id);
			return a ? { x: a.x, y: a.y } : { x: 0, y: 0 };
		};
		switch (step.type) {
			case 'say':
				this.presence.set({ id, message: step.text });
				await this.clock.wait(step.ms);
				return null;
			case 'type': {
				// The note grows as if typed.
				const chars = [...step.text];
				const each = step.ms / Math.max(1, chars.length);
				for (let i = 1; i <= chars.length; i++) {
					this.presence.set({ id, message: chars.slice(0, i).join('') });
					await this.clock.wait(each);
				}
				return null;
			}
			case 'move':
				await tweenPresenceCursor(this.presence, this.clock, id, where(), step.to, step.ms);
				return null;
			case 'press':
				this.presence.set({ id, pressed: true });
				return null;
			case 'release':
				this.presence.set({ id, pressed: false });
				return null;
			case 'drag': {
				const start = this.options.placement().positions[step.id];
				let problem: string | null = null;
				await tweenPresenceCursor(this.presence, this.clock, id, where(), step.to, step.ms, (e) => {
					if (problem || !start) return;
					const position: Point = [start[0] + (step.position[0] - start[0]) * e, start[1] + (step.position[1] - start[1]) * e];
					const result = this.controller.apply({ type: 'moveNodes', moves: [{ id: step.id, position }] }, label);
					if (!result.ok) problem = result.message;
				});
				return problem;
			}
			case 'commit': {
				// A new node lands where the cursor clicked.
				const placed: EditOp =
					op.type === 'addNode' && !op.position ? { ...op, position: [Math.round(where().x - 80), Math.round(where().y - 28)] } : op;
				const result = this.controller.apply(placed, label);
				return result.ok ? null : result.message;
			}
		}
	}
}

/** Reads a document for planning without a controller (tests, previews). */
export function planDiagramEdits(source: string, place: DiagramPlacement, ops: readonly EditOp[], speed = 1): DiagramPerformanceStep[][] {
	let doc = parseMermaid(source);
	return ops.map((op, i) => {
		const steps = planDiagramEdit(doc, place, op, speed, ops[i + 1]);
		doc = applyEdits(doc, [op]);
		return steps;
	});
}
