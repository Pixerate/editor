import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { PaintEditorController, type PaintChange } from '@pixerate/editor/paint-editor';
import { PaintCanvas, createPaintChangeWatcher, createPaintProposalState } from '../src/paint-editor';

const line = (y: number) => Array.from({ length: 12 }, (_, i) => ({ x: 10 + i * 8, y, pressure: 0.7 }));

let target: HTMLDivElement;
beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as any;
  target = document.createElement('div');
  document.body.appendChild(target);
});
afterEach(() => {
  target.remove();
  vi.restoreAllMocks();
});

describe('createPaintProposalState and PaintCanvas ghosts (Svelte)', () => {
  it('draws pending proposals as ghosts, accepts one as the proposer and reports it in the change feed', () => {
    const c = new PaintEditorController({ width: 120, height: 80 });
    c.paintStroke({ points: line(20), brushId: 'soft-pastel' });
    const heard: PaintChange[] = [];
    const cleanup = $effect.root(() => {
      const state = createPaintProposalState(c, { origin: 'agent:pixie' });
      createPaintChangeWatcher(c, { onChange: (ch) => heard.push(ch) });
      const component = mount(PaintCanvas, { target, props: { controller: c, fitOnMount: false, proposals: state.store } });
      flushSync();
      const p = state.propose({ title: 'Echo below', ops: [{ kind: 'echo', strokeIds: [c.getStrokes()[0]!.id], dy: 30 }] });
      flushSync();
      expect(state.proposals.map((x) => x.id)).toEqual([p.id]);
      const ghost = target.querySelector(`[data-paint-proposal="${p.id}"]`) as HTMLCanvasElement;
      expect(ghost).not.toBeNull();
      expect(ghost.getAttribute('aria-label')).toBe('Suggested: Echo below');
      state.accept(p.id);
      flushSync();
      expect(target.querySelector('[data-paint-proposal]')).toBeNull();
      expect(heard.at(-1)).toMatchObject({ origin: 'agent:pixie', addedLayers: [{ name: 'Echo below' }] });
      unmount(component);
    });
    cleanup();
  });
});
