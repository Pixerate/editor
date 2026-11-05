// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { combineStickerProviders, createFakeStickerProvider, editorStickers } from '@pixerate/editor/stickers';
import { createCanvasStickerHost, getNodeShape, type CanvasNode } from '@pixerate/editor/canvas';
import { StickerInsertPanel, StickerLibraryPicker } from '../src/stickers';

let target: HTMLElement;
let app: Record<string, unknown> | null = null;
beforeEach(() => {
  target = document.createElement('div');
  document.body.appendChild(target);
});
afterEach(() => {
  if (app) unmount(app);
  app = null;
  target.remove();
});
const show = (C: any, props: Record<string, unknown>) => {
  app = mount(C, { target, props });
  flushSync();
};
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  flushSync();
};
const button = (name: string) => [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLButtonElement;
const library = () => combineStickerProviders([editorStickers(), createFakeStickerProvider()]);

describe('sticker pickers', () => {
  it('StickerLibraryPicker searches, filters by category and pages any library', async () => {
    const picked: string[] = [];
    show(StickerLibraryPicker, { provider: library(), selected: ['editor:star'], onpick: (s: { ref: string }) => picked.push(s.ref) });
    await settle();
    expect(target.querySelector('[aria-label="Stickers"] button[aria-pressed="true"]')!.textContent?.trim()).toBe('Star');
    expect(target.textContent).toMatch(/24 of 25/);
    button('More').click();
    await settle();
    expect(target.querySelectorAll('[aria-label="Stickers"] button')).toHaveLength(25);
    const select = target.querySelector('select[aria-label="Sticker category"]') as HTMLSelectElement;
    select.value = 'badges';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect([...target.querySelectorAll('[aria-label="Stickers"] button')].map((b) => b.textContent?.trim())).toEqual(['New badge', 'Sale badge', 'Hot badge', 'Free badge']);
    button('Hot badge').click();
    expect(picked).toEqual(['fake:badge-hot']);
  });

  it('StickerLibraryPicker filters by collection and labels AI-generated art', async () => {
    show(StickerLibraryPicker, { provider: library(), onpick: () => {} });
    await settle();
    const select = target.querySelector('select[aria-label="Sticker collection"]') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['All collections', 'Outdoors (6)', 'Kitchen (5)', 'Shop (4)']);
    select.value = 'fake:outdoors';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    const items = [...target.querySelectorAll('[aria-label="Stickers"] button')];
    expect(items).toHaveLength(6);
    expect(items.every((b) => b.querySelector('[aria-label="AI-generated"]'))).toBe(true);
    expect(items[0].getAttribute('title')).toMatch(/· AI-generated$/);
    unmount(app!);
    show(StickerLibraryPicker, { provider: editorStickers(), onpick: () => {} });
    await settle();
    expect(target.querySelector('select[aria-label="Sticker collection"]')).toBeNull();
  });

  it('StickerInsertPanel inserts a picked sticker through a host, tinted when asked', async () => {
    let nodes: CanvasNode[] = [{ id: 'frame', position: { x: 0, y: 0 }, width: 300, height: 200, data: {} }];
    const host = createCanvasStickerHost({ getNodes: () => nodes, setNodes: (n) => (nodes = n) });
    const inserted: string[] = [];
    show(StickerInsertPanel, { provider: library(), host, oninserted: (r: { ref: string }) => inserted.push(r.ref) });
    await settle();
    (target.querySelector('input[aria-label="Tint stickers"]') as HTMLInputElement).click();
    flushSync();
    button('Heart').click();
    await settle();
    expect(inserted).toEqual(['editor:heart']);
    const heart = nodes.find((n) => n.data.sticker?.ref === 'editor:heart')!;
    expect(getNodeShape(heart)).toMatchObject({ kind: 'path', fill: '#2563eb' });
    expect(heart.position).toEqual({ x: 100, y: 50 });
    button('Apple').click();
    await settle();
    expect(getNodeShape(nodes.find((n) => n.data.sticker?.ref === 'fake:fruit-apple')!)).toMatchObject({ fill: '#dc2626' });
    expect(target.querySelector('[role="alert"]')).toBeNull();
  });
});
