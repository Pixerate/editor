import { describe, expect, it, vi } from 'vitest';
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
      'get_image_info', 'get_histogram', 'update_adjustment_layer', 'remove_adjustment_layer', 'move_adjustment_layer',
      'set_crop', 'reset_crop', 'set_rotation', 'flip_image', 'set_bit_depth', 'undo_image', 'redo_image',
      'list_layers', 'set_active_layer', 'add_pixel_layer', 'duplicate_layer', 'remove_layer', 'move_layer', 'set_layer_properties',
      'group_layers', 'add_group', 'ungroup_layer', 'merge_down', 'merge_visible', 'flatten_image', 'offset_layer', 'add_layer_mask',
      'apply_layer_mask', 'remove_layer_mask', 'set_layer_mask_properties', 'layer_via_copy', 'rasterize_layer', 'add_layer_filter',
      'update_layer_filter', 'remove_layer_filter',
      'get_transform_frame', 'transform_layer', 'warp_layer', 'transform_selection', 'flip_layer', 'rotate_layer_90',
      'get_smart_object', 'convert_to_smart_object', 'rasterize_smart_object', 'set_smart_object_transform', 'replace_smart_object_contents',
      'export_smart_object_contents', 'copy_smart_object', 'edit_smart_object_contents', 'close_smart_object_contents', 'add_smart_filter',
      'update_smart_filter', 'remove_smart_filter', 'move_smart_filter', 'set_smart_filters_enabled', 'set_smart_filter_mask',
      'get_shape_layer', 'add_shape_layer', 'update_shape', 'set_shape_component', 'add_shape_component', 'remove_shape_component', 'merge_shape_components',
      'list_fonts', 'get_text_layer', 'add_text_layer', 'set_text', 'set_text_style', 'set_paragraph_style', 'set_text_frame', 'convert_text_to_shape',
      'list_layer_effects', 'add_layer_effect', 'update_layer_effect', 'remove_layer_effect', 'set_layer_effects_enabled', 'set_global_light',
      'paint_stroke', 'fill_pixels', 'clear_pixels', 'get_mixer_brush', 'load_mixer_brush', 'clean_mixer_brush', 'set_paint', 'get_paint',
      'get_color_profile', 'assign_profile', 'convert_to_profile', 'set_proof_setup', 'convert_colors', 'set_color_mode',
      'clone_stamp', 'heal_brush', 'spot_heal', 'smudge', 'dodge', 'burn', 'sponge', 'get_retouch_options', 'set_retouch_options', 'set_clone_source',
      'mix_colors', 'inspect_psd', 'import_psd', 'export_psd',
    ]);
    for (const t of tools) {
      expect(t.title).toBeTruthy();
      expect(t.annotations).toMatchObject({ title: expect.any(String) });
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        expect(typeof t.annotations![hint], `${t.name}.${hint}`).toBe('boolean');
      }
    }
    const readOnly = tools.filter((t) => t.annotations!.readOnlyHint).map((t) => t.name);
    expect(readOnly).toEqual(['get_adjustments', 'list_controls', 'render_preview', 'capture_view', 'get_selection', 'get_image_info', 'get_histogram', 'list_layers', 'get_transform_frame', 'get_smart_object', 'export_smart_object_contents', 'get_shape_layer', 'list_fonts', 'get_text_layer', 'list_layer_effects', 'get_mixer_brush', 'get_paint', 'get_color_profile', 'convert_colors', 'get_retouch_options', 'mix_colors', 'inspect_psd', 'export_psd']);
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

  it('changes, reorders and removes adjustment layers as single undo steps', async () => {
    const { controller, registry } = setup();
    const a = controller.addAdjustmentLayer('vibrance');
    const b = controller.addAdjustmentLayer('hueSaturation');

    const updated = await registry.callTool('update_adjustment_layer', { layer: a, blend: 'multiply', enabled: false, name: 'Pop' });
    expect((updated.structuredContent as any).layer).toMatchObject({ id: a, blend: 'multiply', enabled: false, name: 'Pop' });
    controller.undo();
    expect(controller.getAdjustmentLayer(a)).toMatchObject({ blend: 'normal', enabled: true });

    const moved = await registry.callTool('move_adjustment_layer', { layer: a, to: 9 });
    expect(moved.structuredContent).toEqual({ layer: a, index: 1, layers: [b, a] });
    const same = await registry.callTool('move_adjustment_layer', { layer: a, to: 1 });
    expect((same.content[0] as any).text).toBe(`Layer "${a}" is already at index 1 (0 = bottom, 1 = top).`);

    const removed = await registry.callTool('remove_adjustment_layer', { layer: b });
    expect(removed.structuredContent).toEqual({ removed: b, layers: [a] });
    const unknown = await registry.callTool('update_adjustment_layer', { layer: 'nope', enabled: true });
    expect((unknown.content[0] as any).text).toBe(`Unknown adjustment layer "nope". Layers: ${a}.`);
    const empty = await registry.callTool('update_adjustment_layer', { layer: a });
    expect((empty.content[0] as any).text).toMatch(/Nothing to change/);
  });

  it('crops, rotates, flips, undoes and redoes with the geometry echoed', async () => {
    const { controller, registry } = setup();
    const info = await registry.callTool('get_image_info', {});
    expect(info.structuredContent).toMatchObject({
      image: { width: 800, height: 600 }, crop: null, rotation: 0, output: { width: 800, height: 600 }, canUndo: false,
    });

    const cropped = await registry.callTool('set_crop', { x: 100, y: 50, width: 400, height: 300 });
    expect(cropped.structuredContent).toMatchObject({ crop: { x: 100, y: 50, width: 400, height: 300 }, output: { width: 400, height: 300 } });
    const outside = await registry.callTool('set_crop', { x: 500, y: 0, width: 400, height: 300 });
    expect((outside.content[0] as any).text).toMatch(/outside the 800 × 600 image/);

    const rotated = await registry.callTool('set_rotation', { degrees: 90 });
    expect(rotated.structuredContent).toMatchObject({ rotation: 90, output: { width: 300, height: 400 } });
    const flipped = await registry.callTool('flip_image', { axis: 'horizontal' });
    expect(flipped.structuredContent).toMatchObject({ flipH: true, flipV: false });

    expect((await registry.callTool('undo_image', {})).structuredContent).toEqual({ canUndo: true, canRedo: true });
    expect(controller.getState().transform.flipH).toBe(false);
    await registry.callTool('redo_image', {});
    expect(controller.getState().transform.flipH).toBe(true);

    await registry.callTool('reset_crop', {});
    expect(controller.getState().crop).toBeNull();
    expect((await registry.callTool('reset_crop', {})).isError).toBe(true);
    expect((await registry.callTool('redo_image', {})).isError).toBe(true);
  });

  it('get_histogram summarises clipping and levels, and asks for a render first', async () => {
    const { controller, registry } = setup();
    expect(((await registry.callTool('get_histogram', {})).content[0] as any).text).toMatch(/Call render_preview/);
    const bins = () => new Uint32Array(256);
    const red = bins(); red[0] = 10; red[255] = 90;
    const lum = bins(); lum[128] = 100;
    vi.spyOn(controller, 'getHistogram').mockReturnValue({
      red, green: bins(), blue: bins(), luminance: lum, samples: 100, transparent: 0,
      shadows: [10, 0, 0], highlights: [90, 0, 0], max: 100,
    });
    const res = (await registry.callTool('get_histogram', { bins: 16 })).structuredContent as any;
    expect(res.clipping.shadowsPercent.red).toBe(10);
    expect(res.clipping.highlightsPercent.red).toBe(90);
    expect(res.stats.luminance).toEqual({ mean: 128, p1: 128, p99: 128 });
    expect(res.bins.red).toHaveLength(16);
    expect(res.bins.red[15]).toBe(90);
  });

  it('render_preview reports an error where canvases are unavailable', async () => {
    const { registry } = setup();
    const res = await registry.callTool('render_preview', { maxSide: 64 });
    expect(res.isError).toBe(true);
  });
});
