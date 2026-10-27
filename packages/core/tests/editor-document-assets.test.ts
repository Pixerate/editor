import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EDITOR_ASSET_PREFIX,
  collectAssetRefs,
  createDocumentToolProvider,
  createEditorAssetRegistry,
  createEditorAutosave,
  createEditorDocumentStore,
  createMemoryStorage,
  externalizeAssets,
  internalizeAssets,
  withEditorAssets,
} from "../src/persistence";
import { ToolRegistry } from "../src/tools";
import { ImageEditorController, createImageEditorDocument, readPixel, type PixelLayer } from "../src/image-editor";
import { PaintEditorController, createPaintEditorDocument } from "../src/paint-editor";

const text = (result: any) => result.content?.[0]?.text as string;

const W = 40;
const H = 20;

/** An image editor with one noisy pixel layer (so its PNG is large enough to be an asset). */
function imageEditor() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  const base = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < base.length; i += 4) base.set([200, 100, 50, 255], i);
  c.setSamplePixels({ width: W, height: H, data: base });
  const noise = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 7919 + (i >> 3) * 104729) % 251;
  for (let i = 3; i < noise.length; i += 4) noise[i] = 255;
  const id = c.addPixelLayer({ pixels: { width: W, height: H, data: noise } });
  return { c, id, noise };
}

const bigDataUrl = (seed: number) => `data:image/png;base64,${Array.from({ length: 800 }, (_, i) => "ABCDEFGHIJKLMNOP"[(i * seed) % 16]).join("")}`;

describe("editor asset registry", () => {
  it("replaces inline data with content-addressed references and back", () => {
    const registry = createEditorAssetRegistry();
    const a = bigDataUrl(3);
    const doc = { layers: [{ png: a }, { png: a }, { png: bigDataUrl(5) }], name: "short", tiny: "data:image/png;base64,AAAA" };
    const out = externalizeAssets(doc, registry);
    expect(out.layers[0].png.startsWith(EDITOR_ASSET_PREFIX)).toBe(true);
    expect(out.layers[0].png).toBe(out.layers[1].png);
    expect(out.layers[2].png).not.toBe(out.layers[0].png);
    expect(out.name).toBe("short");
    expect(out.tiny).toBe(doc.tiny);
    expect(registry.size).toBe(2);
    expect(collectAssetRefs(out)).toHaveLength(2);
    expect(internalizeAssets(out, registry)).toEqual(doc);
    // The input is not changed.
    expect(doc.layers[0].png).toBe(a);
  });

  it("refuses references it does not have, naming them", () => {
    const registry = createEditorAssetRegistry();
    const ref = externalizeAssets({ png: bigDataUrl(3) }, registry).png;
    expect(() => internalizeAssets({ png: ref }, createEditorAssetRegistry())).toThrow(/1 asset that is not loaded \(pixerate-asset:/);
  });

  it("keeps long base64 out too, but not ordinary long text", () => {
    const registry = createEditorAssetRegistry();
    const base64 = "QUJD".repeat(1200);
    const prose = "word ".repeat(1200);
    const out = externalizeAssets({ deep: base64, note: prose }, registry);
    expect(out.deep.startsWith(EDITOR_ASSET_PREFIX)).toBe(true);
    expect(out.note).toBe(prose);
  });

  it("saves assets before the value and reads them back on get", async () => {
    const storage = createMemoryStorage();
    const registry = createEditorAssetRegistry();
    const doc = externalizeAssets({ png: bigDataUrl(7) }, registry);
    await withEditorAssets(storage, registry).set("doc", JSON.stringify(doc));
    expect([...storage.entries.keys()].filter((k) => k.startsWith("pixerate.assets:"))).toHaveLength(1);
    const fresh = createEditorAssetRegistry();
    const read = await withEditorAssets(storage, fresh).get("doc");
    expect(internalizeAssets(JSON.parse(read!), fresh).png).toBe(bigDataUrl(7));
  });
});

describe("image editor documents", () => {
  it("hold references, not pixels, and load back into another editor", () => {
    const { c, id, noise } = imageEditor();
    const doc = createImageEditorDocument(c);
    const json = JSON.stringify(doc.getDocument());
    expect(json).not.toMatch(/data:image\/png;base64,[A-Za-z0-9+/=]{600}/);
    expect(collectAssetRefs(json).length).toBeGreaterThan(0);

    // A second editor sharing the registry opens it.
    const other = imageEditor().c;
    const otherDoc = createImageEditorDocument(other, { assets: doc.assets });
    otherDoc.loadDocument(doc.getDocument());
    expect(readPixel((other.getLayer(id) as PixelLayer).surface, 3, 3)).toEqual([...noise.slice((3 * W + 3) * 4, (3 * W + 3) * 4 + 4)]);
    expect(other.canUndo).toBe(false);
  });

  it("counts document changes, not view changes, and records agent loads as one undo step", async () => {
    const { c } = imageEditor();
    const doc = createImageEditorDocument(c);
    const before = doc.getDocument();
    const r0 = doc.revision();
    c.setZoom(2);
    expect(doc.revision()).toBe(r0);
    c.addPixelLayer({ color: "#00ff00" });
    expect(doc.revision()).toBeGreaterThan(r0);
    const registry = new ToolRegistry();
    registry.register(createDocumentToolProvider(doc, { namespace: "", history: false }));
    const loaded: any = await registry.callTool("load_image_document", { document: before });
    expect(loaded.isError, text(loaded)).toBeFalsy();
    expect(loaded.structuredContent.undoable).toBe(true);
    expect(c.getLayers()).toHaveLength(2);
    c.undo();
    expect(c.getLayers()).toHaveLength(3);
    const got: any = await registry.callTool("get_image_document", {});
    expect(JSON.stringify(got.structuredContent).length).toBeLessThan(20000);
  });

  it("autosaves with its assets and restores them in a new session", async () => {
    vi.useFakeTimers();
    try {
      const storage = createMemoryStorage();
      const { c, id, noise } = imageEditor();
      const autosave = createEditorAutosave(createImageEditorDocument(c), { storage, debounceMs: 5 });
      await autosave.checkRecovery();
      autosave.controller.ready();
      c.addPixelLayer({ color: "#0000ff" });
      await vi.advanceTimersByTimeAsync(20);
      await autosave.controller.whenIdle();
      autosave.destroy();

      const next = imageEditor().c;
      const again = createEditorAutosave(createImageEditorDocument(next), { storage });
      const recovery = await again.checkRecovery();
      expect(recovery?.snapshot?.kind).toBe("image");
      again.restore(recovery!);
      expect(next.getLayers()).toHaveLength(3);
      expect(readPixel((next.getLayer(id) as PixelLayer).surface, 5, 5)).toEqual([...noise.slice((5 * W + 5) * 4, (5 * W + 5) * 4 + 4)]);
      again.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves and opens named documents with their assets", async () => {
    const storage = createMemoryStorage();
    const store = createEditorDocumentStore({ storage });
    const { c, id, noise } = imageEditor();
    await store.save(createImageEditorDocument(c), "Photo");
    const next = imageEditor().c;
    const opened = await store.open(createImageEditorDocument(next), "image/photo");
    expect(opened.report.readOnly).toBeNull();
    expect(readPixel((next.getLayer(id) as PixelLayer).surface, 1, 1)).toEqual([...noise.slice((1 * W + 1) * 4, (1 * W + 1) * 4 + 4)]);
    // A document whose assets are gone from storage is refused.
    for (const key of [...storage.entries.keys()]) if (key.startsWith("pixerate.assets:")) storage.entries.delete(key);
    await expect(store.open(createImageEditorDocument(imageEditor().c), "image/photo")).rejects.toThrow(/storage no longer has/);
  });
});

describe("paint editor documents", () => {
  const points = Array.from({ length: 30 }, (_, i) => ({ x: 10 + i * 5, y: 20 + Math.sin(i) * 8, pressure: 0.6 }));

  it("hold references, open fresh (not undoable) and are read-only mid-stroke", async () => {
    const c = new PaintEditorController({ width: 200, height: 80, paper: "smooth" });
    c.paintStroke({ points, brushId: "ink-pen", color: "#000000" });
    const doc = createPaintEditorDocument(c);
    const saved = doc.getDocument();
    expect(collectAssetRefs(saved).length).toBeGreaterThan(0);
    expect(JSON.stringify(saved)).not.toMatch(/data:image\/png;base64,[A-Za-z0-9+/=]{600}/);
    expect(doc.recordsLoads).toBe(false);

    const other = new PaintEditorController({ width: 10, height: 10, paper: "smooth" });
    const otherDoc = createPaintEditorDocument(other, { assets: doc.assets });
    const r0 = otherDoc.revision();
    otherDoc.loadDocument(saved);
    expect(other.document.canvas).toMatchObject({ width: 200, height: 80 });
    expect(other.document.strokes).toHaveLength(1);
    expect(otherDoc.revision()).toBeGreaterThan(r0);

    const registry = new ToolRegistry();
    registry.register(createDocumentToolProvider(doc, { namespace: "", history: false }));
    const loaded: any = await registry.callTool("load_paint_document", { document: saved });
    expect(loaded.structuredContent.undoable).toBe(false);

    // Mid-stroke, the painting cannot be replaced.
    const session = c.beginStroke({ brushId: "ink-pen", color: "#000000" });
    const busy: any = await registry.callTool("load_paint_document", { document: saved });
    expect(text(busy)).toMatch("A stroke is in progress; end or cancel it first.");
    session.cancel();
  });
});

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.useRealTimers());
