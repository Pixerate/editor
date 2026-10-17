import { describe, it, expect } from 'vitest';
import {
	isCanvasGradient,
	parseCssGradient,
	resolveCanvasGradient,
	angleToSvgLinearCoords,
	gradientToSvgDef,
	CANVAS_GRADIENT_PRESETS,
	PIXERATE_BRAND_GRADIENT,
	getShapeRenderData,
	type CanvasLinearGradient,
	type CanvasRadialGradient,
	type ShapeNode
} from '../src/canvas';

describe('canvas gradients (core)', () => {
	it('identifies gradient objects with isCanvasGradient', () => {
		expect(isCanvasGradient('#ff0000')).toBe(false);
		expect(isCanvasGradient(null)).toBe(false);
		expect(isCanvasGradient(undefined)).toBe(false);
		expect(isCanvasGradient({ type: 'linear', stops: [] })).toBe(true);
		expect(isCanvasGradient({ type: 'radial', stops: [] })).toBe(true);
		expect(isCanvasGradient({ type: 'mesh', stops: [] })).toBe(false);
	});

	it('provides standard gradient presets including pixerate brand gradient', () => {
		expect(PIXERATE_BRAND_GRADIENT).toEqual({
			type: 'linear',
			angle: 135,
			stops: [
				{ offset: 0, color: '#8E51FF' },
				{ offset: 1, color: '#e12afb' }
			]
		});
		expect(CANVAS_GRADIENT_PRESETS.pixerate).toEqual(PIXERATE_BRAND_GRADIENT);
		expect(resolveCanvasGradient('pixerate')).toEqual(PIXERATE_BRAND_GRADIENT);
		expect(CANVAS_GRADIENT_PRESETS.sunset.type).toBe('linear');
		expect(CANVAS_GRADIENT_PRESETS.sunset.stops.length).toBeGreaterThanOrEqual(2);
		expect(CANVAS_GRADIENT_PRESETS.ocean.type).toBe('linear');
		expect(CANVAS_GRADIENT_PRESETS.aurora.stops[0].color).toBeDefined();
	});

	it('computes SVG linear coordinates from degrees', () => {
		// 90 deg: left to right (x1=0, y1=0, x2=1, y2=0)
		const east = angleToSvgLinearCoords(90);
		expect(east.x1).toBeCloseTo(0);
		expect(east.y1).toBeCloseTo(0.5);
		expect(east.x2).toBeCloseTo(1);
		expect(east.y2).toBeCloseTo(0.5);

		// 180 deg: top to bottom (x1=0.5, y1=0, x2=0.5, y2=1)
		const south = angleToSvgLinearCoords(180);
		expect(south.x1).toBeCloseTo(0.5);
		expect(south.y1).toBeCloseTo(0);
		expect(south.x2).toBeCloseTo(0.5);
		expect(south.y2).toBeCloseTo(1);
	});

	it('parses CSS linear gradients accurately', () => {
		const parsed = parseCssGradient('linear-gradient(135deg, #f97316 0%, #ec4899 100%)');
		expect(parsed).not.toBeNull();
		expect(parsed?.type).toBe('linear');
		const linear = parsed as CanvasLinearGradient;
		expect(linear.angle).toBe(135);
		expect(linear.stops).toEqual([
			{ offset: 0, color: '#f97316' },
			{ offset: 1, color: '#ec4899' }
		]);

		// With opacity in stop color
		const parsedRgba = parseCssGradient('linear-gradient(to right, rgba(0, 0, 0, 0.5), #ffffff)');
		expect(parsedRgba).not.toBeNull();
		expect(parsedRgba?.stops.length).toBe(2);
	});

	it('parses CSS radial gradients accurately', () => {
		const parsed = parseCssGradient('radial-gradient(circle, #38bdf8 0%, #3b82f6 100%)');
		expect(parsed).not.toBeNull();
		expect(parsed?.type).toBe('radial');
		const radial = parsed as CanvasRadialGradient;
		expect(radial.cx).toBe(0.5);
		expect(radial.cy).toBe(0.5);
		expect(radial.r).toBe(0.5);
		expect(radial.stops.length).toBe(2);
	});

	it('generates SVG gradient definitions and references', () => {
		const gradient: CanvasLinearGradient = {
			type: 'linear',
			angle: 90,
			stops: [
				{ offset: 0, color: '#ff0000', opacity: 0.8 },
				{ offset: 1, color: '#0000ff' }
			]
		};

		const def = gradientToSvgDef(gradient, 'grad-test');
		expect(def.id).toBe('grad-test');
		expect(def.type).toBe('linear');
		expect(def.attrs.x1).toBe('0%');
		expect(def.attrs.x2).toBe('100%');
		expect(def.stops).toEqual([
			{ offset: '0%', stopColor: '#ff0000', stopOpacity: 0.8 },
			{ offset: '100%', stopColor: '#0000ff', stopOpacity: undefined }
		]);

		const resolved = resolveCanvasGradient(gradient);
		expect(resolved).toEqual(gradient);

		const preset = resolveCanvasGradient('sunset');
		expect(preset).toEqual(CANVAS_GRADIENT_PRESETS.sunset);

		const solidResolved = resolveCanvasGradient('#3b82f6');
		expect(solidResolved).toBeNull();
	});

	it('integrates gradients and stroke endcaps with getShapeRenderData', () => {
		const shapeNode: ShapeNode = {
			id: 'shape-grad-1',
			type: 'shape',
			position: { x: 0, y: 0 },
			width: 100,
			height: 100,
			data: {
				shape: {
					kind: 'rect',
					fill: CANVAS_GRADIENT_PRESETS.sunset,
					stroke: CANVAS_GRADIENT_PRESETS.ocean,
					strokeWidth: 4,
					strokeLinecap: 'round',
					strokeLinejoin: 'round'
				}
			}
		};

		const render = getShapeRenderData(shapeNode.data.shape, { width: 100, height: 100 }, { id: shapeNode.id });
		expect(render.fill).toBe(`url(#shape-fill-${shapeNode.id})`);
		expect(render.stroke).toBe(`url(#shape-stroke-${shapeNode.id})`);
		expect(render.fillGradient?.id).toBe(`shape-fill-${shapeNode.id}`);
		expect(render.strokeGradient?.id).toBe(`shape-stroke-${shapeNode.id}`);
		expect(render.strokeLinecap).toBe('round');
		expect(render.strokeLinejoin).toBe('round');
	});
});
