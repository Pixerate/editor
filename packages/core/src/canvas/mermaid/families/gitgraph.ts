// Follows Ursula's src/react/canvases/gitgraph.tsx.
import { GIT_METRICS, estimateTextWidth, gitGraphGeometry, type GitCommitGeometry, type GitDirection } from '../../../diagram/gitgraph/geometry.js';
import { sceneColor, type DiagramMark, type DiagramSceneTheme, type FamilyScene } from '../scene-kit.js';

const M = GIT_METRICS;

type Pt = [number, number];

/** Rotates (dx, dy) by `deg` degrees (SVG / CSS sense: positive is clockwise on screen). */
function rot([dx, dy]: Pt, deg: number): Pt {
	const a = (deg * Math.PI) / 180;
	const c = Math.cos(a);
	const s = Math.sin(a);
	return [dx * c - dy * s, dx * s + dy * c];
}

const polygon = (points: Pt[]) => `M${points.map(([x, y]) => `${round(x)},${round(y)}`).join(' L')} Z`;
const round = (v: number) => Math.round(v * 100) / 100;

function boxOf(points: Pt[]): { x: number; y: number; width: number; height: number } {
	const xs = points.map((p) => p[0]);
	const ys = points.map((p) => p[1]);
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * Bounds of a parent link (`M`, `L` and quarter-circle `A` commands in absolute
 * coordinates); each arc stays inside the box of its end points.
 */
function arrowBox(d: string): { x: number; y: number; width: number; height: number } {
	const points: Pt[] = [];
	for (const [, cmd, args] of d.matchAll(/([MLA])([^MLA]*)/g)) {
		const nums = (args!.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/gi) ?? []).map(Number);
		if (cmd === 'A') {
			for (let i = 0; i + 6 < nums.length; i += 7) points.push([nums[i + 5]!, nums[i + 6]!]);
		} else for (let i = 0; i + 1 < nums.length; i += 2) points.push([nums[i]!, nums[i + 1]!]);
	}
	return points.length ? boxOf(points) : { x: 0, y: 0, width: 0, height: 0 };
}

/** Mermaid's commit symbol per type (`drawCommitBullet`), centred on the commit. */
function commitSymbol(c: GitCommitGeometry, theme: DiagramSceneTheme): DiagramMark[] {
	const color = sceneColor(theme, c.color);
	const base = { target: c.id };
	switch (c.symbol) {
		case 'HIGHLIGHT':
			return [
				{ kind: 'rect', key: `commit:${c.id}`, role: 'commit', ...base, x: c.x - 10, y: c.y - 10, width: 20, height: 20, fill: theme.text, stroke: theme.text },
				{ kind: 'rect', key: `commit-inner:${c.id}`, role: 'commit-inner', ...base, x: c.x - 6, y: c.y - 6, width: 12, height: 12, fill: color, stroke: color }
			];
		case 'CHERRY_PICK':
			return [
				{ kind: 'circle', key: `commit:${c.id}`, role: 'commit', ...base, cx: c.x, cy: c.y, r: M.commitRadius, fill: theme.text },
				{ kind: 'circle', key: `cherry-l:${c.id}`, role: 'cherry', ...base, cx: c.x - 3, cy: c.y + 2, r: 2.75, fill: theme.background },
				{ kind: 'circle', key: `cherry-r:${c.id}`, role: 'cherry', ...base, cx: c.x + 3, cy: c.y + 2, r: 2.75, fill: theme.background },
				{
					kind: 'path',
					key: `cherry-stem:${c.id}`,
					role: 'cherry-stem',
					...base,
					d: `M${c.x + 3},${c.y + 1} L${c.x},${c.y - 5} M${c.x - 3},${c.y + 1} L${c.x},${c.y - 5}`,
					fill: 'none',
					stroke: theme.background
				}
			];
		default: {
			const marks: DiagramMark[] = [{ kind: 'circle', key: `commit:${c.id}`, role: 'commit', ...base, cx: c.x, cy: c.y, r: M.commitRadius, fill: color, stroke: color }];
			if (c.symbol === 'MERGE')
				marks.push({ kind: 'circle', key: `commit-inner:${c.id}`, role: 'commit-inner', ...base, cx: c.x, cy: c.y, r: 6, fill: theme.background, stroke: theme.background });
			if (c.symbol === 'REVERSE')
				marks.push({
					kind: 'path',
					key: `commit-reverse:${c.id}`,
					role: 'commit-reverse',
					...base,
					d: `M${c.x - 5},${c.y - 5} L${c.x + 5},${c.y + 5} M${c.x - 5},${c.y + 5} L${c.x + 5},${c.y - 5}`,
					fill: 'none',
					stroke: theme.background,
					strokeWidth: 3
				});
			return marks;
		}
	}
}

/** The commit label (its id) on a faint background, rotated -45° about its right end like Mermaid. */
function commitLabel(c: GitCommitGeometry, text: string, direction: GitDirection, theme: DiagramSceneTheme): DiagramMark[] {
	const w = estimateTextWidth(text, M.labelFontSize);
	const anchor: Pt = direction === 'LR' ? [1 - 0.026 * w, 18.1 - 0.0136 * w] : [-14.9, 9.2];
	const ax = c.x + anchor[0];
	const ay = c.y + anchor[1];
	// The label box (2px padding, 14px line) ends at the anchor; it turns about the anchor.
	const corners = ([[-w - 4, -7], [0, -7], [0, 7], [-w - 4, 7]] as Pt[]).map((p) => {
		const [dx, dy] = rot(p, -45);
		return [ax + dx, ay + dy] as Pt;
	});
	const [tx, ty] = rot([-2, 0], -45);
	return [
		{ kind: 'path', key: `label-bg:${c.id}`, role: 'commit-label-bg', target: c.id, d: polygon(corners), fill: theme.edgeLabelBackground, opacity: 0.5 },
		{ kind: 'text', key: `label:${c.id}`, role: 'commit-label', target: c.id, x: ax + tx, y: ay + ty, text, anchor: 'end', baseline: 'middle', size: M.labelFontSize, fill: theme.text, rotate: -45 }
	];
}

/** A tag: a label with a pointed, punched end above the commit (`drawCommitTags`). */
function commitTag(c: GitCommitGeometry, text: string, index: number, direction: GitDirection, theme: DiagramSceneTheme): DiagramMark[] {
	const w = estimateTextWidth(text, M.labelFontSize);
	const h2 = M.labelTextHeight / 2;
	const key = `${c.id}:${index}`;
	let points: Pt[];
	let hole: Pt;
	let label: Pt;
	let rotate: number | undefined;
	if (direction === 'LR') {
		const ly = -19.2 - index * 20;
		const local: Pt[] = [
			[-w / 2 - 12, ly + 2],
			[-w / 2 - 12, ly - 2],
			[-w / 2 - 4, ly - h2 - 2],
			[w / 2 + 4, ly - h2 - 2],
			[w / 2 + 4, ly + h2 + 2],
			[-w / 2 - 4, ly + h2 + 2]
		];
		points = local.map(([x, y]) => [c.x + x, c.y + y]);
		hole = [c.x - w / 2 - 8, c.y + ly];
		label = [c.x, c.y + ly];
	} else {
		// Vertical graphs: the tag hangs at 45° to the right of the commit.
		const ox = c.x + 12;
		const oy = c.y + 2 + index * 20;
		const place = (p: Pt): Pt => {
			const [dx, dy] = rot(p, 45);
			return [ox + dx, oy + dy];
		};
		points = ([[0, 2], [0, -2], [10, -h2 - 2], [14 + w, -h2 - 2], [14 + w, h2 + 2], [10, h2 + 2]] as Pt[]).map(place);
		hole = place([2, 0]);
		label = place([12 + w / 2, 0]);
		rotate = 45;
	}
	return [
		{ kind: 'path', key: `tag:${key}`, role: 'tag', target: c.id, d: polygon(points), fill: theme.groupFill, stroke: theme.groupStroke },
		{ kind: 'circle', key: `tag-hole:${key}`, role: 'tag-hole', target: c.id, cx: hole[0], cy: hole[1], r: 1.5, fill: theme.text },
		{
			kind: 'text',
			key: `tag-label:${key}`,
			role: 'tag-label',
			target: c.id,
			x: label[0],
			y: label[1],
			text,
			anchor: 'middle',
			baseline: 'middle',
			size: M.labelFontSize,
			fill: theme.text,
			...(rotate !== undefined ? { rotate } : {})
		}
	];
}

/**
 * Git graphs as Mermaid draws them (Ursula's `canvases/gitgraph.tsx`): a dashed lane per
 * branch with its name in a pill of the branch colour, Mermaid's thick lane-coloured parent
 * links with their arcs, commits as bullets along the lanes (normal, reverse, highlight,
 * merge and cherry-pick symbols), rotated commit labels and tags. A bullet, its label and
 * tags select the commit; a pill selects the branch; a link selects the parent edge.
 */
export const gitGraphScene: FamilyScene = ({ graph, theme }) => {
	const geo = gitGraphGeometry(graph);
	const marks: DiagramMark[] = [];
	for (const lane of geo.lanes) {
		const { x1, y1, x2, y2 } = lane.line;
		marks.push({ kind: 'line', key: `lane:${lane.branch}`, role: 'lane', x1, y1, x2, y2, stroke: theme.grid, strokeWidth: 1, dash: '2 2' });
	}
	for (const edge of graph.edges) {
		const arrow = geo.arrows.get(edge.id);
		if (!arrow) continue;
		marks.push({
			kind: 'path',
			key: `arrow:${edge.id}`,
			role: 'parent-link',
			target: edge.id,
			d: arrow.path,
			fill: 'none',
			stroke: sceneColor(theme, arrow.color),
			strokeWidth: 8,
			box: arrowBox(arrow.path)
		});
	}
	const groups = new Map(graph.groups.map((g) => [g.id, g]));
	for (const lane of geo.lanes) {
		const group = groups.get(lane.branch);
		if (!group) continue;
		const { x, y, width, height } = lane.label;
		const color = sceneColor(theme, lane.color);
		marks.push(
			{ kind: 'rect', key: `branch:${lane.branch}`, role: 'branch', target: lane.branch, x, y, width, height, fill: color, radius: 4 },
			{
				kind: 'text',
				key: `branch-label:${lane.branch}`,
				role: 'branch-label',
				target: lane.branch,
				x: x + width / 2,
				y: y + height / 2,
				text: group.label || group.id,
				anchor: 'middle',
				baseline: 'middle',
				size: M.branchFontSize,
				fill: theme.paletteText
			}
		);
	}
	for (const node of graph.nodes) {
		const c = geo.commits.get(node.id);
		if (!c) continue;
		marks.push(...commitSymbol(c, theme));
		if (c.label !== undefined) marks.push(...commitLabel(c, c.label, geo.direction, theme));
		c.tags.forEach((t, i) => marks.push(...commitTag(c, t, i, geo.direction, theme)));
	}
	return marks;
};
