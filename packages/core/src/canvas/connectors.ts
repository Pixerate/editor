import { centre } from './layout.js';
import type { Position, Rect, Side, XYPosition } from './types.js';

/**
 * Connection line styles supported by both SvelteFlow and React Flow
 * (`connectionLineType` / edge `type`).
 */
export type CanvasConnectionLineType = 'default' | 'straight' | 'step' | 'smoothstep' | 'simplebezier';

export const CONNECTION_LINE_TYPES: readonly CanvasConnectionLineType[] = [
	'default',
	'straight',
	'step',
	'smoothstep',
	'simplebezier'
];

/** Maps a handle `Position` to the placement `Side` vocabulary used by `placeBeside`. */
export function positionToSide(position: Position): Side {
	switch (position) {
		case 'top':
			return 'above';
		case 'bottom':
			return 'below';
		default:
			return position;
	}
}

/** Maps a placement `Side` to the handle `Position` vocabulary used by xyflow. */
export function sideToPosition(side: Side): Position {
	switch (side) {
		case 'above':
			return 'top';
		case 'below':
			return 'bottom';
		default:
			return side;
	}
}

/** The handle position facing the other way. */
export function oppositePosition(position: Position): Position {
	switch (position) {
		case 'top':
			return 'bottom';
		case 'bottom':
			return 'top';
		case 'left':
			return 'right';
		default:
			return 'left';
	}
}

/** Midpoint of a rectangle's side, where a centred handle sits. */
export function handlePoint(rect: Rect, position: Position): XYPosition {
	switch (position) {
		case 'top':
			return { x: rect.x + rect.width / 2, y: rect.y };
		case 'bottom':
			return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
		case 'left':
			return { x: rect.x, y: rect.y + rect.height / 2 };
		default:
			return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
	}
}

export interface ConnectorSnapTarget {
	id: string;
	rect: Rect;
	/** Sides that can accept a connection (default: all four). */
	positions?: Position[];
}

export interface ConnectorSnapOptions {
	/** Viewport zoom; `radius` is in screen pixels and divided by it (default 1). */
	zoom?: number;
	/** How far outside a shape the pointer may be and still attach, in screen pixels (default 24). */
	radius?: number;
	/** Node ids that cannot be attached to, e.g. the connection's source node. */
	excludeIds?: Iterable<string>;
	/**
	 * `handle` snaps to the side's midpoint (a centred handle, default). `edge` snaps to the
	 * closest point along that side, for floating edges.
	 */
	mode?: 'handle' | 'edge';
}

export interface ConnectorSnap {
	nodeId: string;
	position: Position;
	side: Side;
	/** Attachment point in flow coordinates. */
	point: XYPosition;
	/** Distance from the pointer to `point`, in flow units. */
	distance: number;
}

/**
 * Finds the shape side a connection line should attach to for a pointer (flow coordinates).
 * Shapes the pointer is inside win over shapes it is merely near; among those, the closest
 * allowed side wins. Returns `null` when nothing is within `radius`.
 */
export function findConnectorSnap(
	pointer: XYPosition,
	targets: ConnectorSnapTarget[],
	options: ConnectorSnapOptions = {}
): ConnectorSnap | null {
	const zoom = options.zoom && options.zoom > 0 ? options.zoom : 1;
	const radius = (options.radius ?? 24) / zoom;
	const exclude = new Set(options.excludeIds ?? []);
	const all: Position[] = ['top', 'right', 'bottom', 'left'];

	let best: (ConnectorSnap & { inside: boolean; rank: number }) | null = null;
	for (const target of targets) {
		if (exclude.has(target.id)) continue;
		const { rect } = target;
		// Cheap rejection: pointer outside the rect grown by the radius.
		if (
			pointer.x < rect.x - radius ||
			pointer.x > rect.x + rect.width + radius ||
			pointer.y < rect.y - radius ||
			pointer.y > rect.y + rect.height + radius
		) {
			continue;
		}
		const inside =
			pointer.x >= rect.x &&
			pointer.x <= rect.x + rect.width &&
			pointer.y >= rect.y &&
			pointer.y <= rect.y + rect.height;

		for (const position of target.positions ?? all) {
			const point =
				options.mode === 'edge' ? closestPointOnSide(rect, position, pointer) : handlePoint(rect, position);
			// Rank sides by distance from the pointer to the side line, so a pointer near the
			// middle of a wide shape attaches to the side it is closest to.
			const sidePoint = closestPointOnSide(rect, position, pointer);
			const rank = Math.hypot(pointer.x - sidePoint.x, pointer.y - sidePoint.y);
			const distance = Math.hypot(pointer.x - point.x, pointer.y - point.y);
			if (!inside && rank > radius) continue;
			const better =
				!best ||
				(inside && !best.inside) ||
				(inside === best.inside && rank < best.rank);
			if (better) {
				best = { nodeId: target.id, position, side: positionToSide(position), point, distance, inside, rank };
			}
		}
	}
	if (!best) return null;
	const { inside: _inside, rank: _rank, ...snap } = best;
	return snap;
}

function closestPointOnSide(rect: Rect, position: Position, p: XYPosition): XYPosition {
	const clampX = Math.min(rect.x + rect.width, Math.max(rect.x, p.x));
	const clampY = Math.min(rect.y + rect.height, Math.max(rect.y, p.y));
	switch (position) {
		case 'top':
			return { x: clampX, y: rect.y };
		case 'bottom':
			return { x: clampX, y: rect.y + rect.height };
		case 'left':
			return { x: rect.x, y: clampY };
		default:
			return { x: rect.x + rect.width, y: clampY };
	}
}

/**
 * Picks the facing sides for a connection between two shapes, the way Freeform attaches
 * connection lines: along the axis with the larger centre offset.
 */
export function nearestHandlePositions(
	source: Rect,
	target: Rect
): { source: Position; target: Position } {
	const a = centre(source);
	const b = centre(target);
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	if (Math.abs(dx) >= Math.abs(dy)) {
		return dx >= 0 ? { source: 'right', target: 'left' } : { source: 'left', target: 'right' };
	}
	return dy >= 0 ? { source: 'bottom', target: 'top' } : { source: 'top', target: 'bottom' };
}
