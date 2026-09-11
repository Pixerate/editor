import { describe, it, expect, vi } from 'vitest';
import { createCanvasShortcuts } from '../createCanvasShortcuts.js';
import type { CanvasNode } from '../types.js';

describe('createCanvasShortcuts', () => {
	it('attaches listener, handles hotkeys, and cleans up', () => {
		const target = new EventTarget();
		const onDelete = vi.fn();
		const onDuplicate = vi.fn();
		const onSelectAll = vi.fn();

		const selectedNodes: CanvasNode[] = [{ id: 'node-1', position: { x: 0, y: 0 }, data: {} }];

		const destroy = createCanvasShortcuts({
			targetElement: target as unknown as HTMLElement,
			getSelectedNodes: () => selectedNodes,
			onDelete,
			onDuplicate,
			onSelectAll
		});

		// Trigger Backspace -> onDelete
		const deleteEvent = new CustomEvent('keydown', { cancelable: true });
		Object.assign(deleteEvent, { key: 'Backspace' });
		target.dispatchEvent(deleteEvent);

		expect(onDelete).toHaveBeenCalledWith(selectedNodes);

		// Trigger Meta + D -> onDuplicate
		const dupEvent = new CustomEvent('keydown', { cancelable: true });
		Object.assign(dupEvent, { key: 'd', metaKey: true });
		target.dispatchEvent(dupEvent);

		expect(onDuplicate).toHaveBeenCalledWith(selectedNodes);

		// Trigger Meta + A -> onSelectAll
		const allEvent = new CustomEvent('keydown', { cancelable: true });
		Object.assign(allEvent, { key: 'a', metaKey: true });
		target.dispatchEvent(allEvent);

		expect(onSelectAll).toHaveBeenCalledTimes(1);

		// Trigger shortcut while targeting an input -> should be ignored
		const inputEl = { tagName: 'INPUT' } as unknown as HTMLElement;
		const ignoredEvent = new CustomEvent('keydown', { cancelable: true });
		Object.defineProperty(ignoredEvent, 'target', { value: inputEl });
		Object.assign(ignoredEvent, { key: 'Backspace' });
		target.dispatchEvent(ignoredEvent);

		expect(onDelete).toHaveBeenCalledTimes(1); // Not called again

		// Destroy listeners
		destroy();

		// Dispatching after destroy should do nothing
		target.dispatchEvent(deleteEvent);
		expect(onDelete).toHaveBeenCalledTimes(1);
	});
});
