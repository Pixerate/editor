import { describe, it, expect } from 'vitest';
import { createCanvasMultiDrag } from '../../src/canvas/createCanvasMultiDrag.svelte.js';
import {
	getMarqueeSelectionPreset,
	handleDeselectOnEscape
} from '../../src/canvas/createCanvasSelection.svelte.js';
import type { CanvasNode } from '../../src/canvas/types.js';

describe('createCanvasMultiDrag & Selection Helpers', () => {
	const sampleNodes: CanvasNode[] = [
		{ id: 'node-lead', position: { x: 100, y: 100 }, data: {} },
		{ id: 'node-sub-1', position: { x: 100, y: 180 }, data: {} },
		{ id: 'node-sub-2', position: { x: 100, y: 260 }, data: {} }
	];

	it('returns null and does not activate multi-drag if only 1 node is selected', () => {
		const multiDrag = createCanvasMultiDrag();
		const state = multiDrag.startMultiDrag('node-lead', ['node-lead'], sampleNodes);

		expect(state).toBeNull();
		expect(multiDrag.isMultiDrag).toBe(false);
		expect(multiDrag.count).toBe(0);
	});

	it('computes relative follower offsets, stack fan-out, and rotational tilt for multi-selection', () => {
		const multiDrag = createCanvasMultiDrag({
			stackOffsetStepX: 5,
			stackOffsetStepY: 6,
			rotationAngles: [-2, 3]
		});

		const state = multiDrag.startMultiDrag(
			'node-lead',
			['node-lead', 'node-sub-1', 'node-sub-2'],
			sampleNodes
		);

		expect(state).not.toBeNull();
		expect(multiDrag.isMultiDrag).toBe(true);
		expect(multiDrag.count).toBe(3);
		expect(multiDrag.leadId).toBe('node-lead');

		// Check follower 1
		const f1 = multiDrag.getFollowerTransform('node-sub-1');
		expect(f1.isFollower).toBe(true);
		expect(f1.stackOffsetX).toBe(5);
		expect(f1.stackOffsetY).toBe(6);
		expect(f1.rotationDeg).toBe(-2);
		expect(f1.zIndex).toBe(49); // baseZIndex (50) - 1

		// Check follower 2
		const f2 = multiDrag.getFollowerTransform('node-sub-2');
		expect(f2.isFollower).toBe(true);
		expect(f2.stackOffsetX).toBe(10);
		expect(f2.stackOffsetY).toBe(12);
		expect(f2.rotationDeg).toBe(3);
		expect(f2.zIndex).toBe(48); // baseZIndex (50) - 2

		// Non-follower check
		const fLead = multiDrag.getFollowerTransform('node-lead');
		expect(fLead.isFollower).toBe(false);
	});

	it('restores original positions upon drag cancellation', () => {
		const multiDrag = createCanvasMultiDrag();
		multiDrag.startMultiDrag(
			'node-lead',
			['node-lead', 'node-sub-1'],
			sampleNodes
		);

		let restoredItems: any[] = [];
		const restores = multiDrag.cancelMultiDrag((items) => {
			restoredItems = items;
		});

		expect(restores).toHaveLength(1);
		expect(restores[0].id).toBe('node-sub-1');
		expect(restores[0].originalPosition).toEqual({ x: 100, y: 180 });
		expect(restoredItems).toEqual(restores);
		expect(multiDrag.isMultiDrag).toBe(false);
	});

	it('generates marquee selection preset with spacebar panning awareness', () => {
		const normalPreset = getMarqueeSelectionPreset({ isSpacebarPanning: false });
		expect(normalPreset.selectionOnDrag).toBe(true);
		expect(normalPreset.panOnDrag).toEqual([1, 2]);

		const panPreset = getMarqueeSelectionPreset({ isSpacebarPanning: true });
		expect(panPreset.selectionOnDrag).toBe(false);
		expect(panPreset.panOnDrag).toEqual([0, 1, 2]);
	});

	it('handles deselect on Escape key press', () => {
		let deselected = false;
		const handled = handleDeselectOnEscape(
			{ key: 'Escape', code: 'Escape' } as KeyboardEvent,
			() => {
				deselected = true;
			}
		);

		expect(handled).toBe(true);
		expect(deselected).toBe(true);

		const ignored = handleDeselectOnEscape(
			{ key: 'Enter', code: 'Enter' } as KeyboardEvent,
			() => {}
		);
		expect(ignored).toBe(false);
	});
});
