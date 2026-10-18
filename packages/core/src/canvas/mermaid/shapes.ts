// Ported from Ursula's ShapeSvg (src/react/nodes/ShapeSvg.tsx), as path data so the React
// and Svelte nodes draw the same geometry.

/**
 * How a path is painted: `shape` with the node's fill and border, `line` with the border
 * only, `filled` solid in the border colour (state start / end dots, fork bars), `hidden`
 * not at all (text nodes keep a hit area).
 */
export type MermaidShapePaint = 'shape' | 'line' | 'filled' | 'hidden';

export interface MermaidShapePath {
	d: string;
	paint: MermaidShapePaint;
}

type Pt = [number, number];

const n = (v: number) => Math.round(v * 100) / 100;
const poly = (points: Pt[]) => `M${points.map(([x, y]) => `${n(x)},${n(y)}`).join(' L')} Z`;
const rect = (x: number, y: number, w: number, h: number, r = 0) => {
	if (r <= 0) return poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
	const rr = Math.min(r, w / 2, h / 2);
	return `M${n(x + rr)},${n(y)} H${n(x + w - rr)} A${n(rr)},${n(rr)} 0 0 1 ${n(x + w)},${n(y + rr)} V${n(y + h - rr)} A${n(rr)},${n(rr)} 0 0 1 ${n(x + w - rr)},${n(y + h)} H${n(x + rr)} A${n(rr)},${n(rr)} 0 0 1 ${n(x)},${n(y + h - rr)} V${n(y + rr)} A${n(rr)},${n(rr)} 0 0 1 ${n(x + rr)},${n(y)} Z`;
};
const ellipse = (cx: number, cy: number, rx: number, ry: number) =>
	`M${n(cx - rx)},${n(cy)} A${n(rx)},${n(ry)} 0 1 0 ${n(cx + rx)},${n(cy)} A${n(rx)},${n(ry)} 0 1 0 ${n(cx - rx)},${n(cy)} Z`;
const line = (x1: number, y1: number, x2: number, y2: number) => `M${n(x1)},${n(y1)} L${n(x2)},${n(y2)}`;

/**
 * Draws a Mermaid flowchart / state / class / ER shape (canonical names, see
 * `FLOWCHART_SHAPES` and `STATE_SHAPES`) as SVG paths that fill a `width × height`
 * box, inset by `inset` so strokes are not clipped. Unknown shapes draw a rectangle.
 */
export function mermaidShapePaths(shape: string, width: number, height: number, inset = 1): MermaidShapePath[] {
	const s = inset;
	const W = Math.max(0, width - 2 * s);
	const H = Math.max(0, height - 2 * s);
	const x0 = s;
	const y0 = s;
	const x1 = width - s;
	const y1 = height - s;
	const cx = width / 2;
	const cy = height / 2;
	const fill = (d: string): MermaidShapePath => ({ d, paint: 'shape' });
	const stroke = (d: string): MermaidShapePath => ({ d, paint: 'line' });
	const solid = (d: string): MermaidShapePath => ({ d, paint: 'filled' });
	switch (shape) {
		case 'rounded':
		case 'event':
			return [fill(rect(x0, y0, W, H, Math.min(10, H / 4)))];
		case 'stadium':
			return [fill(rect(x0, y0, W, H, H / 2))];
		case 'subproc':
		case 'subroutine': {
			const i = Math.min(10, W / 8);
			return [fill(rect(x0, y0, W, H)), stroke(line(x0 + i, y0, x0 + i, y1)), stroke(line(x1 - i, y0, x1 - i, y1))];
		}
		case 'cyl':
		case 'cylinder': {
			const ry = Math.min(H / 6, 14);
			return [
				fill(`M${n(x0)},${n(y0 + ry)} A${n(W / 2)},${n(ry)} 0 0 1 ${n(x1)},${n(y0 + ry)} L${n(x1)},${n(y1 - ry)} A${n(W / 2)},${n(ry)} 0 0 1 ${n(x0)},${n(y1 - ry)} Z`),
				stroke(`M${n(x0)},${n(y0 + ry)} A${n(W / 2)},${n(ry)} 0 0 0 ${n(x1)},${n(y0 + ry)}`)
			];
		}
		case 'h-cyl':
		case 'lin-cyl': {
			const rx = Math.min(W / 6, 14);
			const paths = [
				fill(`M${n(x0 + rx)},${n(y0)} L${n(x1 - rx)},${n(y0)} A${n(rx)},${n(H / 2)} 0 0 1 ${n(x1 - rx)},${n(y1)} L${n(x0 + rx)},${n(y1)} A${n(rx)},${n(H / 2)} 0 0 1 ${n(x0 + rx)},${n(y0)} Z`),
				stroke(ellipse(x1 - rx, cy, rx, H / 2))
			];
			if (shape === 'lin-cyl') paths.push(stroke(line(x0 + rx * 2, y0, x0 + rx * 2, y1)));
			return paths;
		}
		case 'circle':
		case 'circ':
			return [fill(ellipse(cx, cy, W / 2, H / 2))];
		case 'dbl-circ':
			return [fill(ellipse(cx, cy, W / 2, H / 2)), stroke(ellipse(cx, cy, Math.max(0, W / 2 - 5), Math.max(0, H / 2 - 5)))];
		case 'sm-circ':
		case 'f-circ':
		case 'stateStart':
			return [solid(ellipse(cx, cy, W / 2, H / 2))];
		case 'fr-circ':
		case 'stateEnd':
			return [fill(ellipse(cx, cy, W / 2, H / 2)), solid(ellipse(cx, cy, Math.max(0, W / 2 - 5), Math.max(0, H / 2 - 5)))];
		case 'cross-circ':
			return [
				fill(ellipse(cx, cy, W / 2, H / 2)),
				stroke(line(cx - W / 2.83, cy - H / 2.83, cx + W / 2.83, cy + H / 2.83)),
				stroke(line(cx + W / 2.83, cy - H / 2.83, cx - W / 2.83, cy + H / 2.83))
			];
		case 'odd':
		case 'asymmetric': {
			const d = Math.min(H / 2, 20);
			return [fill(poly([[x0 + d, y0], [x1, y0], [x1, y1], [x0 + d, y1], [x0, cy]]))];
		}
		case 'diam':
		case 'diamond':
		case 'choice':
			return [fill(poly([[cx, y0], [x1, cy], [cx, y1], [x0, cy]]))];
		case 'hex':
		case 'hexagon': {
			const d = Math.min(W / 5, H / 2);
			return [fill(poly([[x0 + d, y0], [x1 - d, y0], [x1, cy], [x1 - d, y1], [x0 + d, y1], [x0, cy]]))];
		}
		case 'lean-r': {
			const d = Math.min(W / 5, H / 2);
			return [fill(poly([[x0 + d, y0], [x1, y0], [x1 - d, y1], [x0, y1]]))];
		}
		case 'lean-l': {
			const d = Math.min(W / 5, H / 2);
			return [fill(poly([[x0, y0], [x1 - d, y0], [x1, y1], [x0 + d, y1]]))];
		}
		case 'trap-b': {
			const d = Math.min(W / 5, H / 2);
			return [fill(poly([[x0 + d, y0], [x1 - d, y0], [x1, y1], [x0, y1]]))];
		}
		case 'trap-t': {
			const d = Math.min(W / 5, H / 2);
			return [fill(poly([[x0, y0], [x1, y0], [x1 - d, y1], [x0 + d, y1]]))];
		}
		case 'text':
		case 'anchor':
			return [{ d: rect(x0, y0, W, H), paint: 'hidden' }];
		case 'card':
		case 'notch-rect': {
			const d = Math.min(14, H / 3);
			return [fill(poly([[x0 + d, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0 + d]]))];
		}
		case 'lin-rect':
		case 'shaded-process':
			return [fill(rect(x0, y0, W, H)), stroke(line(x0 + 8, y0, x0 + 8, y1))];
		case 'fork':
		case 'join':
			return [solid(rect(x0, y0, W, H, 2))];
		case 'hourglass':
			return [fill(poly([[x0, y0], [x1, y0], [x0, y1], [x1, y1]]))];
		case 'bolt':
			return [fill(poly([[cx + W * 0.1, y0], [x0 + W * 0.25, cy + 4], [cx, cy + 4], [cx - W * 0.1, y1], [x1 - W * 0.25, cy - 4], [cx, cy - 4]]))];
		case 'doc':
		case 'lin-doc':
		case 'tag-doc': {
			const wave = Math.min(12, H / 5);
			const paths = [fill(`M${n(x0)},${n(y0)} L${n(x1)},${n(y0)} L${n(x1)},${n(y1 - wave)} Q${n(x1 - W / 4)},${n(y1 - wave * 2.2)} ${n(cx)},${n(y1 - wave)} T${n(x0)},${n(y1 - wave)} Z`)];
			if (shape === 'lin-doc') paths.push(stroke(line(x0 + 8, y0, x0 + 8, y1 - wave)));
			if (shape === 'tag-doc') paths.push(stroke(line(x1 - 12, y1 - wave * 1.6, x1, y1 - wave * 2.6)));
			return paths;
		}
		case 'docs': {
			const wave = Math.min(10, H / 6);
			const page = (dx: number, dy: number, inner: number) =>
				fill(`M${n(x0 + dx)},${n(y0 + dy)} L${n(x1 - inner)},${n(y0 + dy)} L${n(x1 - inner)},${n(y1 - wave - (12 - dy))} Q${n(x1 - W / 4 - inner)},${n(y1 - wave * 2.2 - (12 - dy))} ${n(cx + 6 - dy)},${n(y1 - wave - (12 - dy))} T${n(x0 + dx)},${n(y1 - wave - (12 - dy))} Z`);
			return [page(12, 0, 0), page(6, 6, 6), page(0, 12, 12)];
		}
		case 'delay':
			return [fill(`M${n(x0)},${n(y0)} L${n(x1 - H / 2)},${n(y0)} A${n(H / 2)},${n(H / 2)} 0 0 1 ${n(x1 - H / 2)},${n(y1)} L${n(x0)},${n(y1)} Z`)];
		case 'curv-trap': {
			const d = Math.min(W / 6, H / 3);
			return [fill(`M${n(x0 + d)},${n(y0)} L${n(x1 - d)},${n(y0)} Q${n(x1)},${n(y0)} ${n(x1)},${n(cy)} Q${n(x1)},${n(y1)} ${n(x1 - d)},${n(y1)} L${n(x0 + d)},${n(y1)} L${n(x0)},${n(cy)} Z`)];
		}
		case 'div-rect': {
			const d = Math.min(24, H / 3);
			return [fill(rect(x0, y0, W, H)), stroke(line(x0, y0 + d, x1, y0 + d))];
		}
		case 'tri':
			return [fill(poly([[cx, y0], [x1, y1], [x0, y1]]))];
		case 'flip-tri':
			return [fill(poly([[x0, y0], [x1, y0], [cx, y1]]))];
		case 'win-pane':
			return [fill(rect(x0, y0, W, H)), stroke(line(x0 + 10, y0, x0 + 10, y1)), stroke(line(x0, y0 + 10, x1, y0 + 10))];
		case 'flag': {
			const wave = Math.min(10, H / 5);
			return [fill(`M${n(x0)},${n(y0 + wave)} Q${n(x0 + W / 4)},${n(y0 - wave)} ${n(cx)},${n(y0 + wave)} T${n(x1)},${n(y0 + wave)} L${n(x1)},${n(y1 - wave)} Q${n(x1 - W / 4)},${n(y1 + wave)} ${n(cx)},${n(y1 - wave)} T${n(x0)},${n(y1 - wave)} Z`)];
		}
		case 'st-rect':
			return [fill(rect(x0 + 8, y0, W - 8, H - 8)), fill(rect(x0 + 4, y0 + 4, W - 8, H - 8)), fill(rect(x0, y0 + 8, W - 8, H - 8))];
		case 'bow-rect': {
			const d = Math.min(W / 8, 14);
			return [fill(`M${n(x0)},${n(y0)} Q${n(x0 + d)},${n(cy)} ${n(x0)},${n(y1)} L${n(x1)},${n(y1)} Q${n(x1 - d)},${n(cy)} ${n(x1)},${n(y0)} Z`)];
		}
		case 'tag-rect':
			return [fill(rect(x0, y0, W, H)), stroke(line(x1 - 14, y1, x1, y1 - 14))];
		case 'notch-pent': {
			const d = Math.min(W / 6, H / 3);
			return [fill(poly([[x0 + d, y0], [x1 - d, y0], [x1, y0 + d], [x1, y1], [x0, y1], [x0, y0 + d]]))];
		}
		case 'sl-rect': {
			const d = Math.min(H / 3, 20);
			return [fill(poly([[x0, y0 + d], [x1, y0], [x1, y1], [x0, y1]]))];
		}
		case 'brace':
		case 'brace-l':
		case 'brace-r':
		case 'braces': {
			const left = `M${n(x0 + 18)},${n(y0)} Q${n(x0 + 6)},${n(y0)} ${n(x0 + 6)},${n(cy - 6)} Q${n(x0 + 6)},${n(cy)} ${n(x0)},${n(cy)} Q${n(x0 + 6)},${n(cy)} ${n(x0 + 6)},${n(cy + 6)} Q${n(x0 + 6)},${n(y1)} ${n(x0 + 18)},${n(y1)}`;
			const right = `M${n(x1 - 18)},${n(y0)} Q${n(x1 - 6)},${n(y0)} ${n(x1 - 6)},${n(cy - 6)} Q${n(x1 - 6)},${n(cy)} ${n(x1)},${n(cy)} Q${n(x1 - 6)},${n(cy)} ${n(x1 - 6)},${n(cy + 6)} Q${n(x1 - 6)},${n(y1)} ${n(x1 - 18)},${n(y1)}`;
			const hit = { d: rect(x0, y0, W, H), paint: 'hidden' as const };
			if (shape === 'brace-r') return [hit, stroke(right)];
			if (shape === 'braces') return [hit, stroke(left), stroke(right)];
			return [hit, stroke(left)];
		}
		case 'comment':
			return [{ d: rect(x0, y0, W, H), paint: 'hidden' }, stroke(`M${n(x0 + 14)},${n(y0)} Q${n(x0)},${n(y0)} ${n(x0)},${n(y0 + 14)} L${n(x0)},${n(y1 - 14)} Q${n(x0)},${n(y1)} ${n(x0 + 14)},${n(y1)}`)];
		case 'icon':
		case 'image':
			return [fill(rect(x0, y0, W, H, 6))];
		case 'note':
			return [fill(poly([[x0, y0], [x1 - 12, y0], [x1, y0 + 12], [x1, y1], [x0, y1]]))];
		default:
			return [fill(rect(x0, y0, W, H))];
	}
}

/**
 * The arrow marker to draw for a Mermaid arrow head on a canvas edge: `arrowclosed` for
 * the filled heads (`-->`, `<|--`, ER cardinalities fall back to it), `arrow` for open
 * ones, or `null` for none. Canvas libraries map these to their own marker types.
 */
export function mermaidEdgeMarker(head: string): 'arrow' | 'arrowclosed' | null {
	if (head === 'none') return null;
	if (head === 'arrow_open' || head === 'dependency') return 'arrow';
	return 'arrowclosed';
}


/**
 * The CSS custom properties and colours a Mermaid node paints with, from its resolved
 * `style` / `classDef` declarations. Unstyled nodes use the host's `--card`, `--foreground`
 * and `--primary` colours (with fallbacks), so they follow the app theme.
 */
export function mermaidNodePaint(styles: Record<string, string> = {}, selected = false): Record<string, string> {
	const paint: Record<string, string> = {
		'--pixerate-diagram-node-bg': styles.fill ?? 'var(--card, var(--background, #ffffff))',
		'--pixerate-diagram-node-border': selected ? 'var(--primary, #2563eb)' : (styles.stroke ?? 'var(--foreground, #0f172a)'),
		color: styles.color ?? 'var(--foreground, #0f172a)',
		'stroke-width': styles['stroke-width'] ?? (selected ? '2px' : '1.25px')
	};
	if (styles['stroke-dasharray']) paint['stroke-dasharray'] = styles['stroke-dasharray'];
	return paint;
}

/** How each {@link MermaidShapePaint} fills and strokes, as CSS declarations. */
export const MERMAID_SHAPE_PAINT: Record<MermaidShapePaint, { fill: string; stroke: string }> = {
	shape: { fill: 'var(--pixerate-diagram-node-bg)', stroke: 'var(--pixerate-diagram-node-border)' },
	line: { fill: 'none', stroke: 'var(--pixerate-diagram-node-border)' },
	filled: { fill: 'var(--pixerate-diagram-node-border)', stroke: 'var(--pixerate-diagram-node-border)' },
	hidden: { fill: 'transparent', stroke: 'none' }
};

/** A Mermaid label as plain lines: `<br>` splits lines, other tags and markdown-string quotes are dropped. */
export function mermaidLabelLines(label: string): string[] {
	return String(label)
		.replace(/^"`?|`?"$/g, '')
		.split(/<br\s*\/?>|\n/i)
		.map((line) => line.replace(/<[^>]+>/g, ''));
}

/** Class members / ER attributes of a node, one display line each. */
export function mermaidNodeMembers(data: Record<string, unknown> | undefined): string[] {
	const list = [...((data?.members as Array<{ raw?: string }>) ?? []), ...((data?.attributes as Array<{ raw?: string }>) ?? [])];
	return list.map((m) => m.raw ?? '');
}
