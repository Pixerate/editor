import { describe, expect, it } from 'vitest';
import { boundsIntersect, hitTestVectorNode, hitTestVectorNodes, vectorNodeBounds, IDENTITY_MATRIX, rectSubpath, ellipseSubpath, VectorEditorController, VectorRTree, vectorNodesNear, vectorSpatialIndex, VECTOR_SPATIAL_MIN, type VectorNode } from '../src/vector';

/** A deterministic random source (mulberry32). */
function rng(seed: number) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function scene(count: number, seed = 1, size = 2000): VectorNode[] {
	const r = rng(seed);
	const nodes: VectorNode[] = [];
	for (let i = 0; i < count; i++) {
		const x = r() * size;
		const y = r() * size;
		const w = 5 + r() * 60;
		const h = 5 + r() * 60;
		const turned = r() < 0.3;
		const a = r() * Math.PI;
		nodes.push({
			id: `n${i}`,
			type: 'path',
			fill: r() < 0.7 ? '#888' : null,
			stroke: '#000',
			strokeWidth: 1 + r() * 8,
			subpaths: [r() < 0.5 ? rectSubpath({ x: -w / 2, y: -h / 2, width: w, height: h }) : ellipseSubpath({ x: -w / 2, y: -h / 2, width: w, height: h })],
			transform: turned ? [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), x, y] : [1, 0, 0, 1, x, y],
			...(r() < 0.05 ? { visible: false } : {})
		});
	}
	return nodes;
}

const scan = (nodes: readonly VectorNode[], p: { x: number; y: number }, tol: number) => {
	for (let i = nodes.length - 1; i >= 0; i--) {
		const n = nodes[i];
		if (n.visible === false || n.locked) continue;
		if (hitTestVectorNode(n, p, tol, IDENTITY_MATRIX)) return n;
	}
	return null;
};

describe('VectorRTree', () => {
	it('finds exactly the boxes a scan finds, in ascending order, keeping unbounded items', () => {
		const r = rng(7);
		const boxes = Array.from({ length: 1000 }, (_, i) => (i % 97 === 0 ? null : { minX: r() * 1000, minY: r() * 1000, maxX: 0, maxY: 0 })).map((b) => (b ? { ...b, maxX: b.minX + r() * 40, maxY: b.minY + r() * 40 } : null));
		const tree = new VectorRTree(boxes);
		for (let k = 0; k < 200; k++) {
			const q = { minX: r() * 1000, minY: r() * 1000, maxX: 0, maxY: 0 };
			q.maxX = q.minX + r() * 80;
			q.maxY = q.minY + r() * 80;
			const want = boxes.map((b, i) => (!b || (b.minX <= q.maxX && q.minX <= b.maxX && b.minY <= q.maxY && q.minY <= b.maxY) ? i : -1)).filter((i) => i >= 0);
			expect(tree.search(q)).toEqual(want);
		}
	});
});

describe('spatial index on documents', () => {
	it('is built only above the threshold and cached per node array', () => {
		const small = scene(VECTOR_SPATIAL_MIN - 1);
		expect(vectorSpatialIndex(small)).toBeNull();
		const big = scene(VECTOR_SPATIAL_MIN + 10);
		expect(vectorSpatialIndex(big)).toBe(vectorSpatialIndex(big));
		expect(vectorNodesNear(small, { x: 0, y: 0, width: 1, height: 1 })).toHaveLength(small.length);
	});

	it('hit-tests exactly like a scan (parity on random points, rotated and stroked shapes)', () => {
		// Above the index threshold, dense enough that shapes overlap; kept small so the scan it is
		// checked against stays fast on CI.
		const nodes = scene(400, 3, 800);
		expect(nodes.length).toBeGreaterThan(VECTOR_SPATIAL_MIN);
		const r = rng(11);
		let hits = 0;
		for (let k = 0; k < 200; k++) {
			// Half the points at random, half near a shape's edge (where strokes and tolerance decide).
			const n = nodes[Math.floor(r() * nodes.length)] as { transform: number[] };
			const p = k % 2 ? { x: r() * 800, y: r() * 800 } : { x: n.transform[4] + (r() - 0.5) * 80, y: n.transform[5] + (r() - 0.5) * 80 };
			const tol = r() * 6;
			const want = scan(nodes, p, tol)?.id ?? null;
			if (want) hits++;
			expect(hitTestVectorNodes(nodes, p, tol)?.id ?? null).toBe(want);
		}
		// Both outcomes are exercised.
		expect(hits).toBeGreaterThan(40);
		expect(hits).toBeLessThan(180);
	});

	it('selects with the marquee exactly like a scan', () => {
		const nodes = scene(600, 5);
		const c = new VectorEditorController({ document: { width: 2000, height: 2000, nodes } });
		c.pointerDown({ x: 300, y: 300 });
		c.pointerMove({ x: 700, y: 650 });
		c.pointerUp({ x: 700, y: 650 });
		const sel = new Set(c.getState().selection);
		expect(sel.size).toBeGreaterThan(0);
		// Every selected node really meets the marquee, and no node meeting it is missing.
		const box = { x: 300, y: 300, width: 400, height: 350 };
		const expected = nodes
			.filter((n) => {
				if (n.locked || n.visible === false) return false;
				const b = vectorNodeBounds(n);
				return !!b && boundsIntersect(b, box);
			})
			.map((n) => n.id);
		expect([...sel].sort()).toEqual(expected.sort());
	});
});
