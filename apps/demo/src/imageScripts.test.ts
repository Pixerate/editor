import { describe, expect, it } from "vitest";
import { ToolRegistry } from "@pixerate/editor/agent";
import { ImageEditorController, createImageEditorToolProvider, createOutlineTextShaper, type OutlineFontFace, type TypeLayer } from "@pixerate/editor/image-editor";
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
});
