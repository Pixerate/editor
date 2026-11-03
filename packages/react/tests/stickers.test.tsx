// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { combineStickerProviders, createFakeStickerProvider, editorStickers } from '@pixerate/editor/stickers';
import { createCanvasStickerHost, getNodeShape, type CanvasNode } from '@pixerate/editor/canvas';
import { StickerInsertPanel, StickerLibraryPicker } from '../src/stickers';

let container: HTMLDivElement;
let root: any;
const win: any = window;
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  container = document.getElementById('root') as HTMLDivElement;
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));
const render = (el: React.ReactElement) => act(() => root.render(el));
const settle = () => act(async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
});
const button = (name: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLButtonElement;
const library = () => combineStickerProviders([editorStickers(), createFakeStickerProvider()]);

describe('sticker pickers', () => {
  it('StickerLibraryPicker searches, filters by category and pages any library', async () => {
    const picked: string[] = [];
    render(<StickerLibraryPicker provider={library()} selected={['editor:star']} onPick={(s) => picked.push(s.ref)} />);
    await settle();
    expect(container.querySelector('[aria-label="Stickers"] button[aria-pressed="true"]')!.textContent).toBe('Star');
    expect(container.textContent).toMatch(/24 of 25/);
    await act(async () => button('More').click());
    await settle();
    expect(container.querySelectorAll('[aria-label="Stickers"] button')).toHaveLength(25);
    const select = container.querySelector('select[aria-label="Sticker category"]') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value')!.set!.call(select, 'badges');
      select.dispatchEvent(new win.Event('change', { bubbles: true }));
    });
    await settle();
    expect([...container.querySelectorAll('[aria-label="Stickers"] button')].map((b) => b.textContent)).toEqual(['New badge', 'Sale badge', 'Hot badge', 'Free badge']);
    await act(async () => button('Hot badge').click());
    expect(picked).toEqual(['fake:badge-hot']);
  });

  it('StickerInsertPanel inserts a picked sticker through a host, tinted when asked', async () => {
    let nodes: CanvasNode[] = [{ id: 'frame', position: { x: 0, y: 0 }, width: 300, height: 200, data: {} }];
    const host = createCanvasStickerHost({ getNodes: () => nodes, setNodes: (n) => (nodes = n) });
    const inserted: string[] = [];
    render(<StickerInsertPanel provider={library()} host={host} onInserted={(r) => inserted.push(r.ref)} />);
    await settle();
    await act(async () => (container.querySelector('input[aria-label="Tint stickers"]') as HTMLInputElement).click());
    await act(async () => button('Heart').click());
    await settle();
    expect(inserted).toEqual(['editor:heart']);
    const heart = nodes.find((n) => n.data.sticker?.ref === 'editor:heart')!;
    expect(getNodeShape(heart)).toMatchObject({ kind: 'path', fill: '#2563eb' });
    expect(heart.position).toEqual({ x: 100, y: 50 });
    // Art with its own colours ignores the tint, rather than being refused.
    await act(async () => button('Apple').click());
    await settle();
    expect(getNodeShape(nodes.find((n) => n.data.sticker?.ref === 'fake:fruit-apple')!)).toMatchObject({ fill: '#dc2626' });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
