/**
 * Framework-neutral data for symbol UI: the symbols panel (each symbol with a preview, the selected
 * instance's options) and the dimmed document behind a symbol edited in isolation.
 */
import type { VectorEditorState } from './controller.js';
import { findVectorNode, unionBounds, vectorNodeBounds, IDENTITY_MATRIX } from './geometry.js';
import { getVectorSceneRenderData, type VectorSceneRenderData } from './render.js';
import type { VectorBounds, VectorInstanceNode, VectorNode, VectorPaint } from './types.js';

export interface VectorSymbolsPanelItem {
	id: string;
	name: string;
	instances: number;
	/** A preview: draw `scene.nodes` (with its defs and filters) in an `<svg viewBox={viewBox}>`. */
	viewBox: string;
	scene: VectorSceneRenderData;
	/** Being edited in isolation. */
	editing: boolean;
}

export interface VectorSymbolsPanelData {
	symbols: VectorSymbolsPanelItem[];
	/** The selection can become a symbol (objects selected, not one instance alone). */
	canMake: boolean;
	/** The one selected instance, with its options. */
	instance: { id: string; symbolId: string; scaleStrokes: boolean; fill: VectorPaint | null; stroke: VectorPaint | null; hidden: number } | null;
	editing: { symbolId: string; name: string } | null;
}

const fmt = (n: number) => Math.round(n * 100) / 100;

/** The symbols panel for `state`. */
export function getVectorSymbolsPanel(state: VectorEditorState, options: { idPrefix?: string } = {}): VectorSymbolsPanelData {
	const host = state.symbolEdit?.host ?? state.document;
	const counts = new Map<string, number>();
	const count = (list: readonly VectorNode[]) => {
		for (const n of list) {
			if (n.type === 'instance') counts.set(n.symbolId, (counts.get(n.symbolId) ?? 0) + 1);
			if (n.type === 'group') count(n.children);
		}
	};
	count(host.nodes);
	for (const s of host.symbols ?? []) count(s.nodes);
	const prefix = options.idPrefix ?? 'vsym-';
	const symbols = (host.symbols ?? []).map((s): VectorSymbolsPanelItem => {
		const b: VectorBounds = unionBounds(s.nodes.map((n) => vectorNodeBounds(n, IDENTITY_MATRIX))) ?? { x: -10, y: -10, width: 20, height: 20 };
		const pad = Math.max(b.width, b.height) * 0.08 + 1;
		const scene = getVectorSceneRenderData({ document: { width: 0, height: 0, nodes: s.nodes }, viewport: { x: 0, y: 0, zoom: 1 } }, { idPrefix: `${prefix}${s.id}-` });
		return {
			id: s.id,
			name: s.name,
			instances: counts.get(s.id) ?? 0,
			viewBox: `${fmt(b.x - pad)} ${fmt(b.y - pad)} ${fmt(b.width + 2 * pad)} ${fmt(b.height + 2 * pad)}`,
			scene,
			editing: state.symbolEdit?.symbolId === s.id
		};
	});
	const one = state.selection.length === 1 ? findVectorNode(state.document.nodes, state.selection[0]) : undefined;
	const inst = one?.type === 'instance' ? (one as VectorInstanceNode) : null;
	return {
		symbols,
		canMake: state.selection.length > 0 && !(state.selection.length === 1 && inst),
		instance: inst
			? { id: inst.id, symbolId: inst.symbolId, scaleStrokes: inst.scaleStrokes !== false, fill: inst.overrides?.fill ?? null, stroke: inst.overrides?.stroke ?? null, hidden: inst.overrides?.hidden?.length ?? 0 }
			: null,
		editing: state.symbolEdit ? { symbolId: state.symbolEdit.symbolId, name: state.symbolEdit.name } : null
	};
}

/**
 * The document behind a symbol edited in isolation, to draw dimmed under the art: its scene, placed
 * so the instance it was entered from lines up with the art (that instance left out). Null outside
 * isolation mode, or when the symbol was entered without an instance.
 */
export function getVectorSymbolEditBackground(state: VectorEditorState, options: { idPrefix?: string } = {}): (VectorSceneRenderData & { name: string }) | null {
	const e = state.symbolEdit;
	if (!e || !e.hostTransform) return null;
	const drop = (list: VectorNode[]): VectorNode[] => list.filter((n) => n.id !== e.instanceId).map((n) => (n.type === 'group' ? { ...n, children: drop(n.children) } : n));
	const scene = getVectorSceneRenderData({ document: { ...e.host, nodes: drop(e.host.nodes) }, viewport: state.viewport }, { idPrefix: options.idPrefix ?? 've-host-' });
	const m = e.hostTransform;
	return { ...scene, transform: `${scene.transform} matrix(${m.map((v) => Math.round(v * 1e6) / 1e6).join(' ')})`, name: e.name };
}
