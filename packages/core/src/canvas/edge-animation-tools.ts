/**
 * Agent tools for animated edges: `list_edge_animations`, `set_edge_animation` and
 * `clear_edge_animation`. They read and write `edge.data.animation` through the host's edges, and
 * each write is one undo step when a history is given.
 */

import type { Command } from '../history/types.js';
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import {
	CANVAS_EDGE_ANIMATION_KINDS,
	getCanvasEdgeAnimation,
	normalizeCanvasEdgeAnimation,
	resolveCanvasEdgeAnimation,
	setCanvasEdgeAnimation,
	type CanvasEdgeAnimation
} from './edgeAnimation.js';
/** The edge fields the tools read: React Flow and Svelte Flow edges fit as they are. */
export interface CanvasEdgeAnimationToolEdge {
	id: string;
	source: string;
	target: string;
	label?: unknown;
	data?: Record<string, any>;
}

export interface CanvasEdgeAnimationToolTarget<TEdge extends CanvasEdgeAnimationToolEdge = CanvasEdgeAnimationToolEdge> {
	/** The edges on the canvas now. */
	getEdges: () => readonly TEdge[];
	/**
	 * Replaces the edges with the result of `update(current)`. React's `setEdges` fits as is; in
	 * Svelte, `(update) => (edges = update(edges))`.
	 */
	setEdges: (update: (current: TEdge[]) => TEdge[]) => void;
	/** The canvas's undo history: each write is one step there. Without it, writes are not undoable. */
	history?: { execute(command: Command): void };
}

export interface CanvasEdgeAnimationToolProviderOptions {
	/** Provider id (unique per registry). Default `canvas-edge-animation`. */
	id?: string;
	/** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Edges cannot be changed: the write tools are hidden. A string is the reason. */
	readOnly?: boolean | string | (() => boolean | string);
	/** Lets the tool list follow changes. */
	subscribe?: (notify: () => void) => () => void;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const EDGE_IDS = {
	type: 'array',
	minItems: 1,
	uniqueItems: true,
	items: { type: 'string', minLength: 1 },
	description: 'Ids of the edges to change, from list_edge_animations. All of them change in one undo step.'
} as const;

/** JSON Schema of {@link CanvasEdgeAnimation}, for tools and commands. */
export const CANVAS_EDGE_ANIMATION_SCHEMA = {
	type: 'object',
	properties: {
		kind: {
			type: 'string',
			enum: CANVAS_EDGE_ANIMATION_KINDS.map((k) => k.kind),
			description: 'What moves: dots (travelling dots), dash (marching dashes), beam (a glowing streak that shoots along), pulse (the edge glows and fades).'
		},
		speed: { type: 'number', minimum: 1, maximum: 10000, description: 'Travel speed in canvas units per second (dots, dash, beam). Defaults: dots 80, dash 40, beam 200.' },
		duration: { type: 'number', minimum: 100, maximum: 600000, description: 'One cycle in ms; overrides speed. The pulse timing (default 1600).' },
		direction: { type: 'string', enum: ['forward', 'reverse', 'alternate'], description: 'forward = source to target (default), reverse = target to source, alternate = back and forth.' },
		color: { type: 'string', minLength: 1, description: 'CSS colour, e.g. "#38bdf8". Default: the edge stroke colour.' },
		size: { type: 'number', minimum: 0.5, maximum: 100, description: 'Dot radius, or stroke width of dashes, beams and the pulse, in canvas units. Defaults: dots 3, dash 2, beam 3, pulse 4.' },
		count: { type: 'integer', minimum: 1, maximum: 50, description: 'How many dots or beams are on the edge at once. Defaults: dots 3, beam 1.' },
		length: { type: 'number', minimum: 1, maximum: 10000, description: 'Dash or beam length in canvas units. Defaults: dash 8, beam 40.' },
		gap: { type: 'number', minimum: 0, maximum: 10000, description: 'Gap between dashes in canvas units (dash). Default 6.' },
		glow: { type: 'number', minimum: 0, maximum: 50, description: 'Glow (blur) radius in canvas units; 0 is none. Defaults: beam 4, pulse 3, others 0.' },
		trackOpacity: { type: 'number', minimum: 0, maximum: 1, description: "Opacity of the edge's own line under the animation, 0-1. Defaults: dash 0 (the dashes are the line), beam 0.35, others 1." },
		paused: { type: 'boolean', description: 'Hold the animation still at its first frame. Default false.' }
	},
	required: ['kind'],
	additionalProperties: false
} as const;

const labelOf = (edge: CanvasEdgeAnimationToolEdge): string | undefined => (typeof edge.label === 'string' && edge.label !== '' ? edge.label : undefined);

/** The edge animation tools for a canvas (see the module comment). */
export function createCanvasEdgeAnimationToolProvider<TEdge extends CanvasEdgeAnimationToolEdge = CanvasEdgeAnimationToolEdge>(
	target: CanvasEdgeAnimationToolTarget<TEdge>,
	options: CanvasEdgeAnimationToolProviderOptions = {}
): AgentToolProvider {
	const readOnlyReason = (): string | null => {
		const ro = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		return ro ? (typeof ro === 'string' ? ro : 'Edges are read-only on this canvas.') : null;
	};
	const checkIds = (ids: readonly string[]): void => {
		const known = new Set(target.getEdges().map((e) => e.id));
		const missing = ids.filter((id) => !known.has(id));
		if (missing.length) {
			throw new Error(`No edge${missing.length > 1 ? 's' : ''} ${missing.map((id) => `"${id}"`).join(', ')} on the canvas. Call list_edge_animations for edge ids.`);
		}
	};
	/** Sets each edge's animation (null removes it) as one undo step; returns the previous ones. */
	const apply = (label: string, next: Map<string, CanvasEdgeAnimation | null>) => {
		const before = new Map<string, CanvasEdgeAnimation | null>();
		for (const edge of target.getEdges()) if (next.has(edge.id)) before.set(edge.id, getCanvasEdgeAnimation(edge));
		const write = (values: Map<string, CanvasEdgeAnimation | null>) => () =>
			target.setEdges((current) => current.map((edge) => (values.has(edge.id) ? setCanvasEdgeAnimation(edge, values.get(edge.id) ?? null) : edge)));
		if (target.history) target.history.execute({ name: label, execute: write(next), undo: write(before) });
		else write(next)();
	};

	const listTool: AgentTool = {
		name: 'list_edge_animations',
		title: 'List edge animations',
		description:
			'Lists the canvas edges (id, source, target, label, animation or null) and the animation kinds with their defaults, plus the readOnly reason if edges cannot change. Call it before set_edge_animation or clear_edge_animation: it is the source of edge ids.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'List edge animations', ...READ },
		handler: () => ({
			edges: target.getEdges().map((e) => ({
				id: e.id,
				source: e.source,
				target: e.target,
				...(labelOf(e) ? { label: labelOf(e) } : {}),
				animation: getCanvasEdgeAnimation(e)
			})),
			kinds: CANVAS_EDGE_ANIMATION_KINDS.map((k) => ({ kind: k.kind, title: k.title, description: k.description, defaults: k.defaults })),
			readOnly: readOnlyReason()
		})
	};

	const setTool: AgentTool = {
		name: 'set_edge_animation',
		title: 'Animate edges',
		description:
			'Sets the animation of one or more edges (replacing any they had): travelling dots, marching dashes, a beam or a pulse, with optional speed, direction, colour, size, count, length, glow and track opacity. Fields left out use the kind\'s defaults. One undo step. Returns the edge ids and the animation as it will play, with every default filled in.',
		inputSchema: {
			type: 'object',
			properties: { edges: EDGE_IDS, animation: { ...CANVAS_EDGE_ANIMATION_SCHEMA, description: 'The animation. Only kind is required.' } },
			required: ['edges', 'animation'],
			additionalProperties: false
		},
		annotations: { title: 'Animate edges', ...WRITE_IDEMPOTENT },
		handler: (args) => {
			const reason = readOnlyReason();
			if (reason) throw new Error(reason);
			const ids: string[] = args.edges;
			checkIds(ids);
			const animation = normalizeCanvasEdgeAnimation(args.animation);
			apply(ids.length === 1 ? 'Animate edge' : `Animate ${ids.length} edges`, new Map(ids.map((id) => [id, animation])));
			return { edges: ids, animation, resolved: resolveCanvasEdgeAnimation(animation) };
		}
	};

	const clearTool: AgentTool = {
		name: 'clear_edge_animation',
		title: 'Stop edge animations',
		description:
			'Removes the animation from one or more edges, leaving the plain edge. Edges without one are left alone. One undo step. Returns the ids cleared and those that had no animation.',
		inputSchema: { type: 'object', properties: { edges: EDGE_IDS }, required: ['edges'], additionalProperties: false },
		annotations: { title: 'Stop edge animations', ...WRITE_IDEMPOTENT },
		handler: (args) => {
			const reason = readOnlyReason();
			if (reason) throw new Error(reason);
			const ids: string[] = args.edges;
			checkIds(ids);
			const animated = new Set(target.getEdges().filter((e) => getCanvasEdgeAnimation(e) || e.data?.animation !== undefined).map((e) => e.id));
			const cleared = ids.filter((id) => animated.has(id));
			if (cleared.length) apply(cleared.length === 1 ? 'Stop edge animation' : `Stop ${cleared.length} edge animations`, new Map(cleared.map((id) => [id, null])));
			return { cleared, unchanged: ids.filter((id) => !animated.has(id)) };
		}
	};

	return {
		id: options.id ?? 'canvas-edge-animation',
		namespace: options.namespace,
		title: 'Canvas edge animation',
		description: 'Animate canvas edges with travelling dots, marching dashes, beams or a pulse.',
		skill: 'pixerate-canvas',
		tools: () => (readOnlyReason() ? [listTool] : [listTool, setTool, clearTool]),
		subscribe: options.subscribe
	};
}
