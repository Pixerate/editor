import { describe, it, expect } from 'vitest';
import { labelHull, placeLabels, type PlacedLabel } from '../src/tools';

const overlap = (a: PlacedLabel, b: PlacedLabel) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('placeLabels', () => {
	it('puts a lone label on its first preferred side at the first distance', () => {
		const [p] = placeLabels([{ anchor: { x: 100, y: 100 }, width: 40, height: 12 }]);
		expect(p).toEqual({ x: 80, y: 84, width: 40, height: 12, side: 'above', wrapped: false, leader: null, clashes: 0, ok: true });
	});

	it('moves off a box in the way, to the next side that is clear', () => {
		// The box covers above and the right-hand spot too (it reaches y 98), so the label goes below.
		const [p] = placeLabels([{ anchor: { x: 100, y: 100 }, width: 40, height: 12 }], { obstacles: [{ box: { x: 60, y: 40, width: 80, height: 58 } }] });
		expect(p).toMatchObject({ side: 'below', x: 80, y: 104, ok: true });
		const [q] = placeLabels([{ anchor: { x: 100, y: 100 }, width: 40, height: 12 }], { obstacles: [{ box: { x: 60, y: 40, width: 80, height: 50 } }] });
		expect(q).toMatchObject({ side: 'right', x: 104, ok: true });
	});

	it('keeps labels apart, and off each other\'s anchors', () => {
		const labels = [0, 1, 2, 3, 4].map((i) => ({ anchor: { x: 100 + i * 10, y: 100 }, width: 50, height: 12 }));
		const placed = placeLabels(labels);
		expect(placed.every((p) => p.ok)).toBe(true);
		for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i], placed[j])).toBe(false);
		for (const [i, p] of placed.entries()) for (const [j, l] of labels.entries()) if (i !== j) expect(l.anchor.x >= p.x - 1 && l.anchor.x <= p.x + p.width + 1 && l.anchor.y >= p.y - 1 && l.anchor.y <= p.y + p.height + 1).toBe(false);
	});

	it('steps outwards, wraps when that fits better, and stays in bounds', () => {
		const wall = { box: { x: 0, y: 0, width: 300, height: 80 } };
		const [far] = placeLabels([{ anchor: { x: 150, y: 100 }, width: 120, height: 12, prefer: ['below'] }], { obstacles: [{ box: { x: 0, y: 104, width: 300, height: 10 } }] });
		expect(far).toMatchObject({ side: 'below', y: 116, ok: true });
		const [wrapped] = placeLabels([{ anchor: { x: 150, y: 100 }, width: 200, height: 12, wrapped: { width: 100, height: 26 }, prefer: ['right'] }], { obstacles: [wall], bounds: { x: 0, y: 0, width: 300, height: 200 } });
		expect(wrapped).toMatchObject({ wrapped: true, width: 100, ok: true });
		expect(wrapped.x + wrapped.width).toBeLessThanOrEqual(300);
	});

	it('handles points, segments and polygons, and an obstacle tied to its own label', () => {
		const anchor = { x: 100, y: 100 };
		const first = { x: 80, y: 84 }; // above, at the first distance
		const point = placeLabels([{ anchor, width: 40, height: 12 }], { obstacles: [{ point: { x: 100, y: 90 } }] })[0];
		expect(point).toMatchObject({ ok: true, side: 'above', y: 72 }); // stepped out past the point
		const segment = placeLabels([{ anchor, width: 40, height: 12 }], { obstacles: [{ segment: [{ x: 60, y: 90 }, { x: 140, y: 90 }] }] })[0];
		expect(segment.ok && segment.y + segment.height < 90).toBe(true);
		const polygon = placeLabels([{ anchor, width: 40, height: 12 }], { obstacles: [{ polygon: labelHull([{ x: 70, y: 60 }, { x: 130, y: 60 }, { x: 100, y: 98 }]) }] })[0];
		expect(polygon.ok && (polygon.x !== first.x || polygon.y !== first.y)).toBe(true);
		expect(placeLabels([{ anchor, width: 40, height: 12 }], { obstacles: [{ point: { x: 100, y: 90 }, label: 0 }] })[0]).toMatchObject(first);
	});

	it('centres edge labels on their anchor unless something is there', () => {
		expect(placeLabels([{ anchor: { x: 50, y: 50 }, width: 20, height: 10 }], { prefer: ['center', 'above'] })[0]).toMatchObject({ side: 'center', x: 40, y: 45 });
		expect(placeLabels([{ anchor: { x: 50, y: 50 }, width: 20, height: 10 }], { prefer: ['center', 'above'], obstacles: [{ box: { x: 45, y: 45, width: 10, height: 10 } }] })[0].side).toBe('above');
	});

	it('draws leaders when apart, reports a clash when there is no clear spot, and is deterministic', () => {
		const [p] = placeLabels([{ anchor: { x: 100, y: 100 }, width: 40, height: 12 }], { leader: true });
		expect(p.leader).toEqual([{ x: 100, y: 100 }, { x: 100, y: 88 }]);
		const boxed = placeLabels([{ anchor: { x: 100, y: 100 }, width: 40, height: 12 }], { obstacles: [{ box: { x: 0, y: 0, width: 200, height: 200 } }], passes: 2 });
		expect(boxed[0]).toMatchObject({ ok: false, clashes: 1, side: 'above' });
		const many = Array.from({ length: 30 }, (_, i) => ({ anchor: { x: (i * 37) % 200, y: (i * 53) % 150 }, width: 30 + (i % 4) * 8, height: 12 }));
		expect(placeLabels(many, { leader: true })).toEqual(placeLabels(many, { leader: true }));
	});

	it('refuses labels without an anchor or size', () => {
		expect(() => placeLabels([{ anchor: { x: 1, y: NaN }, width: 1, height: 1 }])).toThrow('placeLabels: label 0 needs an anchor { x, y }.');
		expect(() => placeLabels([{ anchor: { x: 1, y: 1 }, width: -1, height: 1 }])).toThrow('placeLabels: label 0 needs a width and height of at least 0.');
	});
});

import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import { VectorEditorController, createVectorCommands } from '../src/vector';
import { mermaidToSvg } from '../src/canvas';
import { parseMermaid } from '../src/diagram';

describe('vector.placeCallouts', () => {
	const setup = () => {
		const c = new VectorEditorController({ document: { width: 400, height: 300, nodes: [] } });
		const bar = c.addShape({ kind: 'rect', x: 150, y: 100, width: 100, height: 150 } as any);
		const a = c.addPath('M0 0 L60 0 L60 14 L0 14 Z', { name: 'Label A', fill: '#111111' });
		const b = c.addPath('M0 0 L60 0 L60 14 L0 14 Z', { name: 'Label B', fill: '#111111' });
		const commands = new CommandRegistry();
		for (const spec of createVectorCommands(c)) commands.register(spec);
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		return { c, bar, a, b, tools };
	};
	const run = (tools: ToolRegistry, params: unknown) => tools.callTool('run_command', { id: 'vector.placeCallouts', params });

	it('moves labels clear of the art and each other with leaders, as one undo step', async () => {
		const { c, bar, a, b, tools } = setup();
		const before = c.getDocument().nodes.length;
		const r = await run(tools, { labels: [{ id: a, anchorId: bar }, { id: b, anchor: { x: 200, y: 175 } }] });
		expect(r.isError).toBeFalsy();
		const result = (r.structuredContent as any).result;
		expect(result.clashes).toBe(0);
		expect(result.placed.map((p: any) => p.ok)).toEqual([true, true]);
		const boxes = result.placed;
		const barBox = { x: 150, y: 100, width: 100, height: 150 };
		for (const p of boxes) expect(overlap(p, barBox as any)).toBe(false);
		expect(overlap(boxes[0], boxes[1])).toBe(false);
		expect(c.getDocument().nodes.length).toBe(before + 2); // two leaders
		expect(boxes.every((p: any) => typeof p.leader === 'string')).toBe(true);
		c.undo();
		expect(c.getDocument().nodes.length).toBe(before);
	});

	it('refuses bad labels, changing nothing', async () => {
		const { c, a, tools } = setup();
		const before = JSON.stringify(c.getDocument());
		for (const [params, message] of [
			[{ labels: [{ id: 'nope', anchor: { x: 1, y: 1 } }] }, 'there is no node "nope"'],
			[{ labels: [{ id: a }] }, 'give an anchor { x, y } or an anchorId'],
			[{ labels: [{ id: a, anchorId: a }] }, 'cannot point at itself'],
			[{ labels: [{ id: a, anchorId: 'ghost' }] }, 'there is no node "ghost"'],
			[{ labels: [{ id: a, anchor: { x: 1, y: 1 } }, { id: a, anchor: { x: 2, y: 2 } }] }, 'listed twice'],
			[{ labels: [] }, '']
		] as const) {
			const r = await run(tools, params);
			expect(r.isError).toBe(true);
			if (message) expect((r.content as { text: string }[])[0].text).toContain(message);
		}
		expect(JSON.stringify(c.getDocument())).toBe(before);
	});
});

describe('diagram SVG edge labels', () => {
	it('stay on their edge when clear, and move off a node in the way', () => {
		const svg = mermaidToSvg(parseMermaid('flowchart LR\n  a[Start] -->|go| b[End]')).svg;
		expect(svg).toContain('>go</text>');
		const crowded = mermaidToSvg(parseMermaid('flowchart TB\n  a[A] -->|a long label that is wider than the gap| b[B]\n  a --> c[C]\n  c -->|another long label here| b')).svg;
		const rects = [...crowded.matchAll(/<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)" rx="3"/g)].map((m) => ({ x: +m[1], y: +m[2], width: +m[3], height: +m[4] }));
		expect(rects).toHaveLength(2);
		expect(overlap(rects[0] as any, rects[1] as any)).toBe(false);
	});
});
