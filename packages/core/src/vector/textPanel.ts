/**
 * Framework-neutral data for a text panel (React and Svelte render it the same way): what it edits
 * (the selected characters of the text being edited, the selected text nodes, or the defaults for
 * new text), the current values (`null` where they differ), and the apply helpers.
 */
import type { VectorEditorController, VectorEditorState } from './controller.js';
import { findVectorNode, walkVectorNodes } from './geometry.js';
import { vectorTextFamilies, vectorTextHasOutlines, vectorTextRuns } from './text.js';
import { VECTOR_TEXT_ALIGNS, type VectorCharacterStyle, type VectorTextAlign, type VectorTextNode } from './types.js';

export interface VectorTextPanelData {
	/** `range`: the selected characters of the text being edited; `nodes`: whole text nodes; `defaults`: new text. */
	target: 'range' | 'nodes' | 'defaults';
	/** The text nodes edited (empty for defaults). */
	ids: string[];
	/** Character fields; `null` where the target mixes values (or, for leading, auto). */
	font: { [K in keyof Required<VectorCharacterStyle>]: VectorCharacterStyle[K] | null };
	align: VectorTextAlign | null;
	/** The frame kind of a single text node. */
	frame: 'point' | 'area' | 'path' | null;
	/** Families the shaper can draw (always the generic ones too). */
	families: string[];
	/** Whether the shaper gives outlines (Create Outlines works). */
	outlines: boolean;
	/** One path is selected: Type on a Path can turn it into path text. */
	pathId: string | null;
}

export const VECTOR_TEXT_ALIGN_LABELS: Readonly<Record<VectorTextAlign, string>> = { left: 'Left', center: 'Centre', right: 'Right', justify: 'Justify' };
export const VECTOR_TEXT_ALIGN_OPTIONS: readonly { value: VectorTextAlign; label: string }[] = VECTOR_TEXT_ALIGNS.map((value) => ({ value, label: VECTOR_TEXT_ALIGN_LABELS[value] }));
/** Weights a font menu offers. */
export const VECTOR_FONT_WEIGHTS: readonly { value: number; label: string }[] = [
	{ value: 100, label: 'Thin' },
	{ value: 300, label: 'Light' },
	{ value: 400, label: 'Regular' },
	{ value: 500, label: 'Medium' },
	{ value: 600, label: 'Semibold' },
	{ value: 700, label: 'Bold' },
	{ value: 900, label: 'Black' }
];

const FIELDS = ['fontFamily', 'fontWeight', 'italic', 'fontSize', 'tracking', 'leading', 'baselineShift', 'underline', 'strikethrough'] as const;

/**
 * The text panel for `state`: shown while a Type tool is active or text is selected; null
 * otherwise.
 */
export function getVectorTextPanel(state: Pick<VectorEditorState, 'document' | 'selection' | 'textEdit' | 'textDefaults' | 'tool'>): VectorTextPanelData | null {
	const nodes: VectorTextNode[] = [];
	for (const id of state.selection) {
		const n = findVectorNode(state.document.nodes, id);
		if (n)
			walkVectorNodes([n], (c) => {
				if (c.type === 'text') nodes.push(c);
			});
	}
	const typing = state.tool === 'type' || state.tool === 'typePath';
	const one = state.selection.length === 1 ? findVectorNode(state.document.nodes, state.selection[0]) : undefined;
	const pathId = one?.type === 'path' ? one.id : null;
	if (!nodes.length && !typing && !state.textEdit) return null;
	const styles: VectorCharacterStyle[] = [];
	let target: VectorTextPanelData['target'] = 'defaults';
	const edit = state.textEdit;
	const edited = edit ? (findVectorNode(state.document.nodes, edit.nodeId) as VectorTextNode | undefined) : undefined;
	if (edit && edited && edit.anchor !== edit.focus) {
		target = 'range';
		const a = Math.min(edit.anchor, edit.focus);
		const b = Math.max(edit.anchor, edit.focus);
		for (const r of vectorTextRuns(edited)) if (r.end > a && r.start < b) styles.push(r.style);
	} else if (nodes.length) {
		target = 'nodes';
		for (const n of nodes) for (const r of vectorTextRuns(n)) styles.push(r.style);
	} else {
		const { align: _a, ...font } = state.textDefaults;
		styles.push(font);
	}
	const same = <K extends (typeof FIELDS)[number]>(k: K): VectorCharacterStyle[K] | null => {
		const values = styles.map((s) => s[k] ?? (k === 'italic' || k === 'underline' || k === 'strikethrough' ? false : k === 'leading' ? null : k === 'tracking' || k === 'baselineShift' ? 0 : null));
		return values.every((v) => v === values[0]) ? ((values[0] ?? null) as VectorCharacterStyle[K] | null) : null;
	};
	const font = Object.fromEntries(FIELDS.map((k) => [k, same(k)])) as VectorTextPanelData['font'];
	const alignSource = target === 'defaults' ? [state.textDefaults.align ?? 'left'] : (target === 'range' ? [edited!] : nodes).map((n) => (n as VectorTextNode).paragraph?.align ?? 'left');
	const align = alignSource.every((a) => a === alignSource[0]) ? (alignSource[0] as VectorTextAlign) : null;
	const ids = target === 'range' ? [edited!.id] : nodes.map((n) => n.id);
	const frameNode = target === 'range' ? edited : nodes.length === 1 ? nodes[0] : undefined;
	return { target, ids, font, align, frame: frameNode?.frame.kind ?? null, families: vectorTextFamilies(), outlines: vectorTextHasOutlines(), pathId };
}

/**
 * Applies character fields (and `fill`) from the panel: to the selected characters, the selected
 * text nodes (one undo step) or the defaults for new text. `merge` folds slider drags into one step.
 */
export function applyVectorTextStyle(controller: VectorEditorController, patch: Record<string, unknown>, options: { merge?: string } = {}): void {
	const state = controller.getState();
	const panel = getVectorTextPanel(state);
	if (!panel) return;
	if (panel.target === 'range' && state.textEdit) {
		const a = Math.min(state.textEdit.anchor, state.textEdit.focus);
		const b = Math.max(state.textEdit.anchor, state.textEdit.focus);
		controller.setTextStyle(state.textEdit.nodeId, patch, { start: a, end: b }, options);
	} else if (panel.target === 'nodes') controller.styleTexts({ style: patch }, { ids: panel.ids, ...options });
	else {
		const { fill: _f, ...font } = patch;
		controller.setTextDefaults(font as Partial<VectorCharacterStyle>);
	}
}

/** Applies paragraph fields from the panel to the text being edited or selected, or to the defaults. */
export function applyVectorParagraphStyle(controller: VectorEditorController, patch: { align?: VectorTextAlign } & Record<string, unknown>, options: { merge?: string } = {}): void {
	const state = controller.getState();
	const panel = getVectorTextPanel(state);
	if (!panel) return;
	if (panel.target === 'defaults') {
		if (patch.align) controller.setTextDefaults({ align: patch.align });
		return;
	}
	controller.styleTexts({ paragraph: patch }, { ids: panel.ids, ...options });
}
