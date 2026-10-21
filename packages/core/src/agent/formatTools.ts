import type { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import type { Node as ProsemirrorNode, Schema } from '@tiptap/pm/model';
import { TextSelection, type Transaction } from '@tiptap/pm/state';
import type { AgentTool } from '../tools/registry.js';
import type { JsonSchema } from '../tools/schema.js';

const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** Inline marks `format_text` can switch on and off, by tool argument and schema mark name. */
const TOGGLE_MARKS = [
	['bold', 'bold', 'Bold (strong) text.'],
	['italic', 'italic', 'Italic (emphasis).'],
	['underline', 'underline', 'Underlined text.'],
	['strike', 'strike', 'Struck-through text.'],
	['code', 'code', 'Inline code (monospace; in most schemas it removes the other marks).'],
	['subscript', 'subscript', 'Subscript.'],
	['superscript', 'superscript', 'Superscript.']
] as const;

/** Block types `set_block_type` can make, by tool value, with what the schema needs for each. */
const BLOCK_TYPES = [
	['paragraph', 'paragraph', 'a plain paragraph (also takes the blocks out of lists, quotes and code blocks)'],
	['heading', 'heading', 'a heading of `level`'],
	['bullet_list', 'bulletList', 'items of a bulleted list'],
	['ordered_list', 'orderedList', 'items of a numbered list'],
	['task_list', 'taskList', 'items of a checklist'],
	['blockquote', 'blockquote', 'a quote'],
	['code_block', 'codeBlock', 'a code block (plain text: marks are dropped)']
] as const;

type BlockType = (typeof BLOCK_TYPES)[number][0];

const LIST_ITEMS: Record<string, string> = { bulletList: 'listItem', orderedList: 'listItem', taskList: 'taskItem' };
const UNSAFE_LINK = /^\s*(javascript|data|vbscript):/i;

const RANGE_PROPERTIES = {
	from: { type: 'integer', minimum: 0, description: 'Start document position (from find_text or get_text `blocks`). Default: the selection.' },
	to: { type: 'integer', minimum: 0, description: 'End document position. Default: the selection.' }
} as const;

/** The range a tool acts on: `from..to`, or the selection when both are omitted. */
function targetRange(editor: Editor, args: { from?: number; to?: number }, allowEmpty: boolean) {
	if ((args.from === undefined) !== (args.to === undefined)) throw new Error('Pass both "from" and "to", or neither to use the selection.');
	const { from, to } = args.from === undefined ? editor.state.selection : { from: args.from, to: args.to! };
	const size = editor.state.doc.content.size;
	if (from > to) throw new Error(`"from" (${from}) must not be after "to" (${to}).`);
	if (to > size) throw new Error(`Position ${to} is outside the document (size ${size}).`);
	if (!allowEmpty && from === to) {
		throw new Error('The range is empty: pass "from" and "to" around the text (find_text returns them), or select it first.');
	}
	return { from, to };
}

function checkEditable(editor: Editor) {
	if (!editor.isEditable) throw new Error('The document is read-only, so it cannot be formatted.');
}

/** Selects `range` for the commands, and at the end puts the user's selection back where it was. */
function selectionGuard(editor: Editor, range: { from: number; to: number }) {
	const before = editor.state.selection;
	return {
		select: ({ tr }: { tr: Transaction }) => {
			// Each tool call is its own undo step, however quickly calls follow each other.
			closeHistory(tr);
			tr.setSelection(TextSelection.between(tr.doc.resolve(range.from), tr.doc.resolve(range.to)));
			return true;
		},
		restore: ({ tr }: { tr: Transaction }) => {
			const anchor = tr.mapping.map(before.anchor);
			const head = tr.mapping.map(before.head);
			tr.setSelection(TextSelection.between(tr.doc.resolve(anchor), tr.doc.resolve(head)));
			return true;
		},
		/** The acted-on range in the changed document. */
		mapped: (tr: Transaction) => ({ from: tr.mapping.map(range.from, -1), to: tr.mapping.map(range.to, 1) })
	};
}

/** Textblocks overlapping a range, with their block type, wrapper and attributes. */
function blocksIn(doc: ProsemirrorNode, from: number, to: number) {
	const blocks: Array<Record<string, unknown>> = [];
	doc.nodesBetween(from, Math.max(to, from + 1), (node, pos, parent) => {
		if (!node.isTextblock) return true;
		const $pos = doc.resolve(pos + 1);
		let wrapper: string | undefined;
		for (let d = $pos.depth - 1; d > 0; d--) {
			const name = $pos.node(d).type.name;
			if (name === 'bulletList' || name === 'orderedList' || name === 'taskList' || name === 'blockquote') {
				wrapper = name;
				break;
			}
		}
		blocks.push({
			type: node.type.name,
			from: pos + 1,
			to: pos + 1 + node.content.size,
			text: node.textContent,
			...(node.attrs.level !== undefined ? { level: node.attrs.level } : {}),
			...(node.attrs.textAlign ? { align: node.attrs.textAlign } : {}),
			...(wrapper ? { in: wrapper } : {}),
			...(parent && parent.type.name === 'taskItem' ? { checked: !!parent.attrs.checked } : {})
		});
		return false;
	});
	return blocks;
}

/** Which marks are on every text character of a range. */
function marksOn(doc: ProsemirrorNode, schema: Schema, from: number, to: number) {
	const out: Record<string, unknown> = {};
	for (const [arg, mark] of TOGGLE_MARKS) {
		const type = schema.marks[mark];
		if (!type) continue;
		let all = true;
		let any = false;
		doc.nodesBetween(from, to, (node) => {
			if (!node.isText) return true;
			if (type.isInSet(node.marks)) any = true;
			else all = false;
			return false;
		});
		if (any) out[arg] = all ? true : 'partly';
	}
	const attrOf = (markName: string, attr: string) => {
		const values = new Set<unknown>();
		doc.nodesBetween(from, to, (node) => {
			if (!node.isText) return true;
			const mark = node.marks.find((m) => m.type.name === markName);
			values.add(mark ? (mark.attrs[attr] ?? null) : null);
			return false;
		});
		const [only] = values;
		return values.size === 1 ? only : values.size > 1 ? 'mixed' : null;
	};
	if (schema.marks.link) {
		const href = attrOf('link', 'href');
		if (href !== null) out.link = href;
	}
	if (schema.marks.highlight) {
		const color = attrOf('highlight', 'color');
		if (color !== null) out.highlight = color;
	}
	if (schema.marks.textStyle) {
		const color = attrOf('textStyle', 'color');
		if (color !== null) out.color = color;
		const size = attrOf('textStyle', 'fontSize');
		if (size !== null) out.fontSize = size;
	}
	return out;
}

/**
 * The formatting tools for a rich-text editor: `format_text` (inline marks), `set_block_type`
 * (paragraphs, headings, lists, quotes, code blocks) and `set_text_align`, each listed only when
 * the editor's schema has something for it to do. Each call is one undo step, leaves the
 * user's selection where it was, and returns the range it changed with its formatting after.
 */
export function createDocumentFormatTools(editor: () => Editor, changed: (ranges: Array<{ from: number; to: number }>) => void) {
	const formatText = (ed: Editor): AgentTool | null => {
		const { schema } = ed;
		const has = (name: string) => !!schema.marks[name];
		const hasAttr = (mark: string, attr: string) => !!schema.marks[mark]?.spec.attrs?.[attr];
		const properties: Record<string, JsonSchema> = { ...RANGE_PROPERTIES };
		for (const [arg, mark, what] of TOGGLE_MARKS) {
			if (has(mark)) properties[arg] = { type: 'boolean', description: `${what} true sets it, false clears it; omit to leave it.` };
		}
		if (has('link')) {
			properties.link = {
				type: ['string', 'null'],
				minLength: 1,
				description: 'Link the text to this URL (https://…, mailto:…), or null to remove links. Omit to leave links.'
			};
		}
		if (has('highlight')) {
			properties.highlight = {
				type: ['string', 'null'],
				minLength: 1,
				maxLength: 64,
				description: 'Highlight (background) colour as a CSS colour, e.g. "#fef08a" or "yellow", or null to remove it.'
			};
		}
		if (hasAttr('textStyle', 'color')) {
			properties.color = { type: ['string', 'null'], minLength: 1, maxLength: 64, description: 'Text colour as a CSS colour, or null for the default colour.' };
		}
		if (hasAttr('textStyle', 'fontSize')) {
			properties.fontSize = { type: ['string', 'null'], pattern: '^\\d+(\\.\\d+)?(px|pt|em|rem|%)$', description: 'Font size with a unit, e.g. "18px" or "1.25em", or null for the default size.' };
		}
		const formatting = Object.keys(properties).filter((k) => k !== 'from' && k !== 'to');
		if (formatting.length === 0) return null;

		return {
			name: 'format_text',
			title: 'Format text',
			description:
				`Sets or clears inline formatting on a range of text (or the selection): ${formatting.join(', ')}. ` +
				'Only the properties you pass change. Positions come from find_text or get_text `blocks`. One undo step; the selection is left where it was. ' +
				'Returns the `range` and the formatting now on it (`partly` / `mixed` where only some of the text has it). For headings and lists use set_block_type.',
			inputSchema: { type: 'object', properties, additionalProperties: false },
			annotations: { title: 'Format text', ...WRITE_IDEMPOTENT },
			handler: (args) => {
				const ed = editor();
				checkEditable(ed);
				const asked = formatting.filter((k) => args[k] !== undefined);
				if (asked.length === 0) throw new Error(`Pass at least one formatting property: ${formatting.join(', ')}.`);
				const range = targetRange(ed, args, false);
				if (typeof args.link === 'string' && UNSAFE_LINK.test(args.link)) {
					throw new Error('Links may not use javascript:, data: or vbscript: URLs. Nothing was changed.');
				}
				const guard = selectionGuard(ed, range);
				let tr: Transaction | null = null;
				let chain = ed.chain().command(guard.select);
				for (const [arg, mark] of TOGGLE_MARKS) {
					if (args[arg] === true) chain = chain.setMark(mark);
					else if (args[arg] === false) chain = chain.unsetMark(mark, { extendEmptyMarkRange: false });
				}
				if (args.link === null) chain = chain.unsetMark('link');
				else if (typeof args.link === 'string') chain = chain.setMark('link', { href: args.link.trim() });
				if (args.highlight === null) chain = chain.unsetMark('highlight');
				else if (typeof args.highlight === 'string') chain = chain.setMark('highlight', { color: args.highlight });
				const style: Record<string, unknown> = {};
				if (args.color !== undefined) style.color = args.color;
				if (args.fontSize !== undefined) style.fontSize = args.fontSize;
				if (Object.keys(style).length) {
					chain = chain.setMark('textStyle', style);
					if (Object.values(style).includes(null)) chain = chain.removeEmptyTextStyle();
				}
				chain
					.command((props) => {
						tr = props.tr;
						return guard.restore(props);
					})
					.run();
				const after = tr ? guard.mapped(tr) : range;
				changed([after]);
				const doc = ed.state.doc;
				return { range: after, text: doc.textBetween(after.from, after.to, '\n'), formatting: marksOn(doc, ed.schema, after.from, after.to) };
			}
		};
	};

	const blockTypes = (ed: Editor) => BLOCK_TYPES.filter(([, node]) => !!ed.schema.nodes[node] && (!LIST_ITEMS[node] || !!ed.schema.nodes[LIST_ITEMS[node]]));
	const headingLevels = (ed: Editor): number[] => {
		const ext = ed.extensionManager.extensions.find((e) => e.name === 'heading');
		return (ext?.options?.levels as number[] | undefined) ?? [1, 2, 3, 4, 5, 6];
	};

	const setBlockType = (ed: Editor): AgentTool | null => {
		const types = blockTypes(ed);
		if (types.length < 2) return null;
		const levels = ed.schema.nodes.heading ? headingLevels(ed) : [];
		return {
			name: 'set_block_type',
			title: 'Set the block type',
			description:
				'Turns every paragraph the range touches (or the one at the cursor) into ' +
				types.map(([value, , what]) => `${value} (${what})`).join(', ') +
				'. The blocks are first taken out of any list, quote or code block, so one call switches between kinds. One undo step; the selection is left where it was. ' +
				'Returns the resulting `blocks` with their type, positions, text, level, alignment and the list or quote they are in.',
			inputSchema: {
				type: 'object',
				properties: {
					...RANGE_PROPERTIES,
					type: { type: 'string', enum: types.map(([value]) => value), description: 'What the blocks become.' },
					...(levels.length
						? { level: { type: 'integer', enum: levels, description: `Heading level for type "heading" (${levels.join(', ')}; 1 is the largest).` } }
						: {})
				},
				required: ['type'],
				additionalProperties: false
			},
			annotations: { title: 'Set the block type', ...WRITE_IDEMPOTENT },
			handler: (args) => {
				const ed = editor();
				checkEditable(ed);
				const type = args.type as BlockType;
				if (type === 'heading' && args.level === undefined) throw new Error(`Pass a heading "level" (${levels.join(', ')}).`);
				if (type !== 'heading' && args.level !== undefined) throw new Error('"level" only applies to type "heading".');
				const range = targetRange(ed, args, true);
				const node = BLOCK_TYPES.find(([value]) => value === type)![1];
				const guard = selectionGuard(ed, range);
				let tr: Transaction | null = null;
				let chain = ed.chain().command(guard.select).clearNodes();
				if (type === 'heading') chain = chain.setNode('heading', { level: args.level });
				else if (type === 'code_block') chain = chain.setNode('codeBlock');
				else if (type === 'blockquote') chain = chain.wrapIn('blockquote');
				else if (LIST_ITEMS[node]) chain = chain.toggleList(node, LIST_ITEMS[node]);
				const ok = chain
					.command((props) => {
						tr = props.tr;
						return guard.restore(props);
					})
					.run();
				if (!ok || !tr) throw new Error(`Those blocks cannot become ${type} here (for example inside a table cell or a code block). Nothing was changed.`);
				const after = guard.mapped(tr);
				changed([after]);
				return { type, range: after, blocks: blocksIn(ed.state.doc, after.from, after.to) };
			}
		};
	};

	const setTextAlign = (ed: Editor): AgentTool | null => {
		const ext = ed.extensionManager.extensions.find((e) => e.name === 'textAlign');
		if (!ext) return null;
		const alignments = ((ext.options?.alignments as string[] | undefined) ?? ['left', 'center', 'right', 'justify']).slice();
		const types = (ext.options?.types as string[] | undefined) ?? ['heading', 'paragraph'];
		return {
			name: 'set_text_align',
			title: 'Align text',
			description:
				`Aligns every ${types.join(' and ')} the range touches (or the one at the cursor): ${alignments.join(', ')}, or null for the default. ` +
				'One undo step; the selection is left where it was. Returns the resulting `blocks` with their alignment.',
			inputSchema: {
				type: 'object',
				properties: {
					...RANGE_PROPERTIES,
					align: { type: ['string', 'null'], enum: [...alignments, null], description: 'The alignment, or null for the default (usually left).' }
				},
				required: ['align'],
				additionalProperties: false
			},
			annotations: { title: 'Align text', ...WRITE_IDEMPOTENT },
			handler: (args) => {
				const ed = editor();
				checkEditable(ed);
				const range = targetRange(ed, args, true);
				const blocks = blocksIn(ed.state.doc, range.from, range.to);
				if (!blocks.some((b) => types.includes(b.type as string))) {
					throw new Error(`Only ${types.join(' and ')} blocks can be aligned; the range has ${[...new Set(blocks.map((b) => b.type))].join(', ') || 'no text blocks'}.`);
				}
				const guard = selectionGuard(ed, range);
				let tr: Transaction | null = null;
				const chain = ed.chain().command(guard.select);
				(args.align === null ? chain.unsetTextAlign() : chain.setTextAlign(args.align))
					.command((props) => {
						tr = props.tr;
						return guard.restore(props);
					})
					.run();
				const after = tr ? guard.mapped(tr) : range;
				changed([after]);
				return { align: args.align, range: after, blocks: blocksIn(ed.state.doc, after.from, after.to) };
			}
		};
	};

	return {
		/** The formatting tools this editor's schema supports. */
		tools(ed: Editor): AgentTool[] {
			return [formatText(ed), setBlockType(ed), setTextAlign(ed)].filter((t): t is AgentTool => t !== null);
		}
	};
}
