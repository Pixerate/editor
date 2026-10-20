// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createFakeEffectProvider } from '@pixerate/editor/effects';
import { ManualClock } from '@pixerate/editor/animation';
import { AnimationEditorController } from '@pixerate/editor/animation-editor';
import { VectorEditorController, rectSubpath, type VectorGroupNode } from '@pixerate/editor/vector';
import { AnimationEditor, AnimationEffectsPanel } from '../src/animation-editor';
import { VectorProviderEffectsPanel } from '../src/vector';

let container: HTMLDivElement;
let root: any;
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLCanvasElement.prototype.getContext = (() => null) as any;
});
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).click());
  await settle();
  await settle();
};
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
const q = (sel: string) => container.querySelector(sel)!;
const artwork = { width: 200, height: 100, background: '#fff', nodes: [{ id: 'box', type: 'path' as const, fill: '#f00', subpaths: [rectSubpath({ x: 10, y: 10, width: 30, height: 30 })] }] };
const anim = (effects: ReturnType<typeof createFakeEffectProvider> | null = createFakeEffectProvider()) =>
  new AnimationEditorController({ scene: { version: 1, name: 't', artwork, shots: [] }, clock: new ManualClock(), effects });

describe('motion effects (React)', () => {
  it('AnimationEditor shows the effects panel only with a provider', () => {
    const plain = anim(null);
    act(() => root.render(<AnimationEditor controller={plain} />));
    expect(container.querySelector('[data-animation-effects]')).toBeNull();
    const provider = createFakeEffectProvider();
    act(() => root.render(<AnimationEditor controller={plain} effects={provider} />));
    expect(plain.effectsProvider).toBe(provider);
    expect(container.querySelector('[data-animation-effects]')).not.toBeNull();
  });

  it('AnimationEffectsPanel animates a node, adds a vector effect and removes them', async () => {
    const c = anim();
    act(() => root.render(<AnimationEffectsPanel controller={c} node="box" />));
    await click(button('Animate…'));
    await click(q('[data-effect-id="fake.fade-in"]'));
    expect(c.appliedEffects().map((e) => [e.instance, e.kind, e.targets])).toEqual([['fx1', 'motion', ['box']]]);
    await click(button('Vector effect…'));
    expect(container.querySelector('[data-effect-id="fake.fade-in"]')).toBeNull();
    await click(q('[data-effect-id="fake.badge"]'));
    expect(c.appliedEffects().map((e) => e.kind)).toEqual(['motion', 'vector']);
    await click(q('[aria-label="Remove Fade in"]'));
    expect(c.appliedEffects().map((e) => e.instance)).toEqual(['fx2']);
  });

  it('VectorProviderEffectsPanel adds a vector effect group and detaches it', async () => {
    const c = new VectorEditorController({ document: artwork });
    c.setEffectsProvider(createFakeEffectProvider());
    act(() => root.render(<VectorProviderEffectsPanel controller={c} />));
    await click(button('Add effect…'));
    expect([...container.querySelectorAll('[data-effect-id]')].map((b) => b.getAttribute('data-effect-id'))).toEqual(['fake.badge']);
    await click(q('[data-effect-id="fake.badge"]'));
    const g = c.vectorEffectGroups()[0] as VectorGroupNode;
    expect(g.providerEffect?.effect).toBe('fake.badge');
    expect(container.querySelector(`[data-vector-effect-group="${g.id}"]`)).not.toBeNull();
    await click(button('Detach'));
    expect(c.vectorEffectGroups()).toEqual([]);
  });
});
