import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/agent';
import {
  ADJUSTMENT_KINDS,
  ADJUSTMENT_LAYER_CONTROLS,
  DEFAULT_ADJUSTMENTS,
  IMAGE_ADJUSTMENT_CONTROLS,
  ImageEditorController,
  boxToCurvePoint,
  clampControlValue,
  curvePointToBox,
  curveSvgPath,
  hitTestCurvePoint,
  insertCurvePoint,
  moveCurvePoint,
  removeCurvePoint,
  controlPosition,
  createImageEditorToolProvider,
  defaultAdjustmentParams,
  findAdjustmentControl,
  formatControlValue,
  getControlPath,
  readAdjustmentControls,
  setControlPath,
} from '../src/image-editor';

describe('adjustment control table', () => {
  it('describes every numeric base adjustment with its default', () => {
    const ids = IMAGE_ADJUSTMENT_CONTROLS.map((c) => c.id);
    expect(ids).toEqual(['brightness', 'contrast', 'saturation', 'exposure', 'temperature', 'tint', 'blur', 'opacity']);
    for (const c of IMAGE_ADJUSTMENT_CONTROLS) {
      expect(c.default).toBe((DEFAULT_ADJUSTMENTS as unknown as Record<string, number>)[c.id]);
      expect(c.min).toBeLessThan(c.max);
      expect(c.default).toBeGreaterThanOrEqual(c.min);
      expect(c.default).toBeLessThanOrEqual(c.max);
    }
    expect(findAdjustmentControl('tint')!.requiresProcess).toBe(2);
  });

  it('layer controls address real parameters with matching defaults', () => {
    for (const { kind } of ADJUSTMENT_KINDS) {
      const params = defaultAdjustmentParams(kind);
      for (const c of ADJUSTMENT_LAYER_CONTROLS[kind]) {
        expect(getControlPath(params, c.id), `${kind}.${c.id}`).toBe(c.default);
      }
    }
  });

  it('clamps, snaps, formats and positions values', () => {
    const exposure = findAdjustmentControl('exposure')!;
    const opacity = findAdjustmentControl('opacity')!;
    expect(clampControlValue(exposure, 250)).toBe(100);
    expect(clampControlValue(exposure, 12.4)).toBe(12);
    expect(clampControlValue(exposure, NaN)).toBe(0);
    expect(clampControlValue(opacity, 0.33)).toBe(0.35);
    expect(formatControlValue(opacity, 0.35)).toBe('35%');
    expect(formatControlValue(findAdjustmentControl('blur')!, 4)).toBe('4px');
    expect(controlPosition(exposure, 0)).toBe(0.5);
    expect(readAdjustmentControls({ ...DEFAULT_ADJUSTMENTS, tint: undefined }).tint).toBe(0);
  });

  it('sets dotted paths immutably', () => {
    const src = { ranges: [{ hue: 0 }, { hue: 1 }], midtones: [0, 0, 0] };
    const out = setControlPath(src, 'ranges.1.hue', 30);
    expect(out.ranges[1].hue).toBe(30);
    expect(src.ranges[1].hue).toBe(1);
    expect(setControlPath(src, 'midtones.2', -5).midtones).toEqual([0, 0, -5]);
    expect(src.midtones).toEqual([0, 0, 0]);
  });
});

describe('curve editing helpers', () => {
  const line = [{ input: 0, output: 0 }, { input: 255, output: 255 }];

  it('maps between curve levels and the editor box', () => {
    expect(curvePointToBox({ input: 255, output: 0 }, 100, 50)).toEqual({ x: 100, y: 50 });
    expect(boxToCurvePoint(50, 25, 100, 50)).toEqual({ input: 128, output: 128 });
    expect(boxToCurvePoint(-10, 999, 100, 50)).toEqual({ input: 0, output: 0 });
    const path = curveSvgPath(line, 100, 100, 4);
    expect(path.startsWith('M0 100 L25 ')).toBe(true);
    expect(path.endsWith(' L100 0')).toBe(true);
    const ys = [...path.matchAll(/[ML](\S+) (\S+)/g)].map((m) => Number(m[2]));
    ys.forEach((y, i) => expect(y).toBeCloseTo(100 - i * 25, 0));
  });

  it('inserts, moves within neighbours, hit-tests and removes points', () => {
    const { points, index } = insertCurvePoint(line, { input: 64, output: 100 });
    expect(index).toBe(1);
    expect(points.map((p) => p.input)).toEqual([0, 64, 255]);
    expect(insertCurvePoint(points, { input: 64, output: 10 }).points).toHaveLength(3);
    const moved = moveCurvePoint(points, 1, { input: 300, output: 128 });
    expect(moved[1]).toEqual({ input: 254, output: 128 });
    expect(moveCurvePoint(points, 0, { input: 90, output: 20 })[0]).toEqual({ input: 63, output: 20 });
    const b = curvePointToBox(points[1], 200, 200);
    expect(hitTestCurvePoint(points, b.x + 3, b.y - 3, 200, 200)).toBe(1);
    expect(hitTestCurvePoint(points, 100, 190, 200, 200)).toBe(-1);
    expect(removeCurvePoint(points, 1)).toEqual(line);
    expect(removeCurvePoint(line, 0)).toEqual(line);
  });
});

describe('image editor agent tools', () => {
  const setup = () => {
    const controller = new ImageEditorController();
    const registry = new ToolRegistry();
    registry.register(createImageEditorToolProvider(controller, { id: 'img' }));
    return { controller, registry };
  };

  it('lists the adjustment and selection tools with complete MCP annotations', () => {
    const { registry } = setup();
    const { tools } = registry.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'get_adjustments', 'list_controls', 'set_adjustments', 'add_adjustment_layer', 'render_preview', 'capture_view',
      'get_selection', 'select_region', 'select_by_color', 'modify_selection', 'refine_selection', 'apply_selection_as_mask',
    ]);
    for (const t of tools) {
      expect(t.title).toBeTruthy();
      expect(t.annotations).toMatchObject({ title: expect.any(String) });
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        expect(typeof t.annotations![hint], `${t.name}.${hint}`).toBe('boolean');
      }
    }
    const readOnly = tools.filter((t) => t.annotations!.readOnlyHint).map((t) => t.name);
    expect(readOnly).toEqual(['get_adjustments', 'list_controls', 'render_preview', 'capture_view', 'get_selection']);
  });

  it('get_adjustments and list_controls describe the state', async () => {
    const { controller, registry } = setup();
    controller.setAdjustments({ exposure: 25 });
    const got = await registry.callTool('get_adjustments', {});
    expect(got.structuredContent).toMatchObject({ process: 2, values: { exposure: 25, opacity: 1 }, layers: [] });
    const list = await registry.callTool('list_controls', {});
    const sc = list.structuredContent as any;
    expect(sc.controls.find((c: any) => c.id === 'exposure')).toMatchObject({ min: -100, max: 100, default: 0 });
    expect(sc.layerKinds.map((k: any) => k.kind)).toContain('hueSaturation');
    expect(sc.blendModes).toContain('soft-light');
  });

  it('set_adjustments clamps, echoes and is one undo step', async () => {
    const { controller, registry } = setup();
    const res = await registry.callTool('set_adjustments', { values: { exposure: 500, contrast: -20 }, label: 'Brighter' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ applied: { exposure: 100, contrast: -20 }, clamped: ['exposure'], label: 'Brighter' });
    expect(controller.getState().adjustments).toMatchObject({ exposure: 100, contrast: -20 });
    controller.undo();
    expect(controller.getState().adjustments).toMatchObject({ exposure: 0, contrast: 0 });
  });

  it('set_adjustments reaches layer parameters and rejects unknown ids', async () => {
    const { controller, registry } = setup();
    const added = await registry.callTool('add_adjustment_layer', { kind: 'colorBalance', blend: 'overlay' });
    const layer = (added.structuredContent as any).layer;
    expect(layer).toMatchObject({ kind: 'colorBalance', blend: 'overlay', opacity: 1, enabled: true });
    const res = await registry.callTool('set_adjustments', {
      values: { [`layers.${layer.id}.midtones.0`]: 40, [`layers.${layer.id}.opacity`]: 2 },
    });
    expect(res.structuredContent).toMatchObject({ applied: { [`layers.${layer.id}.midtones.0`]: 40, [`layers.${layer.id}.opacity`]: 1 } });
    const l = controller.getAdjustmentLayer(layer.id)!;
    expect(l.kind === 'colorBalance' && l.params.midtones).toEqual([40, 0, 0]);

    const bad = await registry.callTool('set_adjustments', { values: { warmth: 3, 'layers.nope.vibrance': 1 } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]).toMatchObject({ type: 'text' });
    expect((bad.content[0] as any).text).toContain('warmth');
    expect((bad.content[0] as any).text).toContain('exposure');

    const badKind = await registry.callTool('add_adjustment_layer', { kind: 'sharpen' });
    expect(badKind.isError).toBe(true);
  });

  it('render_preview reports an error where canvases are unavailable', async () => {
    const { registry } = setup();
    const res = await registry.callTool('render_preview', { maxSide: 64 });
    expect(res.isError).toBe(true);
  });
});
