import {
	isMeasureModifierHeld,
	measureSelection,
	type MeasureSelectionResult,
	type NodeRectOptions
} from '@pixerate/editor/canvas';
import type { CanvasNode } from './types.js';

export interface CreateCanvasMeasureOptions<TNode extends CanvasNode = CanvasNode> {
	getNodes: () => TNode[];
	/** Ids measured from (default: nodes with `selected: true`). */
	getSelectedIds?: () => string[];
	/** Turns measuring off (default `true`). Read reactively. */
	enabled?: boolean | (() => boolean);
	/** Measure only while Alt / Option is held (default `true`); `false` always measures. */
	requireModifier?: boolean;
	rectOptions?: NodeRectOptions;
}

const EMPTY: MeasureSelectionResult = { guides: [], target: null, selection: null };

/**
 * Headless Svelte 5 rune for Alt-hover distance measuring: hold Alt / Option and hover a
 * node to see red distance lines with labels from the selection to it (or to the selection's
 * parent when hovering the selection or empty space).
 *
 * Wire it with `$effect(() => measure.listen())`, `onnodepointerenter={measure.onnodepointerenter}`
 * and `onnodepointerleave={measure.onnodepointerleave}` on `<SvelteFlow>`, and render
 * `measure.guides` with `<CanvasGuidesLayer>` (concatenate with `arrange.guides` to share one).
 */
export function createCanvasMeasure<TNode extends CanvasNode = CanvasNode>(options: CreateCanvasMeasureOptions<TNode>) {
	let hoveredId = $state<string | null>(null);
	let modifier = $state(false);

	const enabled = () => (typeof options.enabled === 'function' ? options.enabled() : options.enabled !== false);
	const active = $derived(enabled() && (options.requireModifier === false || modifier));
	const result = $derived.by(() => {
		if (!active) return EMPTY;
		const nodes = options.getNodes();
		const ids = options.getSelectedIds?.() ?? nodes.filter((n) => n.selected).map((n) => n.id);
		return measureSelection(nodes as any, ids, hoveredId, options.rectOptions);
	});

	return {
		/** Measuring lines (flow coordinates) for `<CanvasGuidesLayer>`. */
		get guides() {
			return result.guides;
		},
		/** The box measured to (outline it), or `null`. */
		get target() {
			return result.target;
		},
		/** Whether measuring is showing. */
		get active() {
			return active;
		},
		get hoveredId() {
			return hoveredId;
		},
		setHovered(id: string | null) {
			hoveredId = id;
		},
		/** Sets the modifier state by hand (e.g. from a toolbar toggle). */
		setModifier(held: boolean) {
			modifier = held;
		},
		onnodepointerenter: ({ node, event }: { node: { id: string }; event?: { altKey?: boolean } }) => {
			hoveredId = node.id;
			if (event && typeof event.altKey === 'boolean') modifier = event.altKey;
		},
		onnodepointerleave: ({ node }: { node: { id: string } }) => {
			if (hoveredId === node.id) hoveredId = null;
		},
		/**
		 * Tracks the Alt key on `target` (default `window`) and resets it when the window
		 * loses focus. Returns a cleanup function.
		 */
		listen(target: HTMLElement | Window | null = typeof window !== 'undefined' ? window : null): () => void {
			if (!target) return () => {};
			const onKey = (event: Event) => {
				modifier = isMeasureModifierHeld(event as KeyboardEvent);
			};
			const onBlur = () => {
				modifier = false;
			};
			target.addEventListener('keydown', onKey);
			target.addEventListener('keyup', onKey);
			const win = typeof window !== 'undefined' ? window : null;
			win?.addEventListener('blur', onBlur);
			return () => {
				target.removeEventListener('keydown', onKey);
				target.removeEventListener('keyup', onKey);
				win?.removeEventListener('blur', onBlur);
			};
		}
	};
}

export type CanvasMeasure = ReturnType<typeof createCanvasMeasure>;
