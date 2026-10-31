import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, createImageEditorToolProvider, readRecipeStep, replaySelectionRecipe } from '../src/image-editor';

const W = 100;
const H = 60;

/** A horizontal grey ramp: x 0 → black, x 99 → near white. */
function ramp(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set([x * 2.5, x * 2.5, x * 2.5, 255], (y * W + x) * 4);
  return data;
}

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: ramp() });
  const registry = new ToolRegistry();
  registry.register(createImageEditorToolProvider(c));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await registry.callTool(name, args);
    if (res.isError) throw new Error(String((res.content?.[0] as { text?: string })?.text ?? 'tool error'));
    return res.structuredContent as Record<string, any>;
  };
  const fails = async (name: string, args: Record<string, unknown>, pattern: RegExp) => {
    const res = await registry.callTool(name, args);
    expect(res.isError, `${name} should fail`).toBe(true);
    expect(String((res.content?.[0] as { text?: string })?.text)).toMatch(pattern);
  };
  return { c, call, fails };
}

const ops = (r: { steps: Array<{ op: string }> }) => r.steps.map((s) => s.op);

describe('live selections (recipes)', () => {
  it('records the steps that made the selection', async () => {
    const { c, call } = setup();
    await call('select_rect', { x: 10, y: 10, width: 30, height: 20 });
    await call('select_ellipse', { x: 50, y: 10, width: 20, height: 20, mode: 'add' });
    await call('modify_selection', { op: 'smooth', radius: 2 });
    const r = await call('get_selection_recipe');
    expect(r.recipe.live).toBe(true);
    expect(ops(r.recipe)).toEqual(['rect', 'ellipse', 'modify']);
    expect(r.recipe.steps[1]).toMatchObject({ index: 1, op: 'ellipse', mode: 'add', rect: { x: 50, y: 10, width: 20, height: 20 } });
    // A replacing shape starts a new recipe.
    await call('select_rect', { x: 0, y: 0, width: 5, height: 5 });
    expect(ops(c.getSelectionRecipe())).toEqual(['rect']);
  });

  it('edits a step and replays, as one undo step', async () => {
    const { c, call } = setup();
    await call('select_rect', { x: 10, y: 10, width: 30, height: 20, antiAlias: false });
    await call('select_rect', { x: 20, y: 15, width: 5, height: 5, mode: 'subtract', antiAlias: false });
    const before = c.getSelection()!;
    const r = await call('edit_selection_step', { index: 0, changes: { rect: { x: 10, y: 10, width: 60, height: 20 } } });
    expect(r.bounds).toEqual({ x: 10, y: 10, width: 60, height: 20 });
    expect(r.area).toBe(60 * 20 - 25);
    expect(r.recipe.steps[0].rect.width).toBe(60);
    c.undo();
    expect(c.getSelection()).toBe(before);
    expect(c.getSelectionRecipe().steps[0]).toMatchObject({ rect: { width: 30 } });
  });

  it('re-runs pixel steps with new settings: a wider magic wand tolerance selects more', async () => {
    const { c, call } = setup();
    await call('magic_wand', { x: 50, y: 30, tolerance: 10, contiguous: true });
    const narrow = c.getSelection()!.bounds!.width;
    const step = c.getSelectionRecipe().steps[0] as { op: string; options: Record<string, unknown> };
    expect(step.op).toBe('magic-wand');
    expect(step.options.tolerance).toBe(10);
    await call('edit_selection_step', { index: 0, changes: { options: { ...step.options, tolerance: 40 } } });
    expect(c.getSelection()!.bounds!.width).toBeGreaterThan(narrow);
  });

  it('inserts and removes steps', async () => {
    const { c, call } = setup();
    await call('select_rect', { x: 10, y: 10, width: 40, height: 40, antiAlias: false });
    await call('invert_selection');
    let r = await call('insert_selection_step', { index: 1, step: { op: 'rect', rect: { x: 60, y: 10, width: 10, height: 10 }, mode: 'add', antiAlias: false } });
    expect(ops(r.recipe)).toEqual(['rect', 'rect', 'invert']);
    expect(r.area).toBe(W * H - 1600 - 100);
    r = await call('remove_selection_step', { index: 2 });
    expect(ops(r.recipe)).toEqual(['rect', 'rect']);
    expect(r.area).toBe(1700);
    // Appending with index = length.
    r = await call('insert_selection_step', { index: 2, step: { op: 'modify', modify: 'contract', radius: 1 } });
    expect(ops(r.recipe)).toEqual(['rect', 'rect', 'modify']);
    expect(c.getSelection()!.bounds!.x).toBe(11);
  });

  it('freezes on demand and when a command no step describes changes the selection', async () => {
    const { c, call } = setup();
    await call('select_rect', { x: 10, y: 10, width: 30, height: 20 });
    expect((await call('freeze_selection')).recipe.live).toBe(false);
    expect(c.getSelection()!.bounds).toEqual({ x: 10, y: 10, width: 30, height: 20 });
    c.undo();
    expect(c.getSelectionRecipe().live).toBe(true);
    // A frozen selection stays frozen when added to.
    await call('select_line', { orientation: 'row', position: 50 });
    await call('select_rect', { x: 0, y: 0, width: 5, height: 5, mode: 'add' });
    expect(c.getSelectionRecipe().live).toBe(false);
    // Deselect leaves no recipe.
    await call('select_rect', { x: 0, y: 0, width: 5, height: 5 });
    await call('deselect');
    expect(c.getSelectionRecipe()).toEqual({ live: false, steps: [] });
  });

  it('is saved with the document', async () => {
    const { c, call } = setup();
    await call('select_rect', { x: 10, y: 10, width: 30, height: 20 });
    await call('modify_selection', { op: 'feather', radius: 3 });
    const d = new ImageEditorController({ image: { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement });
    await d.loadJSON(c.toJSON());
    expect(d.getSelectionRecipe()).toEqual(c.getSelectionRecipe());
  });

  it('replays as a pure function', () => {
    const steps = [readRecipeStep({ op: 'all' }), readRecipeStep({ op: 'rect', rect: { x: 0, y: 0, width: 50, height: 60 }, mode: 'subtract', antiAlias: false })];
    const sel = replaySelectionRecipe(steps, W, H, () => {
      throw new Error('no pixels needed');
    })!;
    expect(sel.bounds).toEqual({ x: 50, y: 0, width: 50, height: 60 });
    expect(replaySelectionRecipe([readRecipeStep({ op: 'invert' })], W, H, () => ({ width: 0, height: 0, data: [] }))!.bounds).toEqual({ x: 0, y: 0, width: W, height: H });
  });

  it('fails usefully and changes nothing', async () => {
    const { c, call, fails } = setup();
    await fails('edit_selection_step', { index: 0, changes: { radius: 2 } }, /no recipe to edit/);
    await call('select_rect', { x: 10, y: 10, width: 30, height: 20 });
    const before = c.getSelection();
    await fails('edit_selection_step', { index: 3, changes: { mode: 'add' } }, /index must be 0\.\.0 \(the recipe has 1 step/);
    await fails('edit_selection_step', { index: 0, changes: { rect: { x: 0, y: 0, width: -4, height: 3 } } }, /rect|minimum|exclusiveMinimum/);
    await fails('insert_selection_step', { index: 0, step: { op: 'modify', modify: 'smooth', radius: 2 } }, /Step 0 \(modify\) has nothing selected/);
    await fails('insert_selection_step', { index: 1, step: { op: 'paint' } }, /op|enum/);
    await fails('remove_selection_step', { index: 0 }, /only step; deselect/);
    expect(c.getSelection()).toBe(before);
    expect(ops(c.getSelectionRecipe())).toEqual(['rect']);
  });
});
