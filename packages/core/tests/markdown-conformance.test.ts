import { describe, it, expect, beforeAll } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { createRichTextPreset, getEditorMarkdown } from '../src';
import { createFormatCommands } from '../src/commands/format';

beforeAll(() => {
	const dom = new JSDOM();
	globalThis.document = dom.window.document as any;
	globalThis.window = dom.window as any;
	(globalThis as any).Node = dom.window.Node;
	(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
	globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(cb, 0) as any;
	globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.resolve(__dirname, '../../markdown-conformance/fixtures');
const fixtureFiles = fs.readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));

function setupCase(input: string) {
	const editor = new Editor({
		extensions: createRichTextPreset({
			markdown: true,
			headingLevels: [1, 2, 3, 4, 5, 6]
		}),
		content: input
	});

	// Find markers in document
	let caretPos: number | null = null;
	let rangeStartPos: number | null = null;
	let rangeEndPos: number | null = null;

	editor.state.doc.descendants((node, pos) => {
		if (node.isText && node.text) {
			const caretIdx = node.text.indexOf('‸');
			if (caretIdx !== -1) {
				caretPos = pos + caretIdx;
			}
			const openIdx = node.text.indexOf('⟦');
			if (openIdx !== -1) {
				rangeStartPos = pos + openIdx;
			}
			const closeIdx = node.text.indexOf('⟧');
			if (closeIdx !== -1) {
				rangeEndPos = pos + closeIdx;
			}
		}
	});

	const tr = editor.state.tr;
	if (caretPos !== null) {
		tr.delete(caretPos, caretPos + 1);
		tr.setSelection(TextSelection.create(tr.doc, caretPos));
	} else if (rangeStartPos !== null && rangeEndPos !== null) {
		tr.delete(rangeEndPos, rangeEndPos + 1);
		tr.delete(rangeStartPos, rangeStartPos + 1);
		const targetTo = rangeEndPos - 1;
		tr.setSelection(TextSelection.create(tr.doc, rangeStartPos, targetTo));
	}
	editor.view.dispatch(tr);

	return editor;
}

function serializeWithSelection(editor: Editor): string {
	const { selection, doc } = editor.state;
	const serializer = (editor.storage as any).markdown?.serializer;

	if (doc.textContent === '') {
		return '‸';
	}

	const OPEN = 'ZCONFOPENZ';
	const CLOSE = 'ZCONFCLOSEZ';
	const CARET = 'ZCONFCARETZ';

	const tr = editor.state.tr;
	const schema = editor.state.schema;

	if (selection.empty) {
		const marks = doc.resolve(selection.from).marks();
		tr.insert(selection.from, schema.text(CARET, marks));
	} else {
		const openMarks = doc.resolve(selection.from + 1).marks();
		const closeMarks = doc.resolve(selection.to).marks();
		tr.insert(selection.to, schema.text(CLOSE, closeMarks));
		tr.insert(selection.from, schema.text(OPEN, openMarks));
	}

	let serialized = '';
	if (serializer && typeof serializer.serialize === 'function') {
		serialized = serializer.serialize(tr.doc).trimEnd();
	} else {
		serialized = getEditorMarkdown(editor).trimEnd();
	}

	return serialized
		.replaceAll(OPEN, '⟦')
		.replaceAll(CLOSE, '⟧')
		.replaceAll(CARET, '‸');
}

function executeCase(editor: Editor, commandId: string, params?: Record<string, any>) {
	if (commandId.startsWith('format.')) {
		const commands = createFormatCommands(editor, { focus: false });
		const cmd = commands.find((c) => c.id === commandId);
		if (!cmd) throw new Error(`Unknown format command: ${commandId}`);
		cmd.run(null, params);
		return;
	}

	if (commandId === 'edit.newline') {
		editor.commands.enter();
		return;
	}

	if (commandId === 'edit.indent') {
		editor.commands.sinkListItem('listItem') || editor.commands.sinkListItem('taskItem');
		return;
	}

	if (commandId === 'edit.outdent') {
		editor.commands.liftListItem('listItem') || editor.commands.liftListItem('taskItem');
		return;
	}

	if (commandId === 'edit.backspace') {
		const { selection } = editor.state;
		if (!selection.empty) {
			editor.commands.deleteSelection();
			return;
		}
		const { $from } = selection;
		if ($from.parent.type.name === 'heading' && $from.parentOffset === 0) {
			editor.commands.setParagraph();
			return;
		}
		editor.commands.keyboardShortcut('Backspace');
		return;
	}

	throw new Error(`Unhandled command: ${commandId}`);
}

describe('markdown conformance runner', () => {
	for (const file of fixtureFiles) {
		const json = JSON.parse(fs.readFileSync(path.join(fixturesDir, file), 'utf-8'));
		describe(file, () => {
			for (const testCase of json.cases) {
				it(`executes ${testCase.id}`, () => {
					if (testCase.skip?.editor) {
						return;
					}
					const editor = setupCase(testCase.input);
					executeCase(editor, testCase.command, testCase.params);
					const actual = serializeWithSelection(editor);
					const expected = testCase.variants?.editor ?? testCase.expected;
					expect(actual).toBe(expected);
					editor.destroy();
				});
			}
		});
	}
});
