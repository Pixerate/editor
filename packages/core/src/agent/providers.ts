import type { Editor } from '@tiptap/core';
import { plainTextToSlice, getEditorText } from '../serializers/plain-text.js';
import { getEditorMarkdown } from '../serializers/markdown.js';
import { TextSelection } from '@tiptap/pm/state';
import {
	TABLE_ACTIONS,
	getTableActionState,
	getTableState,
	isTableEnabled,
	runTableAction,
	type TableAction
} from '../extensions/table/actions.js';
import { applyReplacements, searchDocument, type FindMatch } from '../extensions/find-replace/search.js';
import type { FindOptions } from '../extensions/find-replace/pattern.js';
import type { SpreadsheetController } from '../spreadsheet/controller.js';
import { colNameToIndex, indexToColName, isFormulaError } from '../spreadsheet/formula/evaluator.js';
import { planAgentCommand, toolCallToAgentCommand, validateAgentCommand, type planToolCall } from './planner.js';
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import {
	EDIT_OPERATION_REQUIRED_ARGUMENTS,
	EDITOR_CANVAS_TOOLS,
	EDITOR_PROMPT_TOOLS,
	MCP_TOOL_EDIT_CANVAS,
	MCP_TOOL_EDIT_PROMPT,
	MCP_TOOL_GET_EDITOR_STATE,
	MCP_TOOL_VIEW_EDITOR
} from '../tools/definitions.js';
import type { AgentStep, EditorSnapshot } from './types.js';
import { createDocumentChartTools } from './documentChartTools.js';
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

/** Throws a tool error unless `from..to` is an ordered range inside the document. */
function checkRange(editor: Editor, from: number, to: number) {
	const size = editor.state.doc.content.size;
	if (from > to) throw new Error(`"from" (${from}) must not be after "to" (${to}).`);
	if (to > size) throw new Error(`Position ${to} is outside the document (size ${size}).`);
}

/** Textblocks (paragraphs, headings, cells...) with the positions their text spans. */
function textBlocks(editor: Editor) {
	const blocks: Array<{ type: string; from: number; to: number; text: string }> = [];
	editor.state.doc.descendants((node, pos) => {
		if (!node.isTextblock) return true;
		blocks.push({ type: node.type.name, from: pos + 1, to: pos + 1 + node.content.size, text: node.textContent });
		return false;
	});
	return blocks;
}

const FIND_SCHEMA_PROPERTIES = {
	matchCase: { type: 'boolean', description: 'Case-sensitive match (default false).' },
	wholeWord: { type: 'boolean', description: 'Match whole words only (default false).' },
	regex: {
		type: 'boolean',
		description: 'Treat the query as a JavaScript regular expression (default false: literal text).'
	}
} as const;

const CONTEXT_CHARS = 30;

/** Runs a literal (or regex) search; throws a tool error for an invalid pattern. */
function findMatches(
	editor: Editor,
	query: string,
	args: { matchCase?: boolean; wholeWord?: boolean; regex?: boolean },
	replacement?: string
): { matches: FindMatch[]; truncated: boolean } {
	const options: FindOptions = {
		matchCase: !!args.matchCase,
		wholeWord: !!args.wholeWord,
		...(args.regex ? { regex: true } : { literal: true })
	};
	const result = searchDocument(editor.state.doc, query, options, replacement !== undefined ? { replacement } : {});
	if (result.error) throw new Error(`Invalid search pattern: ${result.error.message}`);
	return { matches: result.matches, truncated: result.truncated };
}

/**
 * Tools for a mounted rich-text editor: `get_text` and `find_text` (always),
 * plus `insert_text`, `replace_text`, `replace_range`, `replace_selection` and
 * `set_selection` while the editor is editable, `edit_table` when the
 * schema has tables (`createRichTextPreset`'s `table`), and the chart tools
 * (`list_document_charts`; `insert_chart`, `update_chart_in_document` and
 * `insert_sparkline` while editable) when it has charts (`chart`).
 * Positions are ProseMirror document positions (as in `selection.from`), not
 * plain-text offsets; `find_text` and `get_text {blocks: true}` return them.
 * The provider re-announces its tool list when editability changes and
 * exposes no tools once the editor is destroyed.
 */
export function createRichTextToolProvider(
	target: RichTextToolTarget,
	options: ToolProviderOptions
): AgentToolProvider {
	const editor = () => toEditor(target);
	const charts = createDocumentChartTools(editor);

	const getText: AgentTool = {
		name: 'get_text',
		title: 'Get document text',
		description:
			'Returns the document content (plain text by default, or HTML / markdown), the current selection and the document size. ' +
			'Editing tools take document positions, not text offsets: pass `blocks: true` to get every paragraph with the positions ' +
			'its text spans, or use find_text to get the positions of a phrase.',
		inputSchema: {
			type: 'object',
			properties: {
				format: {
					type: 'string',
					enum: ['text', 'html', 'markdown'],
					description: 'Content format (default: text).'
				},
				blocks: {
					type: 'boolean',
					description: 'Also return `blocks`: each paragraph/heading/cell as {type, from, to, text} (default false).'
				}
			},
			additionalProperties: false
		},
		annotations: {
			title: 'Get document text',
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		},
		handler: ({ format = 'text', blocks = false }) => {
			const ed = editor();
			const content =
				format === 'html' ? ed.getHTML() : format === 'markdown' ? getEditorMarkdown(ed) : getEditorText(ed);
			return {
				format,
				content,
				selection: selectionInfo(ed),
				size: ed.state.doc.content.size,
				...(blocks ? { blocks: textBlocks(ed) } : {})
			};
		}
	};

	const insertText: AgentTool = {
		name: 'insert_text',
		title: 'Insert text',
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
		annotations: {
			title: 'Insert text',
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false
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

	const findText: AgentTool = {
		name: 'find_text',
		title: 'Find text',
		description:
			'Finds a phrase (literal by default) and returns each match with its document positions {from, to}, ' +
			'ready for replace_range, insert_text `at` or set_selection, plus surrounding context.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', minLength: 1, description: 'Text (or regex) to find.' },
				...FIND_SCHEMA_PROPERTIES,
				maxResults: { type: 'integer', minimum: 1, maximum: 500, description: 'Matches returned (default 50).' }
			},
			required: ['query'],
			additionalProperties: false
		},
		annotations: {
			title: 'Find text',
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		},
		handler: ({ query, maxResults = 50, ...flags }) => {
			const ed = editor();
			const { doc } = ed.state;
			const { matches, truncated } = findMatches(ed, query, flags);
			return {
				total: matches.length,
				truncated: truncated || matches.length > maxResults,
				matches: matches.slice(0, maxResults).map((m) => ({
					from: m.from,
					to: m.to,
					text: m.text,
					before: doc.textBetween(Math.max(0, m.from - CONTEXT_CHARS), m.from, '\n', ' '),
					after: doc.textBetween(m.to, Math.min(doc.content.size, m.to + CONTEXT_CHARS), '\n', ' ')
				}))
			};
		}
	};

	const replaceText: AgentTool = {
		name: 'replace_text',
		title: 'Find and replace',
		description:
			'Replaces occurrences of a phrase with literal text in one undoable step, keeping the found text\'s formatting. ' +
			'Replaces every occurrence by default, or only the n-th with `occurrence`. Fails when nothing matches.',
		inputSchema: {
			type: 'object',
			properties: {
				find: { type: 'string', minLength: 1, description: 'Text (or regex) to find.' },
				replace: { type: 'string', description: 'Replacement text (literal; an empty string deletes the matches).' },
				...FIND_SCHEMA_PROPERTIES,
				occurrence: {
					type: 'integer',
					minimum: 1,
					description: 'Only replace the n-th match (1-based, in document order). Default: all matches.'
				}
			},
			required: ['find', 'replace'],
			additionalProperties: false
		},
		annotations: {
			title: 'Find and replace',
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false
		},
		handler: ({ find, replace, occurrence, ...flags }) => {
			const ed = editor();
			const { matches } = findMatches(ed, find, flags);
			if (matches.length === 0) throw new Error(`No match for ${JSON.stringify(find)}.`);
			if (occurrence !== undefined && occurrence > matches.length) {
				throw new Error(`Occurrence ${occurrence} requested, but there are only ${matches.length} matches.`);
			}
			// The replacement is literal text: `\r` / `\n` split paragraphs / insert line breaks.
			const chosen = (occurrence !== undefined ? [matches[occurrence - 1]] : matches).map((m) => ({
				...m,
				replacement: String(replace).replace(/\r\n?|\n/g, '\r')
			}));
			const tr = ed.state.tr;
			const ends = applyReplacements(tr, chosen);
			ed.view.dispatch(tr.scrollIntoView());
			return {
				replaced: chosen.length,
				total: matches.length,
				ranges: chosen.map((m, i) => ({ from: tr.mapping.map(m.from, -1), to: ends[i] })),
				selection: selectionInfo(ed)
			};
		}
	};

	const replaceRange: AgentTool = {
		name: 'replace_range',
		title: 'Replace a range',
		description:
			'Replaces the content between two document positions (from get_text `blocks` or find_text) with literal text. ' +
			'from === to inserts; an empty text deletes.',
		inputSchema: {
			type: 'object',
			properties: {
				from: { type: 'integer', minimum: 0, description: 'Start document position.' },
				to: { type: 'integer', minimum: 0, description: 'End document position.' },
				text: { type: 'string', description: 'Replacement text (newlines start new paragraphs).' }
			},
			required: ['from', 'to', 'text'],
			additionalProperties: false
		},
		annotations: {
			title: 'Replace a range',
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false
		},
		handler: ({ from, to, text }) => {
			const ed = editor();
			checkRange(ed, from, to);
			replaceWithText(ed, from, to, text);
			return { replaced: { from, to }, selection: selectionInfo(ed), size: ed.state.doc.content.size };
		}
	};

	const setSelection: AgentTool = {
		name: 'set_selection',
		title: 'Set the selection',
		description: 'Selects the content between two document positions (from === to places the cursor).',
		inputSchema: {
			type: 'object',
			properties: {
				from: { type: 'integer', minimum: 0, description: 'Start document position.' },
				to: { type: 'integer', minimum: 0, description: 'End document position (default: from).' }
			},
			required: ['from'],
			additionalProperties: false
		},
		annotations: {
			title: 'Set the selection',
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		},
		handler: ({ from, to = from }) => {
			const ed = editor();
			checkRange(ed, from, to);
			const { doc } = ed.state;
			ed.view.dispatch(ed.state.tr.setSelection(TextSelection.between(doc.resolve(from), doc.resolve(to))));
			return { selection: selectionInfo(ed) };
		}
	};

	const replaceSelection: AgentTool = {
		name: 'replace_selection',
		title: 'Replace selection',
		description: 'Replaces the selected content with literal text (an empty string deletes the selection).',
		inputSchema: {
			type: 'object',
			properties: { text: { type: 'string', description: 'Replacement text.' } },
			required: ['text'],
			additionalProperties: false
		},
		annotations: {
			title: 'Replace selection',
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false
		},
		handler: ({ text }) => {
			const ed = editor();
			const { from, to } = ed.state.selection;
			replaceWithText(ed, from, to, text);
			return { replaced: { from, to }, selection: selectionInfo(ed) };
		}
	};

	const editTable: AgentTool = {
		name: 'edit_table',
		title: 'Edit tables',
		description:
			'Inserts a table or edits the table at the cursor (or at `at`): add/delete rows and columns, delete the table, ' +
			'merge/split cells, toggle header row/column/cell, move between cells, set cell alignment or background. ' +
			'Returns the table size and the cursor cell afterwards.',
		inputSchema: {
			type: 'object',
			properties: {
				operation: { type: 'string', enum: TABLE_ACTIONS.map((a) => a.action), description: 'Table operation.' },
				at: { type: 'integer', minimum: 0, description: 'Document position to place the cursor first (e.g. inside a cell).' },
				rows: { type: 'integer', minimum: 1, maximum: 100, description: 'insertTable: rows (default 3).' },
				cols: { type: 'integer', minimum: 1, maximum: 50, description: 'insertTable: columns (default 3).' },
				withHeaderRow: { type: 'boolean', description: 'insertTable: first row is a header row (default true).' },
				align: {
					type: ['string', 'null'],
					enum: ['left', 'center', 'right', 'justify', null],
					description: 'setCellAlignment: alignment, or null to clear.'
				},
				color: { type: ['string', 'null'], description: 'setCellBackground: CSS color, or null to clear.' }
			},
			required: ['operation'],
			additionalProperties: false
		},
		annotations: {
			title: 'Edit tables',
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false
		},
		handler: ({ operation, at, ...params }) => {
			const ed = editor();
			if (at !== undefined) {
				const size = ed.state.doc.content.size;
				if (at > size) throw new Error(`Position ${at} is outside the document (size ${size}).`);
				ed.view.dispatch(ed.state.tr.setSelection(TextSelection.near(ed.state.doc.resolve(at))));
			}
			const action = operation as TableAction;
			const state = getTableActionState(ed, action, params);
			if (state !== true) throw new Error(state);
			runTableAction(ed, action, params);
			const table = getTableState(ed);
			return {
				operation,
				table: table.inTable
					? { rows: table.rows, columns: table.columns, row: table.row, column: table.column }
					: null,
				selection: selectionInfo(ed)
			};
		}
	};

	return {
		id: options.id,
		namespace: options.namespace,
		tools: () => {
			const ed = editor();
			if (!ed || ed.isDestroyed) return [];
			if (!ed.isEditable) return [getText, findText, ...charts.read()];
			const tools = [getText, findText, insertText, replaceText, replaceRange, replaceSelection, setSelection];
			return [...tools, ...(isTableEnabled(ed) ? [editTable] : []), ...charts.read(), ...charts.write()];
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

const COLUMN_REGEX = /^[A-Za-z]{1,3}$/;

function parseColumn(name: string): number {
	if (!COLUMN_REGEX.test(name.trim())) throw new Error(`Invalid column "${name}". Use a letter name, e.g. "C".`);
	return colNameToIndex(name.trim().toUpperCase());
}

const CELL_INPUT = { type: ['string', 'number', 'boolean', 'null'] } as const;

/**
 * Tools for a spreadsheet controller: `get_range` (A1 notation, values and raw
 * input), `set_cell` and `set_range` (raw input; values starting with `=` are
 * formulas; `set_range` writes a whole block as one undo step), and
 * `insert_rows` / `delete_rows` / `insert_columns` / `delete_columns`
 * (formula references shift like a user edit).
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
		title: 'Read cells',
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
		annotations: {
			title: 'Read cells',
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		},
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
		title: 'Set a cell',
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
		annotations: {
			title: 'Set a cell',
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false
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

	const isReadOnly = (row: number, col: number) => {
		const found = lookup(row, col);
		if (!found) return false;
		const { rowDef, colDef } = found;
		return !!(colDef.readOnly || colDef.type === 'formula' || controller.getCell(rowDef.id, colDef.id).readOnly);
	};

	const setRange: AgentTool = {
		name: 'set_range',
		title: 'Set a block of cells',
		description:
			'Writes a 2D block of raw inputs starting at a cell (A1 notation), row by row, as one undo step. ' +
			'Values starting with "=" are formulas; null or "" clears a cell. The sheet grows to fit. Fails without writing ' +
			'anything if any target cell is read-only.',
		inputSchema: {
			type: 'object',
			properties: {
				start: { type: 'string', description: 'Top-left cell, e.g. "A1".' },
				values: {
					type: 'array',
					minItems: 1,
					maxItems: 10000,
					items: { type: 'array', items: CELL_INPUT, maxItems: 1000 },
					description: 'Rows of raw cell inputs, e.g. [["Name", "Total"], ["A", "=B3*2"]].'
				}
			},
			required: ['start', 'values'],
			additionalProperties: false
		},
		annotations: {
			title: 'Set a block of cells',
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false
		},
		handler: ({ start, values }) => {
			const { row, col } = parseCell(start);
			const rows = values as Array<Array<string | number | boolean | null>>;
			const readOnly: string[] = [];
			rows.forEach((line, r) =>
				line.forEach((_, c) => {
					if (isReadOnly(row + r, col + c)) readOnly.push(`${indexToColName(col + c)}${row + r + 1}`);
				})
			);
			if (readOnly.length) throw new Error(`Read-only cells: ${readOnly.slice(0, 20).join(', ')}. Nothing was written.`);
			controller.importRows(
				rows.map((line) => line.map((v) => (v === null ? '' : String(v)))),
				{ startRow: row, startCol: col }
			);
			const width = Math.max(0, ...rows.map((line) => line.length));
			const end = `${indexToColName(col + Math.max(width, 1) - 1)}${row + rows.length}`;
			const errors: Array<{ cell: string; error: string }> = [];
			rows.forEach((line, r) =>
				line.forEach((_, c) => {
					const found = lookup(row + r, col + c);
					if (!found) return;
					const cell = controller.getCell(found.rowDef.id, found.colDef.id);
					const error = cell.error ?? (isFormulaError(cell.value) ? cell.value : undefined);
					if (error) errors.push({ cell: `${indexToColName(col + c)}${row + r + 1}`, error: String(error) });
				})
			);
			return {
				range: `${indexToColName(col)}${row + 1}:${end}`,
				written: rows.reduce((n, line) => n + line.length, 0),
				errors,
				sheet: { rows: controller.document.rows.length, columns: controller.document.columns.length }
			};
		}
	};

	const COUNT = { type: 'integer', minimum: 1, maximum: 1000, description: 'How many (default 1).' } as const;
	const sheetSize = () => ({ rows: controller.document.rows.length, columns: controller.document.columns.length });
	const structural = (
		name: string,
		title: string,
		description: string,
		properties: Record<string, unknown>,
		required: string[],
		destructive: boolean,
		handler: AgentTool['handler']
	): AgentTool => ({
		name,
		title,
		description,
		inputSchema: { type: 'object', properties: properties as never, required, additionalProperties: false },
		annotations: { title, readOnlyHint: false, destructiveHint: destructive, idempotentHint: false, openWorldHint: false },
		handler
	});

	const insertRows = structural(
		'insert_rows',
		'Insert rows',
		'Inserts empty rows before a row number (1-based; one past the last row appends). References below shift down.',
		{ before: { type: 'integer', minimum: 1, description: 'Row number to insert before.' }, count: COUNT },
		['before'],
		false,
		({ before, count = 1 }) => {
			const index = before - 1;
			if (index > controller.document.rows.length) throw new Error(`Row ${before} is past the end of the sheet (${controller.document.rows.length} rows).`);
			for (let i = 0; i < count; i++) controller.insertRow(index);
			return { inserted: count, rows: `${before}:${before + count - 1}`, sheet: sheetSize() };
		}
	);
	const deleteRows = structural(
		'delete_rows',
		'Delete rows',
		'Deletes rows starting at a row number (1-based) with their contents. References below shift up; references to deleted cells become #REF!.',
		{ start: { type: 'integer', minimum: 1, description: 'First row number to delete.' }, count: COUNT },
		['start'],
		true,
		({ start, count = 1 }) => {
			const rows = controller.document.rows.slice(start - 1, start - 1 + count);
			if (rows.length < count) throw new Error(`Rows ${start}-${start + count - 1} are not all in the sheet (${controller.document.rows.length} rows).`);
			for (const row of rows) controller.deleteRow(row.id);
			return { deleted: count, sheet: sheetSize() };
		}
	);
	const insertColumns = structural(
		'insert_columns',
		'Insert columns',
		'Inserts empty columns before a column letter (one past the last column appends). References to the right shift.',
		{ before: { type: 'string', description: 'Column letter to insert before, e.g. "C".' }, count: COUNT },
		['before'],
		false,
		({ before, count = 1 }) => {
			const index = parseColumn(before);
			if (index > controller.document.columns.length) throw new Error(`Column ${before} is past the end of the sheet (${controller.document.columns.length} columns).`);
			for (let i = 0; i < count; i++) controller.insertColumn(index);
			return { inserted: count, columns: `${indexToColName(index)}:${indexToColName(index + count - 1)}`, sheet: sheetSize() };
		}
	);
	const deleteColumns = structural(
		'delete_columns',
		'Delete columns',
		'Deletes columns starting at a column letter with their contents. References to the right shift left; references to deleted cells become #REF!.',
		{ start: { type: 'string', description: 'First column letter to delete, e.g. "C".' }, count: COUNT },
		['start'],
		true,
		({ start, count = 1 }) => {
			const index = parseColumn(start);
			const columns = controller.document.columns.slice(index, index + count);
			if (columns.length < count) throw new Error(`Columns from ${start} (${count}) are not all in the sheet (${controller.document.columns.length} columns).`);
			for (const column of columns) controller.deleteColumn(column.id);
			return { deleted: count, sheet: sheetSize() };
		}
	);

	return {
		id: options.id,
		namespace: options.namespace,
		tools: [getRange, setCell, setRange, insertRows, deleteRows, insertColumns, deleteColumns]
	};
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
	/**
	 * `split` (default): one strictly typed tool per operation (`canvas_add_node`,
	 * `canvas_connect`, ..., `prompt_insert_text`, ...). `combined`: the
	 * `edit_canvas` / `edit_prompt` tools with an `operation` argument.
	 */
	toolStyle?: 'split' | 'combined';
	/** Which edit tools to expose (default both). */
	surfaces?: { canvas?: boolean; prompt?: boolean };
}

/** Describes which arguments a combined `edit_*` call is missing. */
function missingArgumentsMessage(name: 'edit_canvas' | 'edit_prompt', args: Record<string, any>): string {
	const required = EDIT_OPERATION_REQUIRED_ARGUMENTS[name][args.operation as string];
	if (!required) return `Unknown operation "${args.operation}".`;
	const missing = required.filter((key) =>
		key === 'id' ? args.id === undefined && args.node?.id === undefined : args[key] === undefined
	);
	return missing.length
		? `Operation "${args.operation}" requires ${required.join(', ')}; missing: ${missing.join(', ')}.`
		: `Operation "${args.operation}" has invalid arguments (expected ${required.join(', ')} with the types in the schema).`;
}

/** What a set of applied steps created, so the agent can refer to it next. */
function describeSteps<TNode extends CanvasNode, TEdge extends CanvasEdge>(steps: AgentStep<TNode, TEdge>[]) {
	const nodes: Array<{ id: string; position: { x: number; y: number } }> = [];
	const edges: Array<{ id: string; source: string; target: string }> = [];
	for (const step of steps) {
		if (step.type === 'step:canvas_add_node') nodes.push({ id: step.node.id, position: step.node.position });
		if (step.type === 'step:canvas_add_edge') edges.push({ id: step.edge.id, source: step.edge.source, target: step.edge.target });
	}
	return {
		applied: steps.length,
		steps: steps.map((s) => s.type),
		...(nodes.length || edges.length ? { created: { nodes, edges } } : {})
	};
}

/**
 * Exposes the editor MCP tools (`get_editor_state`, the canvas and prompt
 * edit tools, and `view_editor` when `captureView` is given) through a
 * `ToolRegistry`. Edits are checked against the current snapshot
 * (`validateAgentCommand`: unknown node ids, duplicate ids, unordered ranges
 * are tool errors), planned with the planner and handed to `applySteps`.
 * Results list the ids of created nodes and edges.
 */
export function createEditorMcpToolProvider<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(options: EditorMcpToolProviderOptions<TNode, TEdge>): AgentToolProvider {
	const edit = (name: string) => async (args: Record<string, any>) => {
		const command = toolCallToAgentCommand<TNode, TEdge>(name, args);
		if (!command) {
			throw new Error(
				name === 'edit_canvas' || name === 'edit_prompt'
					? missingArgumentsMessage(name, args)
					: `Invalid arguments for "${name}".`
			);
		}
		const snapshot = options.getSnapshot();
		const problem = validateAgentCommand(command, snapshot);
		if (problem) throw new Error(problem);
		const steps = planAgentCommand(command, snapshot, options.plannerOptions);
		await options.applySteps(steps);
		return describeSteps(steps);
	};

	const canvas = options.surfaces?.canvas ?? true;
	const prompt = options.surfaces?.prompt ?? true;
	const editTools =
		options.toolStyle === 'combined'
			? [...(canvas ? [MCP_TOOL_EDIT_CANVAS] : []), ...(prompt ? [MCP_TOOL_EDIT_PROMPT] : [])]
			: [...(canvas ? EDITOR_CANVAS_TOOLS : []), ...(prompt ? EDITOR_PROMPT_TOOLS : [])];

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
		...editTools.map((definition) => ({ ...definition, handler: edit(definition.name) }))
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
