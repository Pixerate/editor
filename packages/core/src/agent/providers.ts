import type { Editor } from '@tiptap/core';
import { plainTextToSlice, getEditorText } from '../serializers/plain-text.js';
import { getEditorMarkdown } from '../serializers/markdown.js';
import type { SpreadsheetController } from '../spreadsheet/controller.js';
import { colNameToIndex, indexToColName, isFormulaError } from '../spreadsheet/formula/evaluator.js';
import { planToolCall } from './planner.js';
import type { AgentTool, AgentToolProvider } from './registry.js';
import {
	MCP_TOOL_EDIT_CANVAS,
	MCP_TOOL_EDIT_PROMPT,
	MCP_TOOL_GET_EDITOR_STATE,
	MCP_TOOL_VIEW_EDITOR
} from './tools.js';
import type { AgentStep, EditorSnapshot } from './types.js';
import type { CanvasEdge, CanvasNode } from '../canvas/types.js';

export interface ToolProviderOptions {
	/** Provider id (unique per registry). */
	id: string;
	/** Always prefix tool names with `<namespace>__`. */
	namespace?: string;
}

// ---------------------------------------------------------------------------
// Rich-text editor provider
// ---------------------------------------------------------------------------

/** A TipTap editor, or anything exposing one as `.editor` (e.g. `EditorController`). */
export type RichTextToolTarget = Editor | { editor: Editor };

const toEditor = (target: RichTextToolTarget): Editor =>
	'commands' in target ? (target as Editor) : (target as { editor: Editor }).editor;

/** Replaces `from..to` with literal text (HTML is not parsed; newlines split paragraphs). */
function replaceWithText(editor: Editor, from: number, to: number, text: string) {
	const { state, view } = editor;
	const tr = /[\r\n]/.test(text)
		? state.tr.replace(from, to, plainTextToSlice(text, state.schema))
		: text
			? state.tr.insertText(text, from, to)
			: state.tr.delete(from, to);
	view.dispatch(tr.scrollIntoView());
}

function selectionInfo(editor: Editor) {
	const { from, to } = editor.state.selection;
	return { from, to, text: editor.state.doc.textBetween(from, to, '\n') };
}

/**
 * Tools for a mounted rich-text editor: `get_text` (always), plus
 * `insert_text` and `replace_selection` while the editor is editable.
 * Positions are ProseMirror document positions (as in `selection.from`).
 * The provider re-announces its tool list when editability changes and
 * exposes no tools once the editor is destroyed.
 */
export function createRichTextToolProvider(
	target: RichTextToolTarget,
	options: ToolProviderOptions
): AgentToolProvider {
	const editor = () => toEditor(target);

	const getText: AgentTool = {
		name: 'get_text',
		description:
			'Returns the document content (plain text by default, or HTML / markdown) and the current selection.',
		inputSchema: {
			type: 'object',
			properties: {
				format: {
					type: 'string',
					enum: ['text', 'html', 'markdown'],
					description: 'Content format (default: text).'
				}
			},
			additionalProperties: false
		},
		annotations: { readOnlyHint: true },
		handler: ({ format = 'text' }) => {
			const ed = editor();
			const content =
				format === 'html' ? ed.getHTML() : format === 'markdown' ? getEditorMarkdown(ed) : getEditorText(ed);
			return { format, content, selection: selectionInfo(ed), size: ed.state.doc.content.size };
		}
	};

	const insertText: AgentTool = {
		name: 'insert_text',
		description:
			'Inserts literal text (newlines start new paragraphs) at a document position, or at the cursor when `at` is omitted.',
		inputSchema: {
			type: 'object',
			properties: {
				text: { type: 'string', description: 'Text to insert.' },
				at: { type: 'integer', minimum: 0, description: 'Document position (default: the selection).' }
			},
			required: ['text'],
			additionalProperties: false
		},
		handler: ({ text, at }) => {
			const ed = editor();
			const size = ed.state.doc.content.size;
			if (at !== undefined && at > size) {
				throw new Error(`Position ${at} is outside the document (size ${size}).`);
			}
			const { from, to } = ed.state.selection;
			replaceWithText(ed, at ?? from, at ?? to, text);
			return { inserted: text.length, selection: selectionInfo(ed) };
		}
	};

	const replaceSelection: AgentTool = {
		name: 'replace_selection',
		description: 'Replaces the selected content with literal text (an empty string deletes the selection).',
		inputSchema: {
			type: 'object',
			properties: { text: { type: 'string', description: 'Replacement text.' } },
			required: ['text'],
			additionalProperties: false
		},
		annotations: { destructiveHint: true },
		handler: ({ text }) => {
			const ed = editor();
			const { from, to } = ed.state.selection;
			replaceWithText(ed, from, to, text);
			return { replaced: { from, to }, selection: selectionInfo(ed) };
		}
	};

	return {
		id: options.id,
		namespace: options.namespace,
		tools: () => {
			const ed = editor();
			if (!ed || ed.isDestroyed) return [];
			return ed.isEditable ? [getText, insertText, replaceSelection] : [getText];
		},
		subscribe: (notify) => {
			const ed = editor();
			// `setEditable` emits `update`; the registry ignores signals that don't change the list.
			ed.on('update', notify);
			ed.on('destroy', notify);
			return () => {
				ed.off('update', notify);
				ed.off('destroy', notify);
			};
		}
	};
}

// ---------------------------------------------------------------------------
// Spreadsheet provider
// ---------------------------------------------------------------------------

const CELL_REF_REGEX = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;

function parseCell(ref: string): { col: number; row: number } {
	const match = CELL_REF_REGEX.exec(ref.trim());
	if (!match) throw new Error(`Invalid cell reference "${ref}". Use A1 notation, e.g. "B3".`);
	return { col: colNameToIndex(match[1].toUpperCase()), row: parseInt(match[2], 10) - 1 };
}

/**
 * Tools for a spreadsheet controller: `get_range` (A1 notation, values and raw
 * input) and `set_cell` (raw input; values starting with `=` are formulas).
 */
export function createSpreadsheetToolProvider(
	controller: SpreadsheetController,
	options: ToolProviderOptions
): AgentToolProvider {
	const lookup = (row: number, col: number) => {
		const rowDef = controller.document.rows[row];
		const colDef = controller.document.columns[col];
		return rowDef && colDef ? { rowDef, colDef } : null;
	};

	const getRange: AgentTool = {
		name: 'get_range',
		description:
			'Reads a cell range in A1 notation (e.g. "A1:C5" or "B2") and returns computed values, raw input and errors.',
		inputSchema: {
			type: 'object',
			properties: {
				range: { type: 'string', description: 'A1-notation cell or range.' }
			},
			required: ['range'],
			additionalProperties: false
		},
		annotations: { readOnlyHint: true },
		handler: ({ range }) => {
			const [startRef, endRef = startRef] = String(range).split(':');
			const start = parseCell(startRef);
			const end = parseCell(endRef);
			const rowCount = controller.document.rows.length;
			const colCount = controller.document.columns.length;
			const r0 = Math.min(start.row, end.row);
			const r1 = Math.min(Math.max(start.row, end.row), rowCount - 1);
			const c0 = Math.min(start.col, end.col);
			const c1 = Math.min(Math.max(start.col, end.col), colCount - 1);
			const values: unknown[][] = [];
			const raw: string[][] = [];
			const errors: Array<{ cell: string; error: string }> = [];
			for (let r = r0; r <= r1; r++) {
				const valueRow: unknown[] = [];
				const rawRow: string[] = [];
				for (let c = c0; c <= c1; c++) {
					const found = lookup(r, c)!;
					const cell = controller.getCell(found.rowDef.id, found.colDef.id);
					valueRow.push(cell.error ?? cell.value);
					rawRow.push(cell.raw);
					const error = cell.error ?? (isFormulaError(cell.value) ? cell.value : undefined);
					if (error) errors.push({ cell: `${indexToColName(c)}${r + 1}`, error });
				}
				values.push(valueRow);
				raw.push(rawRow);
			}
			return {
				range: values.length && values[0].length ? `${indexToColName(c0)}${r0 + 1}:${indexToColName(c1)}${r1 + 1}` : null,
				values,
				raw,
				errors,
				sheet: { rows: rowCount, columns: colCount }
			};
		}
	};

	const setCell: AgentTool = {
		name: 'set_cell',
		description: 'Sets the raw input of one cell (A1 notation). Values starting with "=" are formulas.',
		inputSchema: {
			type: 'object',
			properties: {
				cell: { type: 'string', description: 'A1-notation cell, e.g. "B3".' },
				value: { type: ['string', 'number', 'boolean'], description: 'Raw cell input.' }
			},
			required: ['cell', 'value'],
			additionalProperties: false
		},
		handler: ({ cell, value }) => {
			const { row, col } = parseCell(cell);
			const found = lookup(row, col);
			if (!found) throw new Error(`Cell ${cell} is outside the sheet.`);
			const { rowDef, colDef } = found;
			if (colDef.readOnly || controller.getCell(rowDef.id, colDef.id).readOnly || colDef.type === 'formula') {
				throw new Error(`Cell ${cell} is read-only.`);
			}
			controller.setCellValue(rowDef.id, colDef.id, String(value));
			const updated = controller.getCell(rowDef.id, colDef.id);
			return { cell: cell.toUpperCase(), raw: updated.raw, value: updated.error ?? updated.value };
		}
	};

	return { id: options.id, namespace: options.namespace, tools: [getRange, setCell] };
}

// ---------------------------------------------------------------------------
// Static editor tools (tools.ts) as a provider
// ---------------------------------------------------------------------------

export interface EditorMcpToolProviderOptions<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
> extends ToolProviderOptions {
	/** Current editor / canvas state. */
	getSnapshot: () => EditorSnapshot<TNode, TEdge>;
	/** Applies planned steps (e.g. via your canvas runes / editor controller). */
	applySteps: (steps: AgentStep<TNode, TEdge>[]) => void | Promise<void>;
	/** Optional `view_editor` implementation; the tool is only exposed when provided. */
	captureView?: (args: { scope?: 'viewport' | 'canvas'; format?: 'jpeg' | 'png'; maxEdge?: number }) =>
		| Promise<{ data: string; mimeType: string }>
		| { data: string; mimeType: string };
	/** Options forwarded to the planner. */
	plannerOptions?: Parameters<typeof planToolCall>[3];
}

/**
 * Exposes the static MCP tools from `tools.ts` (`get_editor_state`,
 * `edit_canvas`, `edit_prompt`, `view_editor`) through a `ToolRegistry`,
 * planning edits with `planToolCall` and handing the steps to `applySteps`.
 */
export function createEditorMcpToolProvider<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(options: EditorMcpToolProviderOptions<TNode, TEdge>): AgentToolProvider {
	const edit = (name: string) => async (args: Record<string, any>) => {
		const steps = planToolCall<TNode, TEdge>(name, args, options.getSnapshot(), options.plannerOptions);
		if (steps.length === 0) {
			throw new Error(`Operation "${args.operation}" is missing required arguments.`);
		}
		await options.applySteps(steps);
		return { applied: steps.length, steps: steps.map((s) => s.type) };
	};

	const tools: AgentTool[] = [
		{
			...MCP_TOOL_GET_EDITOR_STATE,
			handler: ({ includeDocument = true, includeCanvas = true }) => {
				const snapshot = options.getSnapshot();
				return {
					...(includeDocument && snapshot.document ? { document: snapshot.document } : {}),
					...(includeCanvas && snapshot.canvas ? { canvas: snapshot.canvas } : {})
				};
			}
		},
		{ ...MCP_TOOL_EDIT_CANVAS, handler: edit(MCP_TOOL_EDIT_CANVAS.name) },
		{ ...MCP_TOOL_EDIT_PROMPT, handler: edit(MCP_TOOL_EDIT_PROMPT.name) }
	] as AgentTool[];

	if (options.captureView) {
		const capture = options.captureView;
		tools.push({
			...MCP_TOOL_VIEW_EDITOR,
			handler: async (args) => {
				const image = await capture(args);
				return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }] };
			}
		} as AgentTool);
	}

	return { id: options.id, namespace: options.namespace, tools };
}
