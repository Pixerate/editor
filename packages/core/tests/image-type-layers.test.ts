import { describe, expect, it } from "vitest";
import {
  ImageEditorController,
  caretAt,
  createOutlineTextShaper,
  fitParagraphRuns,
  fitRuns,
  layoutText,
  readRegion,
  restyleRange,
  spliceRuns,
  textIndexAt,
  type TextStyle,
  type TypeLayer,
} from "../src/image-editor";
import { boxFont } from "./helpers/box-font";

const W = 200;
const H = 120;

const shaper = () =>
  createOutlineTextShaper([
    boxFont("Box"),
    boxFont("Box", 700),
    { face: boxFont("Serif Box"), family: "Serif Box" },
  ]);

function setup(textShaper = shaper()) {
  const fake = {
    width: W,
    height: H,
    naturalWidth: W,
    naturalHeight: H,
  } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake, textShaper });
  c.setSamplePixels({
    width: W,
    height: H,
    data: new Uint8ClampedArray(W * H * 4).fill(255),
  });
  return c;
}

const steps = (c: ImageEditorController) =>
  (c as unknown as { undoStack: unknown[] }).undoStack.length;
const STYLE: TextStyle = {
  fontFamily: "Box",
  fontWeight: 400,
  fontSize: 10,
  color: "#000000",
};
const alphaAt = (c: ImageEditorController, id: string, x: number, y: number) =>
  readRegion((c.getLayer(id) as TypeLayer).surface, {
    x,
    y,
    width: 1,
    height: 1,
  })[3];

describe("text runs", () => {
  const a = { length: 3, style: { n: 1 } };
  const b = { length: 2, style: { n: 2 } };
  it("fits, restyles and splices runs, merging equal neighbours", () => {
    expect(fitRuns([a, b], 7, { n: 0 })).toEqual([
      { length: 3, style: { n: 1 } },
      { length: 4, style: { n: 2 } },
    ]);
    expect(fitRuns([a, b], 2, { n: 0 })).toEqual([
      { length: 2, style: { n: 1 } },
    ]);
    expect(restyleRange([a, b], 1, 4, () => ({ n: 9 }))).toEqual([
      { length: 1, style: { n: 1 } },
      { length: 3, style: { n: 9 } },
      { length: 1, style: { n: 2 } },
    ]);
    expect(restyleRange([a, b], 0, 5, () => ({ n: 9 }))).toEqual([
      { length: 5, style: { n: 9 } },
    ]);
    expect(spliceRuns([a, b], 1, 4, 6, { n: 1 })).toEqual([
      { length: 7, style: { n: 1 } },
      { length: 1, style: { n: 2 } },
    ]);
    expect(spliceRuns([a, b], 5, 5, 2, { n: 3 })).toEqual([
      a,
      b,
      { length: 2, style: { n: 3 } },
    ]);
  });

  it("snaps paragraph runs to whole paragraphs", () => {
    const p = fitParagraphRuns(
      [
        { length: 2, style: { align: "center" } },
        { length: 10, style: { align: "right" } },
      ],
      "ab\ncd\nef",
    );
    // Paragraphs "ab\n", "cd\n", "ef": each takes the style at its start.
    expect(p).toEqual([
      { length: 3, style: { align: "center" } },
      { length: 5, style: { align: "right" } },
    ]);
  });
});

describe("layout", () => {
  const layer = (
    text: string,
    frame: TypeLayer["frame"] = { kind: "point" },
    style: Partial<TextStyle> = {},
    paragraph = {},
  ) => ({
    text,
    runs: [{ length: text.length, style: { ...STYLE, ...style } }],
    paragraphs: [{ length: text.length, style: paragraph }],
    frame,
  });

  it("sets point text from its baseline with kerning, tracking and alignment", () => {
    const s = shaper();
    const l = layoutText(layer("AV A"), s);
    // A(6) V(6) − kern 1 + space 3 + A 6 = 20 px at 10 px.
    expect(l.lines[0].width).toBeCloseTo(20, 6);
    expect(l.lines[0].baseline).toBe(0);
    expect(l.bounds).toMatchObject({ x: 0, y: -8, height: 10 });
    expect(
      layoutText(layer("ABCD", { kind: "point" }, { tracking: 100 }), s)
        .lines[0].width,
    ).toBeCloseTo(24 + 4, 6);
    expect(
      layoutText(layer("ABCD", { kind: "point" }, {}, { align: "center" }), s)
        .lines[0].x,
    ).toBeCloseTo(-12, 6);
    expect(
      layoutText(layer("ABCD", { kind: "point" }, {}, { align: "right" }), s)
        .lines[0].x,
    ).toBeCloseTo(-24, 6);
    // From the top: the first baseline sits one ascent down.
    expect(
      layoutText(layer("A", { kind: "point", origin: "top" }), s).lines[0]
        .baseline,
    ).toBe(8);
  });

  it("breaks paragraphs and wraps paragraph text at spaces, with leading and spacing", () => {
    const s = shaper();
    const multi = layoutText(
      layer("AB\nCD", { kind: "point" }, {}, { spaceBefore: 5 }),
      s,
    );
    expect(multi.lines.map((l) => l.baseline)).toEqual([0, 12 + 5]);
    const fixed = layoutText(
      layer("AB\nCD", { kind: "point" }, { leading: 20 }),
      s,
    );
    expect(fixed.lines[1].baseline).toBe(20);
    // A 40 px box holds "AAA AAA" (6 · 6 + 3 = 39) but not three words.
    const box = layoutText(
      layer("AAA AAA AAA", { kind: "box", width: 40, height: 100 }),
      s,
    );
    expect(box.lines.map((l) => [l.start, l.end])).toEqual([
      [0, 8],
      [8, 11],
    ]);
    expect(box.lines[0].width).toBeCloseTo(39, 6);
    expect(box.lines[0].baseline).toBe(8);
    const justified = layoutText(
      layer(
        "AA AA AAAAAA",
        { kind: "box", width: 40, height: 100 },
        {},
        { align: "justify" },
      ),
      s,
    );
    expect(justified.lines[0].chars[3].x).toBeCloseTo(40 - 12, 6);
    // A word longer than the box breaks inside it.
    expect(
      layoutText(
        layer("AAAAAAAAAA", { kind: "box", width: 30, height: 100 }),
        s,
      ).lines,
    ).toHaveLength(2);
  });

  it("maps points to text indices and indices to carets", () => {
    const l = layoutText(layer("ABC\nDE"), shaper());
    expect(textIndexAt(l, { x: 7, y: -2 })).toBe(1);
    expect(textIndexAt(l, { x: 100, y: -2 })).toBe(3);
    expect(textIndexAt(l, { x: 1, y: 12 })).toBe(4);
    expect(caretAt(l, 2)).toMatchObject({ x: 12, top: -8, bottom: 2, line: 0 });
    expect(caretAt(l, 6)).toMatchObject({ x: 12, line: 1 });
  });

  it("falls back for missing fonts and says so", () => {
    const l = layoutText(
      layer("A", { kind: "point" }, { fontFamily: "Nope" }),
      shaper(),
    );
    expect(l.missingFonts).toEqual(["Nope"]);
  });
});

describe("type layers in the controller", () => {
  it("adds point text, draws it, and edits text, styles and paragraphs, one undo step each", () => {
    const c = setup();
    const n = steps(c);
    const id = c.addTextLayer({
      text: "Hello",
      x: 20,
      y: 40,
      style: { fontFamily: "Box", fontSize: 20, color: "#ff0000" },
    });
    expect(steps(c)).toBe(n + 1);
    expect(c.getLayer(id)!.type).toBe("type");
    expect(c.getLayer(id)!.name).toBe("Hello");
    // The H box covers x 21..31, y 26..40.
    expect(alphaAt(c, id, 25, 35)).toBe(255);
    expect(alphaAt(c, id, 25, 45)).toBe(0);
    expect(c.getTextLayer(id)).toMatchObject({
      text: "Hello",
      rendering: "live",
      missingFonts: [],
      lines: [{ start: 0, end: 5, baseline: 0, width: 60 }],
      transform: [1, 0, 0, 1, 20, 40],
    });

    let info = c.setText(id, " world", { start: 5, end: 5 });
    expect(info.text).toBe("Hello world");
    expect(info.runs).toEqual([
      {
        start: 0,
        end: 11,
        style: {
          fontFamily: "Box",
          fontWeight: 400,
          fontSize: 20,
          color: "#ff0000",
        },
      },
    ]);
    info = c.setTextStyle(
      id,
      { fontWeight: 700, color: "#0000ff", tracking: 50 },
      { start: 6, end: 11 },
    );
    expect(
      info.runs.map((r) => [r.start, r.end, r.style.color, r.style.fontWeight]),
    ).toEqual([
      [0, 6, "#ff0000", 400],
      [6, 11, "#0000ff", 700],
    ]);
    info = c.setParagraphStyle(id, { align: "center" });
    expect(info.paragraphs).toEqual([
      { start: 0, end: 11, style: { align: "center" } },
    ]);
    // "Hello " at 12 px per letter and 6 per space, then "world" with 1 px tracking per letter.
    expect(info.lines[0].width).toBeCloseTo(5 * 12 + 6 + 5 * 12 + 5);
    expect(steps(c)).toBe(n + 4);
    c.undo();
    expect(c.getTextLayer(id).paragraphs[0].style).toEqual({});
  });

  it("wraps paragraph text and switches between point and paragraph text in place", () => {
    const c = setup();
    const id = c.addTextLayer({
      text: "AAA AAA AAA",
      x: 10,
      y: 10,
      box: { width: 40, height: 60 },
      style: { fontFamily: "Box", fontSize: 10 },
    });
    expect(c.getTextLayer(id).lines).toHaveLength(2);
    const before = c.textCaret(id, 0)!;
    c.setTextFrame(id, { kind: "point" });
    expect(c.getTextLayer(id).lines).toHaveLength(1);
    expect(c.getTextLayer(id).frame).toEqual({ kind: "point" });
    const after = c.textCaret(id, 0)!;
    expect(after.top.x).toBeCloseTo(before.top.x, 6);
    expect(after.top.y).toBeCloseTo(before.top.y, 6);
    c.setTextFrame(id, { kind: "box", width: 25, height: 60 });
    expect(c.getTextLayer(id).lines).toHaveLength(3);
    expect(c.textIndexAt(id, { x: 12, y: 15 })).toBe(0);
  });

  it("transforms through its matrix (affine only), moves, and keeps masks and effects", () => {
    const c = setup();
    const id = c.addTextLayer({
      text: "AB",
      x: 50,
      y: 50,
      style: { fontFamily: "Box", fontSize: 20 },
    });
    c.transformLayer({ layerId: id, params: { rotate: 90 } });
    const t = c.getTextLayer(id).transform;
    expect(t[0]).toBeCloseTo(0, 9);
    expect(t[1]).toBeCloseTo(1, 9);
    const s = c.beginFreeTransform({ layerId: id });
    expect(s.typeLayer).toBe(true);
    const k = s.startGeometry.corners;
    expect(() =>
      s.update(
        { corners: [k[0], { x: k[1].x + 9, y: k[1].y }, k[2], k[3]] },
        false,
      ),
    ).toThrow(/parallelogram/);
    s.cancel();
    expect(c.getFreeTransform()).toBeNull();
    c.offsetLayer(id, { dx: 5, dy: -3 });
    expect(c.getTextLayer(id).transform[4]).toBeCloseTo(t[4] + 5, 9);
    c.addLayerEffect(id, "stroke", {
      size: 2,
      fill: { type: "color", color: "#00ff00" },
    });
    expect(c.getLayerBounds(id)).not.toBeNull();
    expect(() => c.paintStroke({ points: [{ x: 50, y: 50 }] })).toThrow(
      /type layer; its pixels are drawn from its text/,
    );
  });

  it("warns about missing fonts and draws them with the fallback", () => {
    const c = setup();
    const id = c.addTextLayer({
      text: "A",
      x: 10,
      y: 30,
      style: { fontFamily: "Comic Nope", fontSize: 20 },
    });
    expect(c.getTextLayer(id).missingFonts).toEqual(["Comic Nope"]);
    expect(alphaAt(c, id, 15, 25)).toBe(255);
  });

  it("converts text to a shape layer with the same id and look", async () => {
    const c = setup();
    const id = c.addTextLayer({
      text: "AV",
      x: 10,
      y: 50,
      style: { fontFamily: "Box", fontSize: 30, color: "#123456" },
    });
    const before = c.compositePixels().data;
    const res = c.convertTextToShape(id);
    expect(res.warnings).toEqual([]);
    expect(c.getLayer(id)!.type).toBe("shape");
    expect(c.getShapeLayer(id).fill).toEqual({
      type: "color",
      color: "#123456",
    });
    let diff = 0;
    const after = c.compositePixels().data;
    for (let i = 0; i < after.length; i++)
      diff = Math.max(diff, Math.abs(after[i] - before[i]));
    expect(diff).toBeLessThanOrEqual(1);
  });

  it("rasterizes into a pixel layer", async () => {
    const c = setup();
    const id = c.addTextLayer({ text: "Hi", x: 10, y: 50 });
    const before = c.compositePixels().data;
    await c.rasterizeLayer(id);
    expect(c.getLayer(id)!.type).toBe("pixel");
    expect(c.compositePixels().data).toEqual(before);
  });

  it("round-trips through JSON with its pixels, which a load without fonts keeps", () => {
    const c = setup();
    const id = c.addTextLayer({
      text: "Two\nlines",
      x: 30,
      y: 40,
      style: { fontFamily: "Box", fontSize: 16, underline: true },
      paragraph: { align: "center" },
      rotation: 10,
    });
    c.setTextStyle(id, { color: "#ff00ff" }, { start: 4, end: 9 });
    const json = c.toJSON();
    const d = setup(null as never);
    // No shaper: the stored pixels stay.
    (d as unknown as { textShaperValue: null }).textShaperValue = null;
    d.loadJSON(json);
    expect(d.lastLoadProblems).toEqual([]);
    expect(d.getTextLayer(id)).toMatchObject({
      text: "Two\nlines",
      rendering: "stored",
      lines: [],
    });
    expect(d.compositePixels().data).toEqual(c.compositePixels().data);
    expect(JSON.stringify(d.toJSON())).toBe(JSON.stringify(json));
    expect(() => d.setText(id, "x")).toThrow(/need a text shaper/);
    expect(() => d.addTextLayer({ text: "x", x: 0, y: 0 })).toThrow(
      /need a text shaper/,
    );
    // With a shaper, the next edit draws it again.
    d.setTextShaper(shaper());
    d.setText(id, "Two", { start: 0, end: 3 });
    expect(d.getTextLayer(id).rendering).toBe("live");
  });

  it("refuses bad input before changing anything", () => {
    const c = setup();
    const id = c.addTextLayer({ text: "abc", x: 0, y: 20 });
    const n = steps(c);
    expect(() => c.setText(id, "x", { start: 2, end: 9 })).toThrow(
      /0 ≤ start ≤ end ≤ 3/,
    );
    expect(() => c.setTextStyle(id, { fontSize: -2 })).toThrow(
      /fontSize must be a number from 0.5/,
    );
    expect(() => c.setTextStyle(id, { colour: "#fff" } as never)).toThrow(
      /not a character style field/,
    );
    expect(() => c.setParagraphStyle(id, { align: "middle" as never })).toThrow(
      /align must be one of left, center, right, justify/,
    );
    expect(() =>
      c.setTextFrame(id, { kind: "box", width: 0, height: 10 }),
    ).toThrow(/at least 1 pixel/);
    expect(() => c.getTextLayer("background")).toThrow(/not a type layer/);
    expect(steps(c)).toBe(n);
  });

  it("frames a type layer where its text box lands", () => {
    const c = setup();
    const id = c.addTextLayer({
      text: "AAA AAA AAA",
      x: 10,
      y: 10,
      box: { width: 40, height: 60 },
      style: { fontFamily: "Box", fontSize: 10 },
    });
    const frame = c.getLayerFrame(id)!;
    expect(frame).toHaveLength(4);
    expect(frame[0]).toEqual({ x: 10, y: 10 });
    expect(frame[2]).toEqual({ x: 50, y: 70 });
  });
});
