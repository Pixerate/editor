import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	isMeasureModifierHeld,
	measureSelection,
	type CanvasNode,
	type MeasureSelectionResult,
	type NodeRectOptions
} from '@pixerate/editor/canvas';

export interface UseCanvasMeasureOptions<TNode extends CanvasNode = CanvasNode> {
	nodes: TNode[];
	/** Ids measured from (default: nodes with `selected: true`). */
	getSelectedIds?: () => string[];
	/** Turns measuring off (default `true`). */
	enabled?: boolean;
	/** Measure only while Alt / Option is held (default `true`); `false` always measures. */
	requireModifier?: boolean;
	/** Element receiving the Alt key events (default `window`). */
	targetElement?: HTMLElement | Window | null;
	rectOptions?: NodeRectOptions;
}

const EMPTY: MeasureSelectionResult = { guides: [], target: null, selection: null };

/**
 * Alt-hover distance measuring for React Flow: hold Alt / Option and hover a node to see
 * red distance lines with labels from the selection to it (or to the selection's parent
 * when hovering the selection or empty space). Wire `onNodeMouseEnter` / `onNodeMouseLeave`
 * to `<ReactFlow>` and render `guides` with `<CanvasGuidesLayer>` (concatenate them with
 * `arrange.guides` to share one layer).
 */
export function useCanvasMeasure<TNode extends CanvasNode = CanvasNode>(options: UseCanvasMeasureOptions<TNode>) {
	const { nodes, enabled = true, requireModifier = true, targetElement, rectOptions } = options;
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	const [modifier, setModifier] = useState(false);
	const optionsRef = useRef(options);
	optionsRef.current = options;

	useEffect(() => {
		if (!enabled) return;
		const target = targetElement ?? (typeof window !== 'undefined' ? window : null);
		if (!target) return;
		const onKey = (event: Event) => setModifier(isMeasureModifierHeld(event as KeyboardEvent));
		const onBlur = () => setModifier(false);
		target.addEventListener('keydown', onKey);
		target.addEventListener('keyup', onKey);
		const win = typeof window !== 'undefined' ? window : null;
		win?.addEventListener('blur', onBlur);
		return () => {
			target.removeEventListener('keydown', onKey);
			target.removeEventListener('keyup', onKey);
			win?.removeEventListener('blur', onBlur);
		};
	}, [enabled, targetElement]);

	const active = enabled && (!requireModifier || modifier);
	const result = useMemo(() => {
		if (!active) return EMPTY;
		const ids = optionsRef.current.getSelectedIds?.() ?? nodes.filter((n) => n.selected).map((n) => n.id);
		return measureSelection(nodes, ids, hoveredId, rectOptions);
	}, [active, nodes, hoveredId, rectOptions]);

	const onNodeMouseEnter = useCallback((event: { altKey?: boolean } | null, node: { id: string }) => {
		setHoveredId(node.id);
		if (event && typeof event.altKey === 'boolean') setModifier(event.altKey);
	}, []);
	const onNodeMouseLeave = useCallback((_event: unknown, node: { id: string }) => {
		setHoveredId((current) => (current === node.id ? null : current));
	}, []);

	return {
		/** Measuring lines (flow coordinates) to pass to `<CanvasGuidesLayer>`. */
		guides: result.guides,
		/** The box measured to (outline it), or `null`. */
		target: result.target,
		/** Whether measuring is showing (enabled and Alt held, unless `requireModifier: false`). */
		active,
		hoveredId,
		setHoveredId,
		/** Sets the modifier state by hand (e.g. from a toolbar toggle). */
		setModifier,
		onNodeMouseEnter,
		onNodeMouseLeave
	};
}

export type CanvasMeasure = ReturnType<typeof useCanvasMeasure>;
