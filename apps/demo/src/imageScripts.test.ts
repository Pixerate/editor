import { describe, expect, it } from "vitest";
import { ToolRegistry } from "@pixerate/editor/agent";
import { createFakeEffectProvider } from "@pixerate/editor/effects";
import { ImageEditorController, createImageEditorToolProvider, createImageEffectsToolProvider, createImageStickerHost, type PixelLayer, type SmartObjectLayer, createOutlineTextShaper, type OutlineFontFace, type TypeLayer } from "@pixerate/editor/image-editor";
import { createStickerToolProvider } from "@pixerate/editor/stickers";
import { demoStickers } from "./demoStickers";
import { runAgentScript } from "./agentScript";
import { IMAGE_SCRIPTS } from "./agentScripts";

/** A box font so the type tools lay text out without a canvas. */
const boxFont: OutlineFontFace = {
  unitsPerEm: 1000,
  ascender: 800,
  descender: -200,
  names: { fontFamily: { en: "sans-serif" } },
  getAdvanceWidth: (t, size) => (t.length * 600 * size) / 1000,
  getPath: () => ({ commands: [] }),
};

describe("image agent scripts", () => {
  it("the effects script adds a gradient wash and a lower-third bar as effect layers", async () => {
    const fake = { width: 64, height: 36, naturalWidth: 64, naturalHeight: 36, src: "data:fake" } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake, effects: createFakeEffectProvider() });
    const reg = new ToolRegistry();
    reg.register(createImageEditorToolProvider(c, { id: "image", namespace: "image" }));
    reg.register(createImageEffectsToolProvider(c, { id: "image-effects", namespace: "imagefx" }));
    const script = IMAGE_SCRIPTS.find((s) => s.id === "image-effects")!;
    const steps = script.steps.filter((s) => s.tool !== "image__render_preview");
    const { ok } = await runAgentScript(reg, { ...script, steps }, { wait: () => Promise.resolve() });
    expect(ok).toBe(true);
    const layers = (c.getLayers() as PixelLayer[]).filter((l) => l.generator);
    expect(layers.map((l) => [l.name, l.generator?.effect, l.blend])).toEqual([
      ["Sunset wash", "fake.gradient", "soft-light"],
      ["Lower third", "fake.bar", "normal"],
    ]);
  });

  it("the sticker script puts three badges in as layers and treats each with the same effect", async () => {
    const fake = { width: 520, height: 300, naturalWidth: 520, naturalHeight: 300, src: "data:fake" } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake, effects: createFakeEffectProvider() });
    const reg = new ToolRegistry();
    reg.register(createImageEditorToolProvider(c, { id: "image", namespace: "image" }));
    reg.register(createImageEffectsToolProvider(c, { id: "image-effects", namespace: "imagefx" }));
    reg.register(createStickerToolProvider({ provider: () => demoStickers, insert: createImageStickerHost(c), id: "image-stickers", namespace: "imagestickers" }));
    const script = IMAGE_SCRIPTS.find((s) => s.id === "image-sticker-effects")!;
    const steps = script.steps.filter((s) => s.tool !== "image__render_preview");
    const { ok } = await runAgentScript(reg, { ...script, steps }, { wait: () => Promise.resolve() });
    expect(ok).toBe(true);
    const treated = c.getLayers().filter((l) => (l as SmartObjectLayer).smartFilters?.filters.length);
    expect(treated.map((l) => l.name)).toEqual(["New badge", "Sale badge", "Hot badge"]);
  });

  it("the poster script adds a banner, a badge and a styled headline with the shape and type tools", async () => {
    const fake = { width: 320, height: 200, naturalWidth: 320, naturalHeight: 200, src: "data:fake" } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake, textShaper: createOutlineTextShaper([boxFont]) });
    c.setSamplePixels({ width: 320, height: 200, data: new Uint8ClampedArray(320 * 200 * 4).fill(200) });
    const reg = new ToolRegistry();
    reg.register(createImageEditorToolProvider(c, { id: "image", namespace: "image" }));
    const script = IMAGE_SCRIPTS.find((s) => s.id === "image-poster")!;
    // The preview needs a browser canvas.
    const steps = script.steps.filter((s) => s.tool !== "image__render_preview");
    const { ok } = await runAgentScript(reg, { ...script, steps }, { wait: () => Promise.resolve() });
    expect(ok).toBe(true);
    const types = c.getLayers().map((l) => l.type);
    expect(types).toEqual(["pixel", "shape", "shape", "type"]);
    const headline = c.getLayers()[3] as TypeLayer;
    expect(headline.text).toBe("Summer Sale");
    expect(headline.runs.map((r) => r.style.color)).toEqual(["#ffffff", "#f59e0b"]);
  });

  it("the colour script proofs through CMYK and converts colours", async () => {
    const fake = { width: 40, height: 20, naturalWidth: 40, naturalHeight: 20, src: "data:fake" } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake });
    c.setSamplePixels({ width: 40, height: 20, data: new Uint8ClampedArray(40 * 20 * 4).fill(180) });
    const reg = new ToolRegistry();
    reg.register(createImageEditorToolProvider(c, { id: "image", namespace: "image" }));
    const script = IMAGE_SCRIPTS.find((s) => s.id === "image-color")!;
    const steps = script.steps.filter((s) => s.tool !== "image__render_preview");
    const { ok } = await runAgentScript(reg, { ...script, steps }, { wait: () => Promise.resolve() });
    expect(ok).toBe(true);
    expect(c.getState().proofSetup).toBeNull();
  }, 60_000);
  it("the retouch script heals, clones and dodges with the retouching tools", async () => {
    const W = 200;
    const H = 120;
    const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: "data:fake" } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake });
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) data.set([(i % W) + 30, 120, 90, 255], i * 4);
    c.setSamplePixels({ width: W, height: H, data });
    c.addPixelLayer({ name: "Photo", pixels: { width: W, height: H, data } });
    const reg = new ToolRegistry();
    reg.register(createImageEditorToolProvider(c, { id: "image", namespace: "image" }));
    const script = IMAGE_SCRIPTS.find((s) => s.id === "image-retouch")!;
    const steps = script.steps.filter((s) => s.tool !== "image__render_preview");
    const { ok } = await runAgentScript(reg, { ...script, steps }, { wait: () => Promise.resolve() });
    expect(ok).toBe(true);
    const retouch = c.getLayers().find((l) => l.name === "Retouch")!;
    expect(c.getLayerBounds(retouch.id)).not.toBeNull();
    expect(c.getState().paint.cloneSource).toMatchObject({ x: 50, y: 60 });
  });
});
