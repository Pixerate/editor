import { getFamilyLayout, type LayoutResult } from './layout-registry.js';
import type { DiagramFamily, EditOp, MermaidDocument, Point } from './types.js';

/** The family's own layout of `doc` (families positioned by their data). */
function familyLayoutOf(doc: MermaidDocument): LayoutResult {
  const layout = getFamilyLayout(doc.family);
  if (!layout) throw new Error(`Nodes of a ${doc.family} diagram have no order to change; use move_diagram_nodes to place them.`);
  return layout(doc.graph, doc.meta, { measure: () => ({ width: 160, height: 56 }) });
}

/** Families whose order is their position, and the axis that order runs along. */
export const DIAGRAM_ORDER_AXIS: Partial<Record<DiagramFamily, 'x' | 'y'>> = { sequence: 'x', journey: 'x', timeline: 'x', gantt: 'y' };

/**
 * The edits that move `id` to just before `before` (or to the end with `null`) in a family
 * whose order is its position: sequence participants, journey tasks, timeline periods and Gantt
 * tasks. Moving next to a node in another section moves into that section. Planned as the drop
 * a person would make, so the adapter rewrites the statements the same way. Throws when the
 * family has no order or an id is unknown. `layout` defaults to the family's own layout.
 */
export function planDiagramReorder(doc: MermaidDocument, id: string, before: string | null, layout: LayoutResult = familyLayoutOf(doc)): EditOp[] {
	const axis = DIAGRAM_ORDER_AXIS[doc.family];
	if (!axis) throw new Error(`Nodes of a ${doc.family} diagram have no order to change; use move_diagram_nodes to place them.`);
	const k = axis === 'x' ? 0 : 1;
	const extent = (s: { width: number; height: number }) => (axis === 'x' ? s.width : s.height);
	const ordered = doc.graph.nodes.filter((n) => layout.positions[n.id]).sort((a, b) => layout.positions[a.id]![k] - layout.positions[b.id]![k]);
	const node = ordered.find((n) => n.id === id);
	if (!node) throw new Error(`There is no node "${id}"; existing ids are ${ordered.map((n) => `"${n.id}"`).join(', ')}.`);
	if (before === id) return [];
	const anchor = before === null ? null : ordered.find((n) => n.id === before);
	if (before !== null && !anchor) throw new Error(`There is no node "${before}" to move before; existing ids are ${ordered.map((n) => `"${n.id}"`).join(', ')}.`);
	const others = ordered.filter((n) => n.id !== id);
	const nextAfter = (anchor ? others[others.indexOf(anchor) - 1] : others.at(-1)) ?? null;
	const current = ordered.indexOf(node);
	const already = anchor ? ordered[current + 1]?.id === anchor.id : current === ordered.length - 1;
	if (already) return [];
	const p = layout.positions[id]!;
	const size = extent(layout.sizes[id] ?? { width: 0, height: 0 });
	const centreOf = (n: { id: string }) => layout.positions[n.id]![k] + extent(layout.sizes[n.id] ?? { width: 0, height: 0 }) / 2;
	// Land between the neighbours: just before the anchor's centre, or past the last node.
	let centre: number;
	if (anchor) {
		const a = centreOf(anchor);
		const b = nextAfter ? centreOf(nextAfter) : a - extent(layout.sizes[anchor.id] ?? { width: 0, height: 0 });
		centre = axis === 'y' ? a : (a + b) / 2;
		if (axis === 'y' && current < ordered.indexOf(anchor)) centre = b;
	} else centre = centreOf(ordered.at(-1)!) + extent(layout.sizes[ordered.at(-1)!.id] ?? { width: 0, height: 0 });
	const position: Point = axis === 'x' ? [centre - size / 2, p[1]] : [p[0], centre - size / 2];
	return [{ type: 'moveNodes', moves: [{ id, position }] }];
}
