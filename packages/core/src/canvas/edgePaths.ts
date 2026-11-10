/**
 * Edge path geometry for canvas edges, matching xyflow's (`getBezierPath`, `getStraightPath`,
 * `getSimpleBezierPath`, `getSmoothStepPath`) so the same path is drawn with or without React Flow /
 * Svelte Flow, plus a small SVG path measurer (`measureSvgPath`) for placing things along a path.
 * No DOM and no xyflow import.
 */

import type { CanvasConnectionLineType } from './connectors.js';
import type { Position, XYPosition } from './types.js';

export interface CanvasEdgePathParams {
	sourceX: number;
	sourceY: number;
	targetX: number;
	targetY: number;
	/** Side of the source node the edge leaves from. Default `bottom`. */
	sourcePosition?: Position;
	/** Side of the target node the edge enters. Default `top`. */
	targetPosition?: Position;
	/** Path style, as xyflow's edge `type`. Default `default` (bézier). */
	type?: CanvasConnectionLineType;
	/** Bézier curvature (`default`). Default 0.25. */
	curvature?: number;
	/** Corner radius for `smoothstep`, in canvas units. Default 5 (`step` is 0). */
	borderRadius?: number;
	/** Distance the step paths run straight out of a handle before turning, in canvas units. Default 20. */
	offset?: number;
}

export interface CanvasEdgePath {
	/** SVG path data. */
	path: string;
	/** Where a label sits (xyflow's `labelX` / `labelY`). */
	labelX: number;
	labelY: number;
}

const DIRECTIONS: Record<Position, XYPosition> = {
	left: { x: -1, y: 0 },
	right: { x: 1, y: 0 },
	top: { x: 0, y: -1 },
	bottom: { x: 0, y: 1 }
};

function controlOffset(distance: number, curvature: number): number {
	return distance >= 0 ? 0.5 * distance : curvature * 25 * Math.sqrt(-distance);
}

function curvatureControl(pos: Position, x1: number, y1: number, x2: number, y2: number, c: number): [number, number] {
	switch (pos) {
		case 'left':
			return [x1 - controlOffset(x1 - x2, c), y1];
		case 'right':
			return [x1 + controlOffset(x2 - x1, c), y1];
		case 'top':
			return [x1, y1 - controlOffset(y1 - y2, c)];
		default:
			return [x1, y1 + controlOffset(y2 - y1, c)];
	}
}

function simpleControl(pos: Position, x1: number, y1: number, x2: number, y2: number): [number, number] {
	return pos === 'left' || pos === 'right' ? [0.5 * (x1 + x2), y1] : [x1, 0.5 * (y1 + y2)];
}

function cubicPath(p: CanvasEdgePathParams, s: [number, number], t: [number, number]): CanvasEdgePath {
	const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty } = p;
	return {
		path: `M${sx},${sy} C${s[0]},${s[1]} ${t[0]},${t[1]} ${tx},${ty}`,
		labelX: sx * 0.125 + s[0] * 0.375 + t[0] * 0.375 + tx * 0.125,
		labelY: sy * 0.125 + s[1] * 0.375 + t[1] * 0.375 + ty * 0.125
	};
}

function edgeCenter(sx: number, sy: number, tx: number, ty: number): [number, number] {
	const xOffset = Math.abs(tx - sx) / 2;
	const yOffset = Math.abs(ty - sy) / 2;
	return [tx < sx ? tx + xOffset : tx - xOffset, ty < sy ? ty + yOffset : ty - yOffset];
}

const dist = (a: XYPosition, b: XYPosition) => Math.hypot(b.x - a.x, b.y - a.y);

function stepPoints(source: XYPosition, sourcePosition: Position, target: XYPosition, targetPosition: Position, offset: number): [XYPosition[], number, number] {
	const sourceDir = DIRECTIONS[sourcePosition];
	const targetDir = DIRECTIONS[targetPosition];
	const sourceGapped = { x: source.x + sourceDir.x * offset, y: source.y + sourceDir.y * offset };
	const targetGapped = { x: target.x + targetDir.x * offset, y: target.y + targetDir.y * offset };
	const dir =
		sourcePosition === 'left' || sourcePosition === 'right'
			? { x: sourceGapped.x < targetGapped.x ? 1 : -1, y: 0 }
			: { x: 0, y: sourceGapped.y < targetGapped.y ? 1 : -1 };
	const axis: 'x' | 'y' = dir.x !== 0 ? 'x' : 'y';
	const currDir = dir[axis];
	let points: XYPosition[];
	let centerX: number;
	let centerY: number;
	const sourceGapOffset = { x: 0, y: 0 };
	const targetGapOffset = { x: 0, y: 0 };
	if (sourceDir[axis] * targetDir[axis] === -1) {
		centerX = (sourceGapped.x + targetGapped.x) / 2;
		centerY = (sourceGapped.y + targetGapped.y) / 2;
		const verticalSplit = [{ x: centerX, y: sourceGapped.y }, { x: centerX, y: targetGapped.y }];
		const horizontalSplit = [{ x: sourceGapped.x, y: centerY }, { x: targetGapped.x, y: centerY }];
		points = sourceDir[axis] === currDir ? (axis === 'x' ? verticalSplit : horizontalSplit) : axis === 'x' ? horizontalSplit : verticalSplit;
	} else {
		const sourceTarget = [{ x: sourceGapped.x, y: targetGapped.y }];
		const targetSource = [{ x: targetGapped.x, y: sourceGapped.y }];
		points = axis === 'x' ? (sourceDir.x === currDir ? targetSource : sourceTarget) : sourceDir.y === currDir ? sourceTarget : targetSource;
		if (sourcePosition === targetPosition) {
			const diff = Math.abs(source[axis] - target[axis]);
			if (diff <= offset) {
				const gapOffset = Math.min(offset - 1, offset - diff);
				if (sourceDir[axis] === currDir) sourceGapOffset[axis] = (sourceGapped[axis] > source[axis] ? -1 : 1) * gapOffset;
				else targetGapOffset[axis] = (targetGapped[axis] > target[axis] ? -1 : 1) * gapOffset;
			}
		} else {
			const opposite: 'x' | 'y' = axis === 'x' ? 'y' : 'x';
			const isSameDir = sourceDir[axis] === targetDir[opposite];
			const sourceGt = sourceGapped[opposite] > targetGapped[opposite];
			const sourceLt = sourceGapped[opposite] < targetGapped[opposite];
			const flip =
				(sourceDir[axis] === 1 && ((!isSameDir && sourceGt) || (isSameDir && sourceLt))) ||
				(sourceDir[axis] !== 1 && ((!isSameDir && sourceLt) || (isSameDir && sourceGt)));
			if (flip) points = axis === 'x' ? sourceTarget : targetSource;
		}
		const sourceGapPoint = { x: sourceGapped.x + sourceGapOffset.x, y: sourceGapped.y + sourceGapOffset.y };
		const targetGapPoint = { x: targetGapped.x + targetGapOffset.x, y: targetGapped.y + targetGapOffset.y };
		const maxX = Math.max(Math.abs(sourceGapPoint.x - points[0].x), Math.abs(targetGapPoint.x - points[0].x));
		const maxY = Math.max(Math.abs(sourceGapPoint.y - points[0].y), Math.abs(targetGapPoint.y - points[0].y));
		if (maxX >= maxY) {
			centerX = (sourceGapPoint.x + targetGapPoint.x) / 2;
			centerY = points[0].y;
		} else {
			centerX = points[0].x;
			centerY = (sourceGapPoint.y + targetGapPoint.y) / 2;
		}
	}
	const gappedSource = { x: sourceGapped.x + sourceGapOffset.x, y: sourceGapped.y + sourceGapOffset.y };
	const gappedTarget = { x: targetGapped.x + targetGapOffset.x, y: targetGapped.y + targetGapOffset.y };
	const first = points[0];
	const last = points[points.length - 1];
	const path = [
		source,
		...(gappedSource.x !== first.x || gappedSource.y !== first.y ? [gappedSource] : []),
		...points,
		...(gappedTarget.x !== last.x || gappedTarget.y !== last.y ? [gappedTarget] : []),
		target
	];
	return [path, centerX, centerY];
}

function bend(a: XYPosition, b: XYPosition, c: XYPosition, size: number): string {
	const bendSize = Math.min(dist(a, b) / 2, dist(b, c) / 2, size);
	const { x, y } = b;
	if ((a.x === x && x === c.x) || (a.y === y && y === c.y)) return `L${x} ${y}`;
	if (a.y === y) {
		const xDir = a.x < c.x ? -1 : 1;
		const yDir = a.y < c.y ? 1 : -1;
		return `L ${x + bendSize * xDir},${y}Q ${x},${y} ${x},${y + bendSize * yDir}`;
	}
	const xDir = a.x < c.x ? 1 : -1;
	const yDir = a.y < c.y ? -1 : 1;
	return `L ${x},${y + bendSize * yDir}Q ${x},${y} ${x + bendSize * xDir},${y}`;
}

/**
 * The SVG path of a canvas edge, the same as xyflow draws for that edge `type` (`default` bézier,
 * `straight`, `step`, `smoothstep`, `simplebezier`), with the label position.
 */
export function getCanvasEdgePath(params: CanvasEdgePathParams): CanvasEdgePath {
	const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty } = params;
	const sourcePosition = params.sourcePosition ?? 'bottom';
	const targetPosition = params.targetPosition ?? 'top';
	switch (params.type ?? 'default') {
		case 'straight': {
			const [labelX, labelY] = edgeCenter(sx, sy, tx, ty);
			return { path: `M ${sx},${sy}L ${tx},${ty}`, labelX, labelY };
		}
		case 'simplebezier':
			return cubicPath(params, simpleControl(sourcePosition, sx, sy, tx, ty), simpleControl(targetPosition, tx, ty, sx, sy));
		case 'step':
		case 'smoothstep': {
			const radius = params.type === 'step' ? 0 : params.borderRadius ?? 5;
			const [points, labelX, labelY] = stepPoints({ x: sx, y: sy }, sourcePosition, { x: tx, y: ty }, targetPosition, params.offset ?? 20);
			let path = '';
			points.forEach((p, i) => {
				path += i > 0 && i < points.length - 1 ? bend(points[i - 1], p, points[i + 1], radius) : `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`;
			});
			return { path, labelX, labelY };
		}
		default: {
			const c = params.curvature ?? 0.25;
			return cubicPath(params, curvatureControl(sourcePosition, sx, sy, tx, ty, c), curvatureControl(targetPosition, tx, ty, sx, sy, c));
		}
	}
}

/** A point on a path with the direction of travel there (radians, 0 = +x). */
export interface SvgPathPoint {
	x: number;
	y: number;
	angle: number;
}

export interface MeasuredSvgPath {
	/** Total length in path units. */
	length: number;
	/** Bounding box of the flattened path. */
	bounds: { x: number; y: number; width: number; height: number };
	/** The point `distance` along the path (clamped to [0, length]). */
	pointAt(distance: number): SvgPathPoint;
}

/**
 * Measures SVG path data (M, L, H, V, C, S, Q, T, Z, absolute or relative; arcs are drawn as
 * straight lines). Curves are flattened to `segments` pieces each (default 24), which is well under
 * a canvas unit of error for edge-sized curves.
 */
export function measureSvgPath(d: string, segments = 24): MeasuredSvgPath {
	const pts: XYPosition[] = [];
	const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
	let i = 0;
	let cmd = '';
	let cur = { x: 0, y: 0 };
	let start = { x: 0, y: 0 };
	let lastCtrl: XYPosition | null = null;
	let lastCmd = '';
	const num = () => Number(tokens[i++]);
	const push = (p: XYPosition) => {
		pts.push(p);
		cur = p;
	};
	const cubic = (c1: XYPosition, c2: XYPosition, end: XYPosition) => {
		const p0 = cur;
		for (let k = 1; k <= segments; k++) {
			const t = k / segments;
			const u = 1 - t;
			push({
				x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x,
				y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y
			});
		}
	};
	const quad = (c: XYPosition, end: XYPosition) => {
		const p0 = cur;
		for (let k = 1; k <= segments; k++) {
			const t = k / segments;
			const u = 1 - t;
			push({ x: u * u * p0.x + 2 * u * t * c.x + t * t * end.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * end.y });
		}
	};
	while (i < tokens.length) {
		if (/^[a-zA-Z]$/.test(tokens[i])) cmd = tokens[i++];
		else if (!cmd) break;
		const rel = cmd === cmd.toLowerCase();
		const at = (x: number, y: number) => (rel ? { x: cur.x + x, y: cur.y + y } : { x, y });
		switch (cmd.toUpperCase()) {
			case 'M': {
				const p = at(num(), num());
				push(p);
				start = p;
				cmd = rel ? 'l' : 'L';
				lastCtrl = null;
				lastCmd = 'M';
				continue;
			}
			case 'L':
				push(at(num(), num()));
				lastCtrl = null;
				break;
			case 'H': {
				const x = num();
				push({ x: rel ? cur.x + x : x, y: cur.y });
				lastCtrl = null;
				break;
			}
			case 'V': {
				const y = num();
				push({ x: cur.x, y: rel ? cur.y + y : y });
				lastCtrl = null;
				break;
			}
			case 'C': {
				const c1 = at(num(), num());
				const c2 = at(num(), num());
				const end = at(num(), num());
				cubic(c1, c2, end);
				lastCtrl = c2;
				break;
			}
			case 'S': {
				const c1: XYPosition = lastCtrl && /[CS]/i.test(lastCmd) ? { x: 2 * cur.x - lastCtrl.x, y: 2 * cur.y - lastCtrl.y } : cur;
				const c2 = at(num(), num());
				const end = at(num(), num());
				cubic(c1, c2, end);
				lastCtrl = c2;
				break;
			}
			case 'Q': {
				const c = at(num(), num());
				const end = at(num(), num());
				quad(c, end);
				lastCtrl = c;
				break;
			}
			case 'T': {
				const c: XYPosition = lastCtrl && /[QT]/i.test(lastCmd) ? { x: 2 * cur.x - lastCtrl.x, y: 2 * cur.y - lastCtrl.y } : cur;
				const end = at(num(), num());
				quad(c, end);
				lastCtrl = c;
				break;
			}
			case 'A': {
				for (let skip = 0; skip < 5; skip++) num();
				push(at(num(), num()));
				lastCtrl = null;
				break;
			}
			case 'Z':
				push(start);
				lastCtrl = null;
				break;
			default:
				i = tokens.length;
		}
		lastCmd = cmd;
		if (cmd.toUpperCase() === 'Z') cmd = '';
	}
	const cumulative: number[] = [0];
	for (let k = 1; k < pts.length; k++) cumulative.push(cumulative[k - 1] + dist(pts[k - 1], pts[k]));
	const length = cumulative[cumulative.length - 1] ?? 0;
	const angleAt = (k: number): number => {
		// Direction of the first non-zero piece at or around k.
		for (let j = Math.max(1, k); j < pts.length; j++) {
			if (cumulative[j] > cumulative[j - 1]) return Math.atan2(pts[j].y - pts[j - 1].y, pts[j].x - pts[j - 1].x);
		}
		for (let j = Math.min(k, pts.length - 1); j >= 1; j--) {
			if (cumulative[j] > cumulative[j - 1]) return Math.atan2(pts[j].y - pts[j - 1].y, pts[j].x - pts[j - 1].x);
		}
		return 0;
	};
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const p of pts) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	const bounds = pts.length ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : { x: 0, y: 0, width: 0, height: 0 };
	return {
		length,
		bounds,
		pointAt(distance: number): SvgPathPoint {
			if (pts.length === 0) return { x: 0, y: 0, angle: 0 };
			if (pts.length === 1 || length === 0) return { ...pts[0], angle: 0 };
			const s = Math.min(Math.max(distance, 0), length);
			let lo = 1;
			let hi = pts.length - 1;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (cumulative[mid] < s) lo = mid + 1;
				else hi = mid;
			}
			const piece = cumulative[lo] - cumulative[lo - 1];
			const t = piece > 0 ? (s - cumulative[lo - 1]) / piece : 0;
			const a = pts[lo - 1];
			const b = pts[lo];
			return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: angleAt(lo) };
		}
	};
}
