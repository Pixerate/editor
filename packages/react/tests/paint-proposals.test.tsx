// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { PaintEditorController, createPaintAgentStrokes, createPaintProposalToolProvider, type PaintChange } from '@pixerate/editor/paint-editor';
import { ToolRegistry } from '@pixerate/editor/tools';
import { PaintCanvas, usePaintChangeFeed, usePaintProposals, type PaintProposalsHandle } from '../src/paint-editor';

let container: HTMLDivElement;
let root: any;

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLCanvasElement.prototype.getContext = (() => null) as any;
});
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  container = document.getElementById('root') as HTMLDivElement;
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
});

const line = (y: number) => Array.from({ length: 12 }, (_, i) => ({ x: 10 + i * 8, y, pressure: 0.7 }));

describe('usePaintProposals and PaintCanvas ghosts (React)', () => {
  it('draws pending proposals as ghosts, accepts one as the proposer and reports it in the change feed', () => {
    const c = new PaintEditorController({ width: 120, height: 80 });
    c.paintStroke({ points: line(20), brushId: 'soft-pastel' });
    const heard: PaintChange[] = [];
    const out: { handle?: PaintProposalsHandle } = {};
    function Host() {
      const proposals = usePaintProposals(c, { origin: 'agent:pixie' });
      usePaintChangeFeed(c, { onChange: (ch) => heard.push(ch) });
      out.handle = proposals;
      return <PaintCanvas controller={c} fitOnMount={false} proposals={proposals.store} />;
    }
    act(() => root.render(<React.StrictMode><Host /></React.StrictMode>));
    let id = '';
    act(() => {
      id = out.handle!.propose({ title: 'Echo below', rationale: 'Repeats your stroke.', ops: [{ kind: 'echo', strokeIds: [c.getStrokes()[0]!.id], dy: 30 }] }).id;
    });
    const ghost = container.querySelector(`[data-paint-proposal="${id}"]`) as HTMLCanvasElement;
    expect(ghost).not.toBeNull();
    expect(ghost.getAttribute('aria-label')).toBe('Suggested: Echo below');
    expect(ghost.style.transform).toMatch(/translate\(\d+px, \d+px\)$/);
    expect(out.handle!.proposals).toHaveLength(1);
    act(() => {
      out.handle!.accept(id);
    });
    expect(container.querySelector('[data-paint-proposal]')).toBeNull();
    expect(heard.at(-1)).toMatchObject({ origin: 'agent:pixie', addedLayers: [{ name: 'Echo below' }] });
    expect(heard.at(-1)!.addedStrokes).toHaveLength(1);
  });

  it('gives agents the proposal tools on the same store', async () => {
    const c = new PaintEditorController({ width: 120, height: 80 });
    const out: { handle?: PaintProposalsHandle } = {};
    function Host() {
      out.handle = usePaintProposals(c);
      return null;
    }
    act(() => root.render(<Host />));
    const registry = new ToolRegistry();
    registry.register(createPaintProposalToolProvider(out.handle!.store));
    let result: any;
    await act(async () => {
      result = await registry.callTool('paint-proposals__propose_paint', { title: 'Warm ground', place: 'bottom', ops: [{ kind: 'wash', color: '#e8c9a0' }] }, { actor: { id: 'pixie' } } as never);
    });
    expect(result.structuredContent).toMatchObject({ title: 'Warm ground', origin: 'agent:pixie', placement: { place: 'bottom' }, bounds: { x: 0, y: 0, width: 120, height: 80 } });
    expect(out.handle!.proposals).toHaveLength(1);
  });

  it('draws an agent\'s live strokes over the canvas', () => {
    const c = new PaintEditorController({ width: 120, height: 80 });
    const strokes = createPaintAgentStrokes();
    act(() => root.render(<PaintCanvas controller={c} fitOnMount={false} agentStrokes={strokes} />));
    act(() => strokes.set({ id: 'k1', origin: 'agent:pixie', points: [{ x: 1, y: 2 }, { x: 30, y: 40 }], color: '#ff8800', size: 6, opacity: 0.5 }));
    const line = container.querySelector('[data-agent-stroke="k1"]')!;
    expect(line.getAttribute('points')).toBe('1,2 30,40');
    expect(line.getAttribute('stroke')).toBe('#ff8800');
    act(() => strokes.clear());
    expect(container.querySelector('[data-agent-stroke]')).toBeNull();
  });
});
