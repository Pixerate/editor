import { describe, expect, it } from 'vitest';
import { ImageEditorController, createImageEditorToolProvider } from '../src/image-editor';
import { ToolRegistry, failedEvalChecks, imageEvalFixturePixels, listSkillEvals, type ImageEvalFixture } from '../src/tools';

describe('skill evals for agent harnesses', () => {
  it('lists eval files from a set of skill files, ignoring the skills themselves', () => {
    const evals = listSkillEvals({
      'pixerate-x/SKILL.md': '---\nname: pixerate-x\n---\n',
      'pixerate-x/evals/b.json': '{"prompt":"b","fixture":{"editor":"spreadsheet","rows":[]},"checks":[],"solution":[]}',
      './pixerate-x/evals/a.json': '{"prompt":"a","fixture":{"editor":"spreadsheet","rows":[]},"checks":[],"solution":[]}',
    });
    expect(evals.map((e) => [e.skill, e.path, e.eval.prompt])).toEqual([
      ['pixerate-x', 'pixerate-x/evals/a.json', 'a'],
      ['pixerate-x', 'pixerate-x/evals/b.json', 'b'],
    ]);
  });

  it("paints an image fixture and runs an eval's checks through a namespaced registry", async () => {
    const fixture: ImageEvalFixture = { editor: 'image', width: 20, height: 10, background: [0, 0, 255], shapes: [{ shape: 'rect', x: 5, y: 2, width: 6, height: 4, color: [255, 0, 0] }] };
    const pixels = imageEvalFixturePixels(fixture);
    expect(Array.from(pixels.data.slice((3 * 20 + 6) * 4, (3 * 20 + 6) * 4 + 4))).toEqual([255, 0, 0, 255]);
    const fake = { width: 20, height: 10, naturalWidth: 20, naturalHeight: 10, src: 'data:fake' } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake });
    c.setSamplePixels(pixels);
    const registry = new ToolRegistry();
    registry.register(createImageEditorToolProvider(c, { id: 'image1' }));
    const callTool = (tool: string, args: Record<string, unknown>) => registry.callTool(tool, args);
    const checks = [{ why: 'the red box is selected', tool: 'get_selection', expect: { empty: false, bounds: { x: 5, y: 2, width: 6, height: 4 } } }];
    expect(await failedEvalChecks(callTool, checks)).toHaveLength(1);
    await registry.callTool('select_rect', { x: 5, y: 2, width: 6, height: 4 });
    expect(await failedEvalChecks(callTool, checks)).toEqual([]);
  });
});
