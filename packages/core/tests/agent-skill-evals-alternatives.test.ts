/**
 * Workflow skill evals judge the outcome, not one way of getting it (`skills/README.md`). These
 * are the other routes their skills allow, which the evals must accept as well as `solution`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToolRegistry, failedEvalChecks, imageEvalFixturePixels, type ImageEvalFixture, type SkillEval } from '../src/tools';
import { ImageEditorController, createImageEditorToolProvider } from '../src/image-editor';

function setup(path: string) {
  const ev = JSON.parse(readFileSync(join(__dirname, '..', 'skills', path), 'utf8')) as SkillEval;
  const f = ev.fixture as ImageEvalFixture;
  const fake = { width: f.width, height: f.height, naturalWidth: f.width, naturalHeight: f.height, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels(imageEvalFixturePixels(f));
  const registry = new ToolRegistry();
  registry.register(createImageEditorToolProvider(c));
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const res = await registry.callTool(tool, args);
    if (res.isError) throw new Error(String((res.content?.[0] as { text?: string })?.text));
    return res.structuredContent as Record<string, any>;
  };
  const failed = (filter: (why: string) => boolean = () => true) =>
    failedEvalChecks((tool, args) => registry.callTool(tool, args), ev.checks.filter((c) => filter(c.why)));
  return { call, failed };
}

describe('workflow skill evals accept the routes their skills allow', () => {
  it('neutralise-cast: white balance in the base sliders counts as adjustable', async () => {
    const { call, failed } = setup('pixerate-image-photo-correction/evals/neutralise-cast.json');
    const adjustable = (why: string) => why.includes('adjustable');
    expect(await failed(adjustable)).toHaveLength(1);
    await call('set_adjustments', { values: { temperature: 30 } });
    expect(await failed(adjustable)).toEqual([]);
    // Leaving the card as bright as it was is not a failure: the task asks only for neutral.
    expect(await failed((why) => why.includes('mid grey'))).toEqual([]);
  });

  it('grounding-shadow: Separate Subject’s masked layer is the product on its own layer', async () => {
    const { call, failed } = setup('pixerate-image-product-photo/evals/grounding-shadow.json');
    await call('magic_wand', { x: 60, y: 45, tolerance: 20, contiguous: true });
    const { foregroundLayerId } = await call('separate_subject', { fill: 'none' });
    await call('add_layer_effect', { layerId: foregroundLayerId, kind: 'drop-shadow', settings: { distance: 6, size: 10, opacity: 0.4, angle: 90 } });
    expect(await failed()).toEqual([]);
  });

  it('remove-blemishes: the skill’s brush size heals the spot; one just over it leaves the edge', async () => {
    const heal = async (size: number) => {
      const { call, failed } = setup('pixerate-image-portrait-retouch/evals/remove-blemishes.json');
      await call('add_pixel_layer', { name: 'Retouch' });
      for (const p of [{ x: 30, y: 30 }, { x: 70, y: 22 }]) await call('spot_heal', { points: [p], sample: 'current-below', brush: { size, hardness: 0.3 } });
      return failed();
    };
    // The spots are 3 px: pixerate-image-portrait-retouch says 2.5-3× with a soft brush.
    expect(await heal(5)).toHaveLength(2);
    expect(await heal(9)).toEqual([]);
  });
});
