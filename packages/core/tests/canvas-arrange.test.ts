import { describe, it, expect, vi } from 'vitest';
import {
	alignNodes,
	applyNodeUpdates,
	computeSnapGuides,
	createCanvasArrangeController,
	createCanvasScenesStore,
	createGuideIndex,
	createNodeGuideIndex,
	distributeNodes,
	findConnectorSnap,
	fitViewportToNodes,
	fitViewportToRect,
	getAbsolutePosition,
	getNodeRect,
	getNodeSize,
	invertNodeUpdates,
	isLocked,
	lockNodes,
	matchArrangeShortcut,
	matchSize,
	nearestHandlePositions,
	parseCanvasScenes,
	positionToSide,
	readStyleSize,
	reorderNodes,
	sideToPosition,
	snapNodeDrag,
	toggleLockNodes,
	unlockNodes,
	withStyleSize,
	createNodeLookup,
	type CanvasNode,
	type Rect
} from '../src/canvas';
import { HistoryManager } from '../src/history';

const node = (id: string, x: number, y: number, width = 100, height = 50, extra: Partial<CanvasNode> = {}): CanvasNode => ({
	id,
	position: { x, y },
	data: { label: id },
	width,
	height,
	...extra
});

const byId = (nodes: CanvasNode[]) => Object.fromEntries(nodes.map((n) => [n.id, n]));

describe('canvas arrange: node geometry', () => {
	it('prefers measured size, then width/height, then style, then estimation', () => {
		expect(getNodeSize({ id: 'a', position: { x: 0, y: 0 }, data: {}, measured: { width: 10, height: 20 }, width: 99 })).toEqual({ width: 10, height: 20 });
		expect(getNodeSize({ id: 'a', position: { x: 0, y: 0 }, data: {}, width: 30, height: 40 })).toEqual({ width: 30, height: 40 });
		expect(getNodeSize({ id: 'a', position: { x: 0, y: 0 }, data: {}, style: 'color: red; width: 120px; height: 80px' })).toEqual({ width: 120, height: 80 });
		expect(getNodeSize({ id: 'a', position: { x: 0, y: 0 }, data: {}, style: { width: 140, height: '90px' } })).toEqual({ width: 140, height: 90 });
		const estimated = getNodeSize({ id: 'a', position: { x: 0, y: 0 }, data: { label: 'x'.repeat(40) } });
		expect(estimated.width).toBeGreaterThan(200);
		expect(getNodeSize({ id: 'a', position: { x: 0, y: 0 }, data: {} }, { estimate: false, defaultWidth: 7, defaultHeight: 8 })).toEqual({ width: 7, height: 8 });
	});

	it('reads and rewrites style sizes in both string and object form', () => {
		expect(readStyleSize('width: 50%')).toEqual({ width: undefined, height: undefined });
		expect(withStyleSize('opacity: 1; width: 10px; height: 20px;', { width: 30 })).toBe('opacity: 1; width: 30px; height: 20px;');
		expect(withStyleSize({ width: 10, color: 'red' }, { width: 30, height: 40 })).toEqual({ width: 30, color: 'red' });
		expect(withStyleSize(undefined, { width: 30 })).toBeUndefined();
	});

	it('resolves absolute positions through parentId chains and tolerates cycles', () => {
		const nodes = [node('p', 100, 100), node('c', 10, 20, 50, 50, { parentId: 'p' }), node('g', 1, 2, 10, 10, { parentId: 'c' })];
		const lookup = createNodeLookup(nodes);
		expect(getAbsolutePosition(nodes[2], lookup)).toEqual({ x: 111, y: 122 });
		expect(getNodeRect(nodes[1], lookup)).toEqual({ x: 110, y: 120, width: 50, height: 50 });
		const cyclic = [node('a', 1, 1, 10, 10, { parentId: 'b' }), node('b', 2, 2, 10, 10, { parentId: 'a' })];
		expect(getAbsolutePosition(cyclic[0], createNodeLookup(cyclic))).toEqual({ x: 3, y: 3 });
	});
});

describe('canvas arrange: alignNodes', () => {
	const nodes = [node('a', 0, 0, 100, 50), node('b', 50, 100, 200, 80), node('c', 300, 40, 50, 50)];

	it.each([
		['left', { a: 0, b: 0, c: 0 }],
		['right', { a: 250, b: 150, c: 300 }],
		['center', { a: 125, b: 75, c: 150 }]
	] as const)('aligns %s', (edge, expected) => {
		const result = byId(applyNodeUpdates(nodes, alignNodes(nodes, ['a', 'b', 'c'], edge)));
		expect(result.a.position.x).toBe(expected.a);
		expect(result.b.position.x).toBe(expected.b);
		expect(result.c.position.x).toBe(expected.c);
	});

	it.each([
		['top', { a: 0, b: 0, c: 0 }],
		['bottom', { a: 130, b: 100, c: 130 }],
		['middle', { a: 65, b: 50, c: 65 }]
	] as const)('aligns %s', (edge, expected) => {
		const result = byId(applyNodeUpdates(nodes, alignNodes(nodes, ['a', 'b', 'c'], edge)));
		expect(result.a.position.y).toBe(expected.a);
		expect(result.b.position.y).toBe(expected.b);
		expect(result.c.position.y).toBe(expected.c);
	});

	it('does nothing for zero or one node, unknown ids, or already aligned nodes', () => {
		expect(alignNodes(nodes, [], 'left')).toEqual([]);
		expect(alignNodes(nodes, ['a'], 'left')).toEqual([]);
		expect(alignNodes(nodes, ['zzz', 'a'], 'left')).toEqual([]);
		expect(alignNodes(nodes, ['a', 'b'], 'top').map((u) => u.id)).toEqual(['b']);
	});

	it('aligns a single node to a fixed rectangle', () => {
		expect(alignNodes(nodes, ['a'], 'right', { to: { x: 0, y: 0, width: 1000, height: 10 } })).toEqual([
			{ id: 'a', position: { x: 900, y: 0 } }
		]);
	});

	it('never moves locked nodes but uses them as anchors', () => {
		const locked = lockNodes(nodes, ['c']);
		const updates = alignNodes(locked, ['a', 'c'], 'left');
		expect(updates).toEqual([]);
		const right = alignNodes(locked, ['a', 'c'], 'right');
		expect(right).toEqual([{ id: 'a', position: { x: 250, y: 0 } }]);
	});

	it('returns parent-relative positions for sub-flow children', () => {
		const tree = [node('p', 100, 100, 400, 400), node('c', 10, 10, 50, 50, { parentId: 'p' }), node('x', 0, 300, 50, 50)];
		const updates = alignNodes(tree, ['c', 'x'], 'left');
		// c is at absolute x=110, x is at 0 -> c moves to absolute 0 -> relative -100.
		expect(updates).toEqual([{ id: 'c', position: { x: -100, y: 10 } }]);
	});

	it('makes children relative to the parent\'s new position when both move', () => {
		const tree = [node('p', 100, 0, 100, 100), node('c', 0, 0, 100, 100, { parentId: 'p' }), node('x', 0, 300, 100, 100)];
		const result = applyNodeUpdates(tree, alignNodes(tree, ['p', 'c', 'x'], 'left'));
		const lookup = createNodeLookup(result);
		expect(getAbsolutePosition(lookup.get('p')!, lookup).x).toBe(0);
		expect(getAbsolutePosition(lookup.get('c')!, lookup).x).toBe(0);
	});
});

describe('canvas arrange: distributeNodes', () => {
	it('distributes with equal gaps between outer nodes', () => {
		const nodes = [node('a', 0, 0, 100), node('b', 120, 0, 50), node('c', 400, 0, 100)];
		const result = byId(applyNodeUpdates(nodes, distributeNodes(nodes, ['c', 'a', 'b'], 'horizontal')));
		// span 0..500, sizes 250 -> gap 125
		expect(result.a.position.x).toBe(0);
		expect(result.b.position.x).toBe(225);
		expect(result.c.position.x).toBe(400);
	});

	it('distributes centres equally', () => {
		const nodes = [node('a', 0, 0, 10, 100), node('b', 0, 100, 10, 10), node('c', 0, 300, 10, 100)];
		const result = byId(applyNodeUpdates(nodes, distributeNodes(nodes, ['a', 'b', 'c'], 'vertical', 'centres')));
		// centres 50 .. 350 -> middle 200 -> y = 195
		expect(result.b.position.y).toBe(195);
	});

	it('supports both axes and an explicit gap with two nodes', () => {
		const nodes = [node('a', 0, 0, 100, 100), node('b', 500, 500, 100, 100), node('c', 50, 450, 100, 100)];
		const both = byId(applyNodeUpdates(nodes, distributeNodes(nodes, ['a', 'b', 'c'], 'both')));
		expect(both.c.position).toEqual({ x: 250, y: 250 });
		const two = [node('a', 0, 0, 100), node('b', 500, 0, 100)];
		expect(distributeNodes(two, ['a', 'b'], 'horizontal', 'gaps', { gap: 20 })).toEqual([{ id: 'b', position: { x: 120, y: 0 } }]);
	});

	it('needs at least three nodes and skips locked ones', () => {
		const nodes = [node('a', 0, 0), node('b', 150, 0), node('c', 1000, 0)];
		expect(distributeNodes(nodes, [], 'horizontal')).toEqual([]);
		expect(distributeNodes(nodes, ['a', 'b'], 'horizontal')).toEqual([]);
		expect(distributeNodes(lockNodes(nodes, ['b']), ['a', 'b', 'c'], 'horizontal')).toEqual([]);
	});
});

describe('canvas arrange: matchSize', () => {
	const nodes = [node('a', 0, 0, 100, 50), node('b', 0, 0, 200, 20), node('c', 0, 0, 50, 80)];

	it('matches the largest by default, or smallest / first / a specific id', () => {
		expect(matchSize(nodes, ['a', 'b', 'c'], 'width')).toEqual([
			{ id: 'a', width: 200 },
			{ id: 'c', width: 200 }
		]);
		expect(matchSize(nodes, ['a', 'b', 'c'], 'height', { reference: 'smallest' }).map((u) => u.height)).toEqual([20, 20]);
		expect(matchSize(nodes, ['c', 'a'], 'both', { reference: 'first' })).toEqual([{ id: 'a', width: 50, height: 80 }]);
		expect(matchSize(nodes, ['a', 'b'], 'both', { reference: { id: 'a' } })).toEqual([{ id: 'b', width: 100, height: 50 }]);
	});

	it('keeps centres when asked, skips locked nodes and single selections', () => {
		expect(matchSize(nodes, ['a', 'b'], 'width', { keepCentre: true })).toEqual([{ id: 'a', width: 200, position: { x: -50, y: 0 } }]);
		expect(matchSize(lockNodes(nodes, ['a']), ['a', 'b'], 'width')).toEqual([]);
		expect(matchSize(nodes, ['a'], 'width')).toEqual([]);
	});

	it('applies sizes to width/height, style and measured, preserving style format', () => {
		const styled = [
			node('s', 0, 0, 100, 50, { style: 'width: 100px; height: 50px', measured: { width: 100, height: 50 } }),
			node('o', 0, 0, 300, 60, { style: { width: 300 } })
		];
		const result = byId(applyNodeUpdates(styled, matchSize(styled, ['s', 'o'], 'width')));
		expect(result.s.width).toBe(300);
		expect(result.s.style).toBe('width: 300px; height: 50px');
		expect(result.s.measured).toEqual({ width: 300, height: 50 });
	});
});

describe('canvas arrange: locking', () => {
	it('locks and unlocks, restoring previous interaction flags', () => {
		const nodes = [node('a', 0, 0, 10, 10, { draggable: true }), node('b', 0, 0)];
		const locked = lockNodes(nodes, ['a', 'b']);
		expect(locked.every(isLocked)).toBe(true);
		expect(locked[0]).toMatchObject({ draggable: false, deletable: false });
		expect(locked[0].selectable).toBeUndefined();
		const unlocked = unlockNodes(locked, ['a', 'b']);
		expect(unlocked[0].draggable).toBe(true);
		expect('draggable' in unlocked[1]).toBe(false);
		expect(unlocked[1].data).toEqual({ label: 'b' });
		expect(unlockNodes(nodes, ['a'])[0]).toBe(nodes[0]);
	});

	it('toggles: locks if any is unlocked, otherwise unlocks', () => {
		const nodes = lockNodes([node('a', 0, 0), node('b', 0, 0)], ['a']);
		const once = toggleLockNodes(nodes, ['a', 'b']);
		expect(once.every(isLocked)).toBe(true);
		expect(toggleLockNodes(once, ['a', 'b']).some(isLocked)).toBe(false);
	});
});

describe('canvas arrange: reorderNodes (z-order)', () => {
	const stack = () => [node('a', 0, 0), node('b', 10, 10), node('c', 20, 20), node('far', 1000, 1000)];
	const order = (nodes: CanvasNode[]) =>
		nodes
			.map((n, i) => ({ id: n.id, z: n.zIndex ?? 0, i }))
			.sort((x, y) => x.z - y.z || x.i - y.i)
			.map((e) => e.id);

	it('brings to front and sends to back', () => {
		const nodes = stack();
		expect(order(applyNodeUpdates(nodes, reorderNodes(nodes, ['a'], 'bringToFront')))).toEqual(['b', 'c', 'far', 'a']);
		expect(order(applyNodeUpdates(nodes, reorderNodes(nodes, ['far'], 'sendToBack')))).toEqual(['far', 'a', 'b', 'c']);
	});

	it('steps forward/backward past the next overlapping sibling', () => {
		const nodes = stack();
		expect(order(applyNodeUpdates(nodes, reorderNodes(nodes, ['a'], 'bringForward')))).toEqual(['b', 'a', 'c', 'far']);
		expect(order(applyNodeUpdates(nodes, reorderNodes(nodes, ['far'], 'sendBackward')))).toEqual(['a', 'b', 'far', 'c']);
		// c overlaps nothing above it -> no change at the top
		expect(reorderNodes(nodes, ['far'], 'bringForward')).toEqual([]);
	});

	it('respects existing zIndex, locked nodes and sibling groups', () => {
		const nodes = [node('a', 0, 0, 100, 100, { zIndex: 5 }), node('b', 0, 0), node('p', 0, 0), node('child', 0, 0, 10, 10, { parentId: 'p' })];
		expect(order(nodes)).toEqual(['b', 'p', 'child', 'a']);
		expect(order(applyNodeUpdates(nodes, reorderNodes(nodes, ['b'], 'bringToFront')))).toEqual(['p', 'child', 'a', 'b']);
		// A child is only restacked among its own siblings.
		expect(reorderNodes(nodes, ['child'], 'sendToBack')).toEqual([]);
		expect(reorderNodes(lockNodes(nodes, ['b']), ['b'], 'bringToFront')).toEqual([]);
		expect(reorderNodes(nodes, [], 'bringToFront')).toEqual([]);
	});
});

describe('canvas arrange: applyNodeUpdates / invertNodeUpdates', () => {
	it('keeps identity of untouched nodes and inverts updates', () => {
		const nodes = [node('a', 0, 0), node('b', 5, 5)];
		const updates = [{ id: 'a', position: { x: 9, y: 9 }, width: 1, zIndex: 3 }];
		const next = applyNodeUpdates(nodes, updates);
		expect(next[1]).toBe(nodes[1]);
		expect(applyNodeUpdates(nodes, [])).toBe(nodes);
		const back = applyNodeUpdates(next, invertNodeUpdates(nodes, updates));
		expect(back[0]).toMatchObject({ position: { x: 0, y: 0 }, width: 100, zIndex: 0 });
	});
});

describe('canvas smart guides', () => {
	const others: Rect[] = [
		{ x: 0, y: 0, width: 100, height: 100 },
		{ x: 300, y: 300, width: 100, height: 100 }
	];

	it('snaps edges within the threshold and reports guide segments', () => {
		const result = computeSnapGuides({ x: 103, y: 200, width: 50, height: 50 }, others);
		expect(result.snappedX).toBe(true);
		expect(result.position.x).toBe(100);
		expect(result.offset).toEqual({ x: -3, y: 0 });
		const vertical = result.guides.find((g) => g.orientation === 'vertical');
		expect(vertical).toMatchObject({ kind: 'edge', x1: 100, x2: 100, y1: 0, y2: 250 });
	});

	it('snaps centres', () => {
		const result = computeSnapGuides({ x: 27, y: 500, width: 50, height: 10 }, others, { edges: false, spacing: false });
		expect(result.position.x).toBe(25);
		expect(result.guides[0]).toMatchObject({ kind: 'centre', orientation: 'vertical', x1: 50 });
	});

	it('converts the screen-pixel threshold with zoom', () => {
		const moving = { x: 110, y: 600, width: 50, height: 50 };
		// 10 flow units away: snaps at zoom 0.5 (threshold 12 flow units), not at zoom 1 (6).
		expect(computeSnapGuides(moving, others, { zoom: 1, spacing: false }).snappedX).toBe(false);
		expect(computeSnapGuides(moving, others, { zoom: 0.5, spacing: false }).snappedX).toBe(true);
		// At zoom 4 the threshold shrinks to 1.5 flow units.
		expect(computeSnapGuides({ ...moving, x: 102 }, others, { zoom: 4, spacing: false }).snappedX).toBe(false);
		expect(computeSnapGuides({ ...moving, x: 101 }, others, { zoom: 4, spacing: false }).snappedX).toBe(true);
	});

	it('returns no snap or guides when nothing is near', () => {
		const result = computeSnapGuides({ x: 2000, y: 2000, width: 10, height: 10 }, others);
		expect(result).toMatchObject({ snappedX: false, snappedY: false, offset: { x: 0, y: 0 }, guides: [] });
		expect(computeSnapGuides({ x: 0, y: 0, width: 1, height: 1 }, []).guides).toEqual([]);
	});

	it('snaps to equal spacing between neighbours in a row', () => {
		const row: Rect[] = [
			{ x: 0, y: 0, width: 100, height: 50 },
			{ x: 400, y: 0, width: 100, height: 50 }
		];
		// Equal gaps: (100 + 400 - 80) / 2 = 210
		const result = computeSnapGuides({ x: 206, y: 0, width: 80, height: 50 }, row, { edges: false, centres: false });
		expect(result.position.x).toBe(210);
		const spacing = result.guides.filter((g) => g.kind === 'spacing');
		expect(spacing).toHaveLength(2);
		expect(spacing[0]).toMatchObject({ x1: 100, x2: 210 });
		expect(spacing[1]).toMatchObject({ x1: 290, x2: 400 });
	});

	it('repeats an existing neighbour gap', () => {
		const row: Rect[] = [
			{ x: 0, y: 0, width: 100, height: 50 },
			{ x: 150, y: 0, width: 100, height: 50 }
		];
		const result = computeSnapGuides({ x: 297, y: 10, width: 60, height: 20 }, row, { edges: false, centres: false });
		expect(result.position.x).toBe(300);
	});

	it('snaps a multi-node drag via its bounding box and skips descendants', () => {
		const nodes = [
			node('static', 0, 0, 100, 100),
			node('a', 203, 300, 50, 50),
			node('b', 263, 300, 50, 50),
			node('child', 5, 5, 10, 10, { parentId: 'a' })
		];
		const result = snapNodeDrag(nodes, ['a', 'b', 'child'], { spacing: false });
		// bbox right edge 313; nothing near. left edge 203 -> nothing (static right = 100).
		expect(result.updates).toEqual([]);
		const near = snapNodeDrag(nodes.map((n) => (n.id === 'a' ? { ...n, position: { x: 102, y: 300 } } : n)), ['a', 'child'], { spacing: false });
		expect(near.offset.x).toBe(-2);
		expect(near.updates).toEqual([{ id: 'a', position: { x: 100, y: 300 } }]);
		expect(snapNodeDrag(nodes, []).updates).toEqual([]);
	});

	it('excludes dragged nodes, descendants and hidden nodes from the index', () => {
		const nodes = [node('a', 0, 0), node('c', 0, 0, 10, 10, { parentId: 'a' }), node('h', 0, 0, 10, 10, { hidden: true }), node('o', 500, 0)];
		expect(createNodeGuideIndex(nodes, ['a']).rects).toHaveLength(1);
	});

	it('stays fast with a thousand shapes', () => {
		const rects: Rect[] = [];
		for (let i = 0; i < 1000; i++) {
			rects.push({ x: (i % 40) * 137.3, y: Math.floor(i / 40) * 91.7, width: 80 + (i % 7), height: 40 + (i % 5) });
		}
		const index = createGuideIndex(rects);
		const start = performance.now();
		for (let i = 0; i < 1000; i++) {
			computeSnapGuides({ x: i * 3.1, y: i * 2.3, width: 90, height: 45 }, index, { zoom: 1 });
		}
		const elapsed = performance.now() - start;
		// 1000 drag frames against 1000 shapes; generous bound to stay stable on CI.
		expect(elapsed).toBeLessThan(1500);
	});
});

describe('canvas connector snapping', () => {
	const targets = [
		{ id: 'a', rect: { x: 0, y: 0, width: 200, height: 100 } },
		{ id: 'b', rect: { x: 400, y: 0, width: 100, height: 100 }, positions: ['left' as const] }
	];

	it('attaches to the nearest side of the shape under the pointer', () => {
		expect(findConnectorSnap({ x: 190, y: 50 }, targets)).toMatchObject({ nodeId: 'a', position: 'right', side: 'right', point: { x: 200, y: 50 } });
		expect(findConnectorSnap({ x: 100, y: 5 }, targets)).toMatchObject({ nodeId: 'a', position: 'top', side: 'above' });
	});

	it('attaches to nearby shapes within the radius and respects zoom, allowed sides and exclusions', () => {
		expect(findConnectorSnap({ x: 100, y: 120 }, targets)).toMatchObject({ nodeId: 'a', position: 'bottom' });
		expect(findConnectorSnap({ x: 100, y: 140 }, targets)).toBeNull();
		expect(findConnectorSnap({ x: 100, y: 140 }, targets, { zoom: 0.5 })).toMatchObject({ nodeId: 'a' });
		expect(findConnectorSnap({ x: 490, y: 50 }, targets)).toMatchObject({ nodeId: 'b', position: 'left' });
		expect(findConnectorSnap({ x: 100, y: 50 }, targets, { excludeIds: ['a'] })).toBeNull();
	});

	it('projects onto the side in edge mode', () => {
		expect(findConnectorSnap({ x: 30, y: 95 }, targets, { mode: 'edge' })).toMatchObject({ position: 'bottom', point: { x: 30, y: 100 } });
	});

	it('maps between Position and Side and picks facing handles', () => {
		expect(positionToSide('top')).toBe('above');
		expect(sideToPosition('below')).toBe('bottom');
		expect(sideToPosition('left')).toBe('left');
		expect(nearestHandlePositions(targets[0].rect, targets[1].rect)).toEqual({ source: 'right', target: 'left' });
		expect(nearestHandlePositions({ x: 0, y: 500, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: 10 })).toEqual({ source: 'top', target: 'bottom' });
	});
});

describe('canvas scenes store', () => {
	let n = 0;
	const createId = () => `s${++n}`;

	it('adds, renames, updates, reorders and removes scenes', () => {
		n = 0;
		const store = createCanvasScenesStore({ createId });
		const listener = vi.fn();
		store.subscribe(listener);
		const first = store.add({ viewport: { x: 0, y: 0, zoom: 1 } });
		const second = store.add({ viewport: { x: 10, y: 10, zoom: 2 }, name: 'Detail' });
		expect(first.name).toBe('Scene 1');
		expect(store.getState().currentId).toBe(second.id);
		store.rename(first.id, '  Overview ');
		expect(store.getScene(first.id)!.name).toBe('Overview');
		store.rename(first.id, '   ');
		expect(store.getScene(first.id)!.name).toBe('Overview');
		store.update(first.id, { viewport: { x: 5, y: 5, zoom: 0.5 }, nodeIds: ['a'] });
		expect(store.getScene(first.id)).toMatchObject({ viewport: { zoom: 0.5 }, nodeIds: ['a'] });
		store.move(second.id, 0);
		expect(store.getState().scenes.map((s) => s.id)).toEqual([second.id, first.id]);
		store.reorder([first.id]);
		expect(store.getState().scenes.map((s) => s.id)).toEqual([first.id, second.id]);
		store.remove(second.id);
		expect(store.getState()).toMatchObject({ currentId: null, currentIndex: -1 });
		expect(listener).toHaveBeenCalled();
		expect(() => store.add({ viewport: { x: 0, y: 0, zoom: 0 } })).toThrow();
	});

	it('steps through scenes with next/previous, optionally wrapping', () => {
		n = 0;
		const store = createCanvasScenesStore({ createId });
		expect(store.next()).toBeUndefined();
		const a = store.add({ viewport: { x: 0, y: 0, zoom: 1 } });
		const b = store.add({ viewport: { x: 1, y: 1, zoom: 1 } });
		expect(store.next()).toBeUndefined();
		expect(store.previous()!.id).toBe(a.id);
		expect(store.previous()).toBeUndefined();
		store.wrap = true;
		expect(store.previous()!.id).toBe(b.id);
		expect(store.next()!.id).toBe(a.id);
	});

	it('caches snapshots between changes', () => {
		const store = createCanvasScenesStore();
		const snap = store.getState();
		expect(store.getState()).toBe(snap);
		store.add({ viewport: { x: 0, y: 0, zoom: 1 } });
		expect(store.getState()).not.toBe(snap);
	});

	it('round-trips JSON and drops invalid scenes', () => {
		const store = createCanvasScenesStore({ initialScenes: [{ id: 'x', name: 'X', viewport: { x: 1, y: 2, zoom: 3 }, nodeIds: ['n'] }] });
		const json = store.serialize();
		const other = createCanvasScenesStore();
		other.load(json);
		expect(other.toJSON()).toEqual({ version: 1, scenes: [{ id: 'x', name: 'X', viewport: { x: 1, y: 2, zoom: 3 }, nodeIds: ['n'] }] });
		expect(parseCanvasScenes('not json')).toEqual([]);
		expect(
			parseCanvasScenes([
				{ id: 'a', name: 'A', viewport: { x: 0, y: 0, zoom: 1 } },
				{ id: 'a', name: 'dup', viewport: { x: 0, y: 0, zoom: 1 } },
				{ id: 'b', name: 'B', viewport: { x: 'no', y: 0, zoom: 1 } }
			]).map((s) => s.name)
		).toEqual(['A']);
	});

	it('fits viewports to rectangles and nodes', () => {
		const vp = fitViewportToRect({ x: 0, y: 0, width: 100, height: 100 }, { width: 240, height: 120 }, { padding: 0.1 });
		expect(vp.zoom).toBe(1);
		expect(vp).toMatchObject({ x: 70, y: 10 });
		expect(fitViewportToRect({ x: 0, y: 0, width: 1, height: 1 }, { width: 1000, height: 1000 }).zoom).toBe(2);
		const nodes = [node('a', 0, 0, 100, 100), node('b', 900, 900, 100, 100)];
		expect(fitViewportToNodes(nodes, { width: 500, height: 500 }, ['a'], { padding: 0 })!.zoom).toBe(2);
		expect(fitViewportToNodes(nodes, { width: 500, height: 500 }, ['missing'])).toBeNull();
	});
});

describe('canvas arrange shortcuts', () => {
	const key = (init: KeyboardEventInit & { target?: any }) =>
		({ key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null, ...init }) as unknown as KeyboardEvent;

	it('matches default bindings by code', () => {
		expect(matchArrangeShortcut(key({ code: 'KeyA', key: 'å', altKey: true }))).toBe('alignLeft');
		expect(matchArrangeShortcut(key({ code: 'KeyH', altKey: true, shiftKey: true }))).toBe('distributeHorizontal');
		expect(matchArrangeShortcut(key({ code: 'KeyL', metaKey: true }))).toBe('lock');
		expect(matchArrangeShortcut(key({ code: 'KeyL', ctrlKey: true, altKey: true }))).toBe('unlock');
		expect(matchArrangeShortcut(key({ code: 'BracketRight', metaKey: true, altKey: true }))).toBe('bringToFront');
		expect(matchArrangeShortcut(key({ key: '[', metaKey: true }))).toBe('sendBackward');
		expect(matchArrangeShortcut(key({ key: 'PageDown' }))).toBe('nextScene');
		expect(matchArrangeShortcut(key({ code: 'KeyA' }))).toBeNull();
	});

	it('ignores events from text inputs', () => {
		const target = { tagName: 'INPUT', isContentEditable: false, closest: () => null };
		expect(matchArrangeShortcut(key({ code: 'KeyA', altKey: true, target }))).toBeNull();
	});
});

describe('canvas arrange controller', () => {
	const setup = (withHistory = false) => {
		let nodes: CanvasNode[] = [
			node('a', 0, 0, 100, 50, { selected: true }),
			node('b', 40, 100, 100, 50, { selected: true }),
			node('c', 500, 500)
		];
		const history = withHistory ? new HistoryManager() : undefined;
		const onGuidesChange = vi.fn();
		const controller = createCanvasArrangeController({
			getNodes: () => nodes,
			setNodes: (next) => (nodes = next),
			history,
			onGuidesChange
		});
		return { controller, history, onGuidesChange, get nodes() { return nodes; } };
	};

	it('acts on the selection and records one undoable step per action', () => {
		const ctx = setup(true);
		ctx.controller.align('right');
		expect(byId(ctx.nodes).a.position.x).toBe(40);
		ctx.controller.lock(['c']);
		expect(isLocked(byId(ctx.nodes).c)).toBe(true);
		expect(ctx.history!.getState().undoCount).toBe(2);
		ctx.history!.undo();
		expect(isLocked(byId(ctx.nodes).c)).toBe(false);
		ctx.history!.undo();
		expect(byId(ctx.nodes).a.position.x).toBe(0);
		ctx.history!.redo();
		expect(byId(ctx.nodes).a.position.x).toBe(40);
		// No-op actions do not create history entries.
		ctx.controller.align('right');
		expect(ctx.history!.getState().undoCount).toBe(1);
	});

	it('runs shortcut actions and toggles lock', () => {
		const ctx = setup();
		expect(ctx.controller.runAction('alignTop')).toBe(true);
		expect(byId(ctx.nodes).b.position.y).toBe(0);
		expect(ctx.controller.runAction('nextScene')).toBe(false);
		ctx.controller.toggleLock();
		expect(ctx.controller.isLocked('a')).toBe(true);
		ctx.controller.toggleLock();
		expect(ctx.controller.isLocked('a')).toBe(false);
		ctx.controller.bringToFront(['a']);
		expect(byId(ctx.nodes).a.zIndex).toBe(2);
		ctx.controller.matchSize('width', ['a', 'c'], { reference: { id: 'a' } });
		expect(byId(ctx.nodes).c.width).toBe(100);
		ctx.controller.distribute('horizontal', 'gaps', ['a']);
	});

	it('snaps drags, publishes guides and clears them on drop', () => {
		// The flow library has already written the dragged position (c near a's right edge).
		let nodes = [node('a', 0, 0, 100, 50), node('c', 103, 300)];
		const onGuidesChange = vi.fn();
		const controller = createCanvasArrangeController({ getNodes: () => nodes, setNodes: (n) => (nodes = n), onGuidesChange });
		controller.beginDrag(['c']);
		const result = controller.drag(['c'])!;
		expect(result.offset.x).toBe(-3);
		expect(byId(nodes).c.position.x).toBe(100);
		expect(controller.guides.length).toBeGreaterThan(0);
		expect(onGuidesChange).toHaveBeenCalledWith(controller.guides);
		controller.endDrag();
		expect(controller.guides).toEqual([]);
		expect(onGuidesChange).toHaveBeenLastCalledWith([]);
	});

	it('adjusts React Flow position changes and ends on drag stop', () => {
		let nodes = [node('a', 0, 0, 100, 50), node('b', 300, 300, 100, 50), node('k', 1, 1, 10, 10, { parentId: 'b' })];
		const controller = createCanvasArrangeController({ getNodes: () => nodes, setNodes: (n) => (nodes = n), getZoom: () => 1 });
		const changes = controller.snapPositionChanges([
			{ type: 'position', id: 'b', position: { x: 104, y: 200 }, dragging: true },
			{ type: 'position', id: 'k', position: { x: 1, y: 1 }, dragging: true },
			{ type: 'select', id: 'a', selected: true }
		]);
		expect(changes[0].position).toEqual({ x: 100, y: 200 });
		expect(changes[1].position).toEqual({ x: 1, y: 1 });
		expect(changes[2]).toEqual({ type: 'select', id: 'a', selected: true });
		expect(controller.guides.length).toBeGreaterThan(0);
		const stop = [{ type: 'position', id: 'b', dragging: false }];
		expect(controller.snapPositionChanges(stop)).toBe(stop);
		expect(controller.guides).toEqual([]);
	});

	it('can disable snapping', () => {
		let nodes = [node('a', 0, 0), node('b', 103, 0)];
		const controller = createCanvasArrangeController({ getNodes: () => nodes, setNodes: (n) => (nodes = n), snapping: false });
		expect(controller.drag(['b'])).toBeNull();
		const changes = [{ type: 'position', id: 'b', position: { x: 103, y: 0 }, dragging: true }];
		expect(controller.snapPositionChanges(changes)).toBe(changes);
	});
});
