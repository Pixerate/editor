import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createChartSpec, layoutChart3d } from '../src/chart';
import { createChart3dScene } from '../src/three';

const bars = (extra: Record<string, unknown> = {}) =>
	createChartSpec({ type: 'bar', categories: ['Q1', 'Q2', 'Q3'], series: [{ id: 'a', name: 'A', values: [10, 20, 30] }, { id: 'b', name: 'B', values: [5, 15, -5] }], view3d: { azimuth: 30, elevation: 20, depth: 1.5 }, ...extra } as never);

describe('layoutChart3d', () => {
	it('puts clustered bars side by side within each category, with depth from the view', () => {
		const l = layoutChart3d(bars());
		expect(l.boxes).toHaveLength(6);
		expect(l.width).toBe(3);
		const [a0, b0] = [l.boxes.find((b) => b.seriesId === 'a' && b.index === 0)!, l.boxes.find((b) => b.seriesId === 'b' && b.index === 0)!];
		expect(a0.x1).toBeCloseTo(b0.x0, 9);
		expect(a0.z1 - a0.z0).toBeCloseTo((a0.x1 - a0.x0) * 1.5, 9);
		// The floor is the axis minimum: a negative value hangs below the zero line.
		const neg = l.boxes.find((b) => b.seriesId === 'b' && b.index === 2)!;
		const zero = l.ticks.find((t) => t.value === 0)!.y;
		expect(neg.y1).toBeCloseTo(zero, 9);
		expect(neg.y0).toBeLessThan(zero);
		expect(l.ticks.map((t) => t.label)).toContain('30');
		expect(l.categories.map((c) => c.x)).toEqual([0.5, 1.5, 2.5]);
		expect(l.warnings).toEqual([]);
	});

	it('stacks bars, and percent stacks run to 100', () => {
		const stacked = layoutChart3d(bars({ stacking: 'stacked', series: [{ id: 'a', name: 'A', values: [10, 20] }, { id: 'b', name: 'B', values: [5, 15] }], categories: ['x', 'y'] }));
		const [a, b] = [stacked.boxes.find((x) => x.seriesId === 'a' && x.index === 0)!, stacked.boxes.find((x) => x.seriesId === 'b' && x.index === 0)!];
		expect(a.x0).toBe(b.x0);
		expect(b.y0).toBeCloseTo(a.y1, 9);
		const percent = layoutChart3d(bars({ stacking: 'percent', series: [{ id: 'a', name: 'A', values: [1, 3] }, { id: 'b', name: 'B', values: [1, 1] }], categories: ['x', 'y'] }));
		const top = Math.max(...percent.boxes.map((x) => x.y1));
		expect(top).toBeCloseTo(percent.height, 9);
		expect(percent.ticks.at(-1)?.label).toBe('100%');
	});

	it('draws lines and areas as ribbons in rows behind the bars', () => {
		const spec = createChartSpec({ type: 'bar', categories: ['a', 'b', 'c'], series: [{ id: 'bar', name: 'Bar', values: [1, 2, 3] }, { id: 'line', name: 'Line', type: 'line', values: [2, null, 4] }, { id: 'area', name: 'Area', type: 'area', values: [1, 1, 1] }], view3d: {} } as never);
		const l = layoutChart3d(spec);
		expect(l.ribbons.map((r) => [r.seriesId, r.kind, r.points.map((p) => p.index)])).toEqual([['line', 'line', [0, 2]], ['area', 'area', [0, 1, 2]]]);
		const barBack = Math.max(...l.boxes.map((b) => b.z1));
		expect(l.ribbons[0].z0).toBeGreaterThan(barBack);
		expect(l.ribbons[1].z0).toBeGreaterThan(l.ribbons[0].z1);
		expect(l.depth).toBeCloseTo(l.ribbons[1].z1, 9);
	});

	it('says what it cannot draw in 3-D', () => {
		expect(layoutChart3d(createChartSpec({ type: 'pie', categories: ['a'], series: [{ name: 'S', values: [1] }] } as never)).warnings).toEqual(['Only bar, line and area charts are drawn in 3-D; this pie chart is drawn flat.']);
		expect(layoutChart3d(bars({ orientation: 'horizontal' })).warnings).toEqual(['Horizontal bars are drawn as columns in 3-D.']);
	});
});

describe('createChart3dScene', () => {
	it('builds a mesh per bar and ribbon, a floor, a wall and gridlines, with the camera fitted', () => {
		const view = createChart3dScene(bars({ series: [{ id: 'a', name: 'A', values: [10, 20, 30] }, { id: 'l', name: 'L', type: 'line', values: [5, 25, 15] }] }), { width: 640, height: 400 });
		const chart = view.scene.getObjectByName('chart')!;
		expect(chart.scale.z).toBe(-1); // the layout's z runs back into the picture
		expect(chart.children.map((c) => c.name).filter(Boolean)).toEqual(['gridlines', 'bar-a-0', 'bar-a-1', 'bar-a-2', 'line-l']);
		expect(chart.children.filter((c) => c instanceof THREE.Mesh)).toHaveLength(6); // floor, wall, three bars, one ribbon
		// Every corner of the chart is in the frame, inside the padding, and one touches it.
		const l = view.layout;
		const corners = [0, l.width].flatMap((x) => [0, l.height].flatMap((y) => [0, l.depth + 0.2].map((z) => new THREE.Vector3(x, y, -z).project(view.camera))));
		const worst = Math.max(...corners.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))));
		expect(worst).toBeLessThanOrEqual(0.77);
		expect(worst).toBeGreaterThan(0.7);
		view.dispose();
	});

	it('gives overlay labels in CSS px inside the picture, which follow a resize', () => {
		const view = createChart3dScene(bars({ title: 'Revenue' }), { width: 640, height: 400 });
		const labels = view.labels();
		const cats = labels.filter((l) => l.kind === 'category');
		expect(cats.map((l) => l.text)).toEqual(['Q1', 'Q2', 'Q3']);
		expect(cats[0].x).toBeLessThan(cats[2].x); // left to right, as on paper
		expect(labels.find((l) => l.kind === 'title')).toMatchObject({ text: 'Revenue', x: 320 });
		for (const l of labels) {
			expect(l.x).toBeGreaterThan(-1);
			expect(l.x).toBeLessThan(641);
			expect(l.y).toBeGreaterThan(-1);
			expect(l.y).toBeLessThan(401);
		}
		view.resize(320, 200);
		expect(view.labels().find((l) => l.kind === 'title')?.x).toBe(160);
		view.dispose();
	});

	it('is the same for the same chart, and turns with the view', () => {
		const a = createChart3dScene(bars(), { width: 400, height: 300 });
		const b = createChart3dScene(bars(), { width: 400, height: 300 });
		expect(a.camera.position.toArray()).toEqual(b.camera.position.toArray());
		const turned = createChart3dScene(bars({ view3d: { azimuth: 200, elevation: 60, depth: 1 } }), { width: 400, height: 300 });
		expect(turned.camera.position.y).toBeGreaterThan(a.camera.position.y);
		expect(turned.camera.position.z).toBeLessThan(a.camera.position.z); // seen from behind
	});
});

import { ToolRegistry } from '../src/tools';
import { ChartController, createChartToolProvider } from '../src/chart';

describe('render_chart in 3-D', () => {
	it('draws a chart with a 3-D view through the host render3d hook, and other charts as before', async () => {
		const calls: unknown[] = [];
		const controller = new ChartController({ spec: { type: 'bar', categories: ['a', 'b'], series: [{ name: 'S', values: [1, 2] }], view3d: { azimuth: 30 } } });
		const registry = new ToolRegistry();
		registry.register(createChartToolProvider(controller, { namespace: '', render3d: (spec, size) => (calls.push([spec.view3d, size]), { data: 'AAA', mimeType: 'image/png' }), rasterize: () => ({ data: 'FLAT', mimeType: 'image/png' }) }));
		const png = await registry.callTool('render_chart', { format: 'png', width: 400, height: 300 });
		expect((png.content as { type: string; data?: string }[])[0]).toMatchObject({ type: 'image', data: 'AAA' });
		expect(png.structuredContent).toMatchObject({ view3d: { azimuth: 30, elevation: 15, depth: 1 } });
		expect(calls).toEqual([[{ azimuth: 30, elevation: 15, depth: 1 }, { width: 400, height: 300 }]]);
		// SVG stays flat, and so does a chart without a view.
		expect(((await registry.callTool('render_chart', {})).structuredContent as { svg: string }).svg.startsWith('<svg')).toBe(true);
		await registry.callTool('update_chart', { view3d: null });
		expect(((await registry.callTool('render_chart', { format: 'png' })).content as { data?: string }[])[0].data).toBe('FLAT');
		expect(calls).toHaveLength(1);
	});
});
