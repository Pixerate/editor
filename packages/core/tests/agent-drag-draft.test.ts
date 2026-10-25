import { describe, it, expect } from 'vitest';
import { PresenceStore, trackPresenceDrag, type PresenceDragBox } from '../src/tools';
import { agentDragDraft } from '../src/image-editor';

describe('trackPresenceDrag', () => {
  it('reports the box from the press to the cursor, then the end', () => {
    const store = new PresenceStore();
    const boxes: PresenceDragBox[] = [];
    let ended = 0;
    store.subscribe(trackPresenceDrag({ onDrag: (b) => boxes.push(b), onEnd: () => (ended += 1) }));
    store.set({ id: 'a', x: 10, y: 10 });
    expect(boxes).toEqual([]);
    store.set({ id: 'a', pressed: true });
    store.set({ id: 'a', x: 4, y: 30 });
    store.set({ id: 'a', pressed: false });
    expect(boxes.at(-1)).toEqual({ x: 4, y: 10, width: 6, height: 20 });
    expect(ended).toBe(1);
  });

  it('ends a drag when the cursor leaves the surface', () => {
    const store = new PresenceStore();
    let ended = 0;
    store.subscribe(trackPresenceDrag({ onDrag: () => {}, onEnd: () => (ended += 1) }));
    store.set({ id: 'a', x: 0, y: 0, pressed: true });
    store.remove('a');
    expect(ended).toBe(1);
  });
});

describe('agentDragDraft', () => {
  const image = { width: 100, height: 50 };
  it('clamps a crop box to the image in crop mode', () => {
    expect(agentDragDraft('crop', { x: 80, y: -5, width: 40, height: 30 }, image)).toEqual({
      crop: { x: 80, y: 0, width: 20, height: 30 },
    });
  });
  it('makes a marquee path in select mode', () => {
    expect(agentDragDraft('select', { x: 1, y: 2, width: 3, height: 4 }, image)).toEqual({
      selectionPath: [
        { x: 1, y: 2 },
        { x: 4, y: 2 },
        { x: 4, y: 6 },
        { x: 1, y: 6 },
      ],
    });
  });
  it('draws nothing in other modes', () => {
    expect(agentDragDraft('paint', { x: 0, y: 0, width: 5, height: 5 }, image)).toBeNull();
  });
});
