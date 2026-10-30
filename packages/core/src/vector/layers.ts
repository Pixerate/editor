/**
 * The vector document as a layers panel shows it: one row per node, top first, groups indented
 * with their children when expanded. Hosts draw the rows themselves and act on them with the
 * controller (`select`, `setVisible`, `setLocked`, `rename`, `reorderNode`).
 */

import type { VectorNode } from './types.js';
import { isVectorBlendGroup } from './blendGroup.js';
import { isVectorConnector } from './connectors.js';
import { isVectorFrame } from './frames.js';
import { isVectorLens } from './lens.js';
import { isVectorMaskGroup } from './mask.js';
import { isVectorSymmetryGroup } from './symmetry.js';

/** What a layer is, for its icon and its default name. */
export type VectorLayerKind = 'path' | 'connector' | 'lens' | 'text' | 'instance' | 'group' | 'frame' | 'mask' | 'blend' | 'boolean' | 'symmetry';

export const VECTOR_LAYER_KIND_LABELS: Record<VectorLayerKind, string> = {
	path: 'Path',
	connector: 'Connector',
	lens: 'Lens',
	text: 'Text',
	instance: 'Symbol',
	group: 'Group',
	frame: 'Frame',
	mask: 'Clipping Group',
	blend: 'Blend',
	boolean: 'Live Boolean',
	symmetry: 'Symmetry',
};

export interface VectorLayerRow {
	id: string;
	name: string;
	kind: VectorLayerKind;
	/** 0 for the document's own nodes. */
	depth: number;
	parentId: string | null;
	visible: boolean;
	locked: boolean;
	/** Children the row can show (a blend's generated steps are not counted). */
	childCount: number;
	expanded: boolean;
}

export function vectorLayerKind(node: VectorNode): VectorLayerKind {
	if (node.type === 'text') return 'text';
	if (node.type === 'instance') return 'instance';
	if (node.type === 'path') return isVectorConnector(node) ? 'connector' : isVectorLens(node) ? 'lens' : 'path';
	if (isVectorFrame(node)) return 'frame';
	if (isVectorMaskGroup(node)) return 'mask';
	if (isVectorBlendGroup(node)) return 'blend';
	if (node.liveBoolean) return 'boolean';
	if (isVectorSymmetryGroup(node)) return 'symmetry';
	return 'group';
}

/** The node's name, else its text (for text), else its kind. */
export function vectorLayerName(node: VectorNode): string {
	const name = node.name?.trim();
	if (name) return name;
	if (node.type === 'text') {
		const text = node.text.replace(/\s+/g, ' ').trim();
		if (text) return text.length > 40 ? `${text.slice(0, 39)}…` : text;
	}
	return VECTOR_LAYER_KIND_LABELS[vectorLayerKind(node)];
}

/** A group's children as the layers panel lists them: a blend's generated steps are left out. */
export function vectorLayerChildren(node: VectorNode): VectorNode[] {
	return node.type === 'group' ? node.children.filter((child) => !child.blendStep) : [];
}

/**
 * The rows for `nodes` (bottom to top, as documents keep them), top first. A group's children
 * follow it, indented, when `expanded` says so.
 */
export function vectorLayerRows(nodes: readonly VectorNode[], expanded: (id: string) => boolean = () => false): VectorLayerRow[] {
	const rows: VectorLayerRow[] = [];
	const visit = (list: readonly VectorNode[], depth: number, parentId: string | null) => {
		for (let i = list.length - 1; i >= 0; i--) {
			const node = list[i];
			const children = vectorLayerChildren(node);
			const open = children.length > 0 && expanded(node.id);
			rows.push({
				id: node.id,
				name: vectorLayerName(node),
				kind: vectorLayerKind(node),
				depth,
				parentId,
				visible: node.visible !== false,
				locked: !!node.locked,
				childCount: children.length,
				expanded: open,
			});
			if (open) visit(children, depth + 1, node.id);
		}
	};
	visit(nodes, 0, null);
	return rows;
}
