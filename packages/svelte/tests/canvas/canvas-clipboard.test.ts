import { describe, it, expect, vi } from 'vitest';
import {
	createCanvasClipboard,
	isValidCanvasNode,
	isValidUrl,
	isEventFromTextInput
} from '../../src/canvas/createCanvasClipboard.svelte.js';
import type { CanvasNode, CanvasEdge } from '../../src/canvas/types.js';

describe('createCanvasClipboard & Clipboard Utilities', () => {
	it('validates canvas nodes with isValidCanvasNode', () => {
		expect(isValidCanvasNode({ id: '1', position: { x: 10, y: 20 } })).toBe(true);
		expect(isValidCanvasNode({ id: 123, position: { x: 10, y: 20 } })).toBe(false);
		expect(isValidCanvasNode({ id: '1' })).toBe(false);
		expect(isValidCanvasNode(null)).toBe(false);
		expect(isValidCanvasNode('not a node')).toBe(false);
	});

	it('validates URLs with isValidUrl', () => {
		expect(isValidUrl('https://example.com')).toBe(true);
		expect(isValidUrl('http://localhost:5173/canvas')).toBe(true);
		expect(isValidUrl('not a url')).toBe(false);
		expect(isValidUrl('ftp://example.com')).toBe(false);
	});

	it('detects text input targets with isEventFromTextInput', () => {
		const inputEl = { tagName: 'INPUT' } as unknown as HTMLElement;
		const textareaEl = { tagName: 'TEXTAREA' } as unknown as HTMLElement;
		const contentEditableEl = { isContentEditable: true, tagName: 'DIV' } as unknown as HTMLElement;
		const canvasEl = { tagName: 'DIV', isContentEditable: false } as unknown as HTMLElement;

		expect(isEventFromTextInput({ target: inputEl })).toBe(true);
		expect(isEventFromTextInput({ target: textareaEl })).toBe(true);
		expect(isEventFromTextInput({ target: contentEditableEl })).toBe(true);
		expect(isEventFromTextInput({ target: canvasEl })).toBe(false);
		expect(isEventFromTextInput({ target: null })).toBe(false);
	});

	it('copies selected nodes into clipboardData JSON payload', () => {
		const clipboard = createCanvasClipboard();
		const mockClipboardData = {
			setData: vi.fn()
		};
		const mockEvent = {
			target: { tagName: 'DIV' },
			clipboardData: mockClipboardData,
			preventDefault: vi.fn()
		} as unknown as ClipboardEvent;

		const selectedNodes: CanvasNode[] = [{ id: 'n1', position: { x: 10, y: 20 }, data: {} }];
		const connectedEdges: CanvasEdge[] = [{ id: 'e1', source: 'n1', target: 'n2' }];

		const copied = clipboard.copySelectedNodes(selectedNodes, connectedEdges, mockEvent);
		expect(copied).toBe(true);
		expect(mockClipboardData.setData).toHaveBeenCalledWith(
			'application/json',
			expect.stringContaining('"id":"n1"')
		);
		expect(mockEvent.preventDefault).toHaveBeenCalled();
	});

	it('cuts selected nodes by calling onRemove callback', () => {
		const clipboard = createCanvasClipboard();
		const onRemove = vi.fn();
		const mockEvent = {
			target: { tagName: 'DIV' },
			clipboardData: { setData: vi.fn() },
			preventDefault: vi.fn()
		} as unknown as ClipboardEvent;

		const selectedNodes: CanvasNode[] = [{ id: 'n1', position: { x: 0, y: 0 }, data: {} }];

		const cut = clipboard.cutSelectedNodes(selectedNodes, undefined, onRemove, mockEvent);
		expect(cut).toBe(true);
		expect(onRemove).toHaveBeenCalledWith(selectedNodes);
	});

	it('handles paste of serialized node JSON with UUID remapping and offset', async () => {
		const onPasteNodes = vi.fn();
		const clipboard = createCanvasClipboard({ onPasteNodes });

		const originalNodes: CanvasNode[] = [
			{ id: 'orig-1', position: { x: 100, y: 100 }, data: { label: 'Node 1' } },
			{ id: 'orig-2', position: { x: 200, y: 200 }, data: { label: 'Node 2' } }
		];
		const originalEdges: CanvasEdge[] = [{ id: 'e-orig', source: 'orig-1', target: 'orig-2' }];

		const serializedPayload = JSON.stringify({
			version: 1,
			nodes: originalNodes,
			edges: originalEdges
		});

		const mockEvent = {
			target: { tagName: 'DIV' },
			clipboardData: {
				getData: (format: string) => (format === 'application/json' ? serializedPayload : ''),
				files: []
			},
			preventDefault: vi.fn()
		} as unknown as ClipboardEvent;

		const handled = await clipboard.handlePasteEvent(mockEvent);
		expect(handled).toBe(true);
		expect(onPasteNodes).toHaveBeenCalledTimes(1);

		const [pastedNodes, pastedEdges] = onPasteNodes.mock.calls[0];
		expect(pastedNodes).toHaveLength(2);
		expect(pastedNodes[0].id).not.toBe('orig-1');
		expect(pastedNodes[0].position.x).toBe(140); // 100 + 40
		expect(pastedNodes[0].position.y).toBe(140); // 100 + 40

		// Check edge remapping
		expect(pastedEdges).toHaveLength(1);
		expect(pastedEdges[0].source).toBe(pastedNodes[0].id);
		expect(pastedEdges[0].target).toBe(pastedNodes[1].id);
	});

	it('handles paste of plain text URLs', async () => {
		const onPasteUrl = vi.fn();
		const clipboard = createCanvasClipboard({ onPasteUrl });

		const mockEvent = {
			target: { tagName: 'DIV' },
			clipboardData: {
				getData: (format: string) => (format === 'text/plain' ? 'https://example.com/asset' : ''),
				files: []
			},
			preventDefault: vi.fn()
		} as unknown as ClipboardEvent;

		const handled = await clipboard.handlePasteEvent(mockEvent);
		expect(handled).toBe(true);
		expect(onPasteUrl).toHaveBeenCalledWith('https://example.com/asset');
	});

	it('handles paste of plain text', async () => {
		const onPasteText = vi.fn();
		const clipboard = createCanvasClipboard({ onPasteText });

		const mockEvent = {
			target: { tagName: 'DIV' },
			clipboardData: {
				getData: (format: string) => (format === 'text/plain' ? 'Sample text content' : ''),
				files: []
			},
			preventDefault: vi.fn()
		} as unknown as ClipboardEvent;

		const handled = await clipboard.handlePasteEvent(mockEvent);
		expect(handled).toBe(true);
		expect(onPasteText).toHaveBeenCalledWith('Sample text content');
	});
});

describe('createCanvasClipboard paste validation', () => {
	const pasteEvent = (payload: unknown) =>
		({
			target: { tagName: 'DIV' },
			clipboardData: {
				getData: (format: string) => (format === 'application/json' ? JSON.stringify(payload) : ''),
				files: []
			},
			preventDefault: vi.fn()
		}) as unknown as ClipboardEvent;

	it('rejects non-numeric positions', () => {
		expect(isValidCanvasNode({ id: 'a', position: { x: '1e3', y: 0 } })).toBe(false);
		expect(isValidCanvasNode({ id: 'a', position: { x: Infinity, y: 0 } })).toBe(false);
	});

	it('pastes nodes even when edges is not an array', async () => {
		const onPasteNodes = vi.fn();
		const onPasteText = vi.fn();
		const clipboard = createCanvasClipboard({ onPasteNodes, onPasteText });
		const handled = await clipboard.handlePasteEvent(
			pasteEvent({ version: 1, nodes: [{ id: 'a', position: { x: 0, y: 0 }, data: {} }], edges: 'nope' })
		);
		expect(handled).toBe(true);
		expect(onPasteNodes).toHaveBeenCalledTimes(1);
		expect(onPasteText).not.toHaveBeenCalled();
		expect(onPasteNodes.mock.calls[0][1]).toBeUndefined();
	});

	it('remaps parentId of pasted children to the pasted parent', async () => {
		const onPasteNodes = vi.fn();
		const clipboard = createCanvasClipboard({ onPasteNodes });
		await clipboard.handlePasteEvent(
			pasteEvent({
				version: 1,
				nodes: [
					{ id: 'group', position: { x: 100, y: 100 }, data: {} },
					{ id: 'child', parentId: 'group', position: { x: 10, y: 10 }, data: {} }
				]
			})
		);
		const [nodes] = onPasteNodes.mock.calls[0];
		expect(nodes[1].parentId).toBe(nodes[0].id);
		expect(nodes[1].parentId).not.toBe('group');
		expect(nodes[1].position).toEqual({ x: 10, y: 10 });
		expect(nodes[0].position).toEqual({ x: 140, y: 140 });
	});
});
