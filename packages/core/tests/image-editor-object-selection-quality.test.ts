// Object Selection without a model (GrabCut), scored against known masks: the synthetic photos in
// fixtures/object-selection-scenes.ts with a box or a click on each. The floors sit a little under
// what it scores today, so a change that makes it worse fails here; tests/evals/object-selection.eval.ts
// prints the full table (IoU, edge report, time).
import { describe, expect, it } from 'vitest';
import { selectObjectIn, selectionValueAt } from '../src/image-editor';
import { OBJECT_SELECTION_CASES, scoreSelection } from './fixtures/object-selection-scenes';

/** Lowest IoU each case may score. */
const FLOORS: Record<string, number> = {
  'orange, tight box': 0.98,
  // The shadow is in the box and not in the band around it, so GrabCut takes it: a known limit.
  'orange, loose box': 0.83,
  'orange, click': 0.98,
  'small orange, box': 0.96,
  'small orange, click': 0.96,
  'clear castle, box': 0.97,
  'clear castle, click': 0.97,
  'haze castle, box': 0.96,
  'haze castle, loose box': 0.96,
  'haze castle, click': 0.96,
  // The dog's brown is the earth's brown: only the white patches set it apart. A known limit.
  'shared colours, box': 0.6,
  'shared colours, click': 0.7,
  // 5 px wide: about 2 px in the 512 px working copy, so its outline is a working pixel off.
  'thin pole, box': 0.82,
  'dumbbell, box': 0.97,
  'dumbbell, click': 0.97,
  'stone in river, box': 0.95,
  // Without the small-disk fallback the click took the river (IoU 0.005).
  'stone in river, click': 0.95,
};

describe('object selection quality without a model', () => {
  it('has a floor for every case', () => {
    expect(OBJECT_SELECTION_CASES.map((c) => c.label).sort()).toEqual(Object.keys(FLOORS).sort());
  });

  // GrabCut on a 1200 × 800 scene. A click can grow its window to the whole image and cut several
  // times (the stone in a river: ~1 s here, 3.6 s of the default 5 s on CI), so each case gets
  // a longer timeout; the scenes are what the floors were measured on.
  for (const c of OBJECT_SELECTION_CASES) {
    it(`${c.label} scores at least its floor`, { timeout: 20_000 }, () => {
      const scene = c.scene();
      const mask = selectObjectIn(scene, c.target);
      const { iou } = scoreSelection(scene, (x, y) => selectionValueAt(mask, x, y));
      expect(iou).toBeGreaterThanOrEqual(FLOORS[c.label]);
    });
  }

  it('a click on a castle in mist selects the castle, not the whole image', () => {
    const c = OBJECT_SELECTION_CASES.find((k) => k.label === 'haze castle, click')!;
    const scene = c.scene();
    const mask = selectObjectIn(scene, c.target);
    const b = mask.bounds!;
    // The castle spans x 410..790 and y 140..~700; the misty hill below runs the image's width.
    expect(b.x).toBeGreaterThan(380);
    expect(b.x + b.width).toBeLessThan(820);
    expect(b.y).toBeGreaterThan(110);
    expect(selectionValueAt(mask, 100, 100)).toBe(0);
    expect(selectionValueAt(mask, 600, 780)).toBe(0);
  });
});
