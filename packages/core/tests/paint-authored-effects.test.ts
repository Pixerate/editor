import { describe, expect, it } from "vitest";
import { createFakeEffectProvider } from "../src/effects";
import {
  PaintEditorController,
  createPaintEditorToolProvider,
  createPaintEffectAuthoringToolProvider,
  createPaintEffectsToolProvider,
  type PaintPixelLayer,
} from "../src/paint-editor";
import { readPixel } from "../src/raster/surface";
import { ToolRegistry } from "../src/tools/registry";

const W = 32;
const H = 16;
const HARD = {
  tip: {
    size: 8,
    hardness: 1,
    opacity: 1,
    flow: 1,
    spacing: 0.05,
    pressureOpacity: false,
    pressureSize: false,
    smoothing: 0,
  },
  grain: 0,
};
const LINE = [
  { x: 2, y: 8 },
  { x: 30, y: 8 },
];
/** Red on the left half, blue on the right. */
const SPLIT =
  "control left: color = #ff0000 // Left half.\ncontrol right: color = #0000ff // Right half.\nout = select(uv.x < 0.5, left, right)";

function setup(
  options: ConstructorParameters<typeof PaintEditorController>[0] = {},
  provider = true,
) {
  const c = new PaintEditorController({
    width: W,
    height: H,
    paper: "smooth",
    authoredEffects: "author",
    ...options,
  });
  if (provider) c.setEffectsProvider(createFakeEffectProvider());
  const reg = new ToolRegistry({ validateArguments: true });
  reg.register(createPaintEditorToolProvider(c));
  reg.register(createPaintEffectsToolProvider(c));
  reg.register(createPaintEffectAuthoringToolProvider(c));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await reg.callTool(name, args);
    if (r.isError) throw new Error((r.content[0] as { text: string }).text);
    return r.structuredContent as Record<string, any>;
  };
  const fail = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await reg.callTool(name, args);
    expect(r.isError, `${name} should fail`).toBe(true);
    return (r.content[0] as { text: string }).text;
  };
  return { c, reg, call, fail };
}

const px = (c: PaintEditorController, id: string, x: number, y: number) =>
  readPixel((c.getLayer(id) as PaintPixelLayer).surface, x, y);

async function authorSplit(t: ReturnType<typeof setup>) {
  await t.call("open_effect_authoring", { effect: "pixel.blank" });
  await t.call("effect_authoring_set_source", { source: SPLIT });
  return t.call("save_authored_effect", { name: "Split" });
}

describe("authored effects in the paint editor", () => {
  it("writes an effect, saves it and paints a stroke with it", async () => {
    const t = setup();
    const opened = await t.call("open_effect_authoring", {
      effect: "pixel.blank",
    });
    expect(opened).toMatchObject({
      from: "pixel.blank",
      name: "Blank",
      sourceLanguage: "pixel",
      compiled: true,
    });
    expect(opened.controls.map((f: { id: string }) => f.id)).toEqual([
      "top",
      "bottom",
    ]);

    const bad = await t.call("effect_authoring_set_source", {
      source: "out = vec3(oops)",
    });
    expect(bad.issues).toEqual([
      {
        severity: "error",
        line: 1,
        message: 'there is no "oops"; built in: uv, pos, size, time, PI, TAU',
      },
    ]);
    expect(await t.fail("save_authored_effect")).toMatch(
      /doesn't compile, so it can't be saved: line 1: there is no "oops"/,
    );

    await t.call("effect_authoring_set_source", { source: SPLIT });
    const saved = await t.call("save_authored_effect", { name: "Split" });
    expect(saved).toMatchObject({
      id: "authored.split",
      name: "Split",
      controls: ["left", "right"],
      animated: [],
    });

    await t.call("set_effect_paint", { effect: "authored.split" });
    expect(t.c.getEffectPaint()).toMatchObject({
      effect: "authored.split",
      provider: "authored",
      values: { left: "#ff0000", right: "#0000ff" },
    });
    const layer = t.c.getActiveLayer()!.id;
    t.c.paintStroke({ brushId: "ink-pen", brush: HARD, points: LINE });
    expect(px(t.c, layer, 6, 8)).toEqual([255, 0, 0, 255]);
    expect(px(t.c, layer, 26, 8)).toEqual([0, 0, 255, 255]);

    // search_effects finds it next to the provider's catalog; describe_effect describes it.
    const found = await t.call("search_effects", { query: "split" });
    expect(found.effects.map((e: { id: string }) => e.id)).toEqual([
      "authored.split",
    ]);
    expect(found.provider.id).toBe("fake");
  });

  it("saves the source in the painting, which replays without the session or the provider", async () => {
    const t = setup();
    await authorSplit(t);
    await t.call("close_effect_authoring");
    await t.call("set_effect_paint", {
      effect: "authored.split",
      values: { right: "#00ff00" },
    });
    const layer = t.c.getActiveLayer()!.id;
    t.c.paintStroke({ brushId: "ink-pen", brush: HARD, points: LINE });
    const json = JSON.parse(JSON.stringify(t.c.toJSON()));
    const ext = JSON.stringify(json);
    expect(ext).toContain('"authoredEffects"');
    expect(ext).toContain("select(uv.x < 0.5, left, right)");

    // Another machine: no provider, replay only.
    const other = new PaintEditorController({
      width: W,
      height: H,
      paper: "smooth",
    });
    expect(other.loadJSON(json)).toEqual([]);
    expect(other.authoredPolicy).toBe("replay");
    expect((await other.listAuthoredEffects()).map((e) => e.id)).toEqual([
      "authored.split",
    ]);
    await other.setEffectPaint({
      effect: "authored.split",
      values: { right: "#00ff00" },
    });
    other.paintStroke({
      brushId: "ink-pen",
      brush: HARD,
      points: [
        { x: 2, y: 4 },
        { x: 30, y: 4 },
      ],
    });
    const id = other.getActiveLayer()!.id;
    expect(px(other, id, 26, 4)).toEqual([0, 255, 0, 255]);
    expect(px(other, layer, 26, 8)).toEqual([0, 255, 0, 255]);
  });

  it("a replay at a higher scale repaints strokes that use an authored effect", async () => {
    const t = setup();
    await authorSplit(t);
    await t.call("set_effect_paint", { effect: "authored.split" });
    t.c.paintStroke({ brushId: "ink-pen", brush: HARD, points: LINE });
    const target = t.c.createReplayTarget(2);
    expect((await target.listAuthoredEffects()).map((e) => e.id)).toEqual([
      "authored.split",
    ]);
    expect(target.authoredPolicy).toBe("author");
  });

  it("works as paper, an effect layer and a fill", async () => {
    const t = setup();
    await authorSplit(t);
    await t.call("set_paper_effect", { effect: "authored.split" });
    expect(t.c.getPaperEffect()).toMatchObject({
      effect: "authored.split",
      provider: "authored",
    });
    const added = await t.call("add_effect_layer", {
      effect: "authored.split",
      name: "Split layer",
    });
    expect(px(t.c, added.layer.id, 1, 1)).toEqual([255, 0, 0, 255]);
    const fill = await t.call("fill_layer_with_effect", {
      effect: "authored.split",
      values: { left: "#ffffff" },
    });
    expect(px(t.c, fill.layerId, 1, 1)).toEqual([255, 255, 255, 255]);
    const uses = (await t.call("list_authored_effects")).effects[0].uses;
    expect(uses).toEqual({
      strokes: 0,
      paint: false,
      paper: true,
      layers: [added.layer.id],
    });
  });

  it("keyframed controls animate with the effect time and are not settable", async () => {
    const t = setup();
    await t.call("open_effect_authoring", { effect: "pixel.blank" });
    await t.call("effect_authoring_set_source", {
      source:
        "control k: number = 0 range 0 1 // Grey.\ncontrol a: number = 1 range 0 1 // Alpha.\nout = vec4(vec3(k), a)",
    });
    await t.call("effect_authoring_set_keyframe", {
      control: "k",
      time: 0,
      value: 0,
    });
    await t.call("effect_authoring_set_keyframe", {
      control: "k",
      time: 1000,
      value: 1,
    });
    const saved = await t.call("save_authored_effect", { name: "Fade" });
    expect(saved).toMatchObject({ controls: ["a"], animated: ["k"] });
    const d = await t.call("describe_effect", { effect: "authored.fade" });
    expect(
      Object.keys(d.controls ?? d.description?.controls?.properties ?? {}),
    ).not.toContain("k");
    const half = await t.c.addEffectLayer("authored.fade", { time: 500 });
    expect(px(t.c, half.layer.id, 0, 0)).toEqual([128, 128, 128, 255]);
  });

  it("ids never change what they draw: saving again makes another id", async () => {
    const t = setup();
    await authorSplit(t);
    await t.call("effect_authoring_set_values", {
      values: { left: "#00ff00" },
    });
    const again = await t.call("save_authored_effect", { name: "Split" });
    expect(again.id).toBe("authored.split-2");
  });

  it("remove is refused while the effect is used, and is one undo step", async () => {
    const t = setup();
    await authorSplit(t);
    await t.call("set_paper_effect", { effect: "authored.split" });
    expect(
      await t.fail("remove_authored_effect", { id: "authored.split" }),
    ).toMatch(/still used by the effect paper; remove those first/);
    await t.call("set_paper_effect", { effect: null });
    expect(
      await t.call("remove_authored_effect", { id: "authored.split" }),
    ).toEqual({ removed: "authored.split", name: "Split" });
    expect((await t.call("list_authored_effects")).effects).toEqual([]);
    t.c.undo();
    expect(
      (await t.call("list_authored_effects")).effects.map(
        (e: { id: string }) => e.id,
      ),
    ).toEqual(["authored.split"]);
    expect(
      await t.fail("remove_authored_effect", { id: "authored.nope" }),
    ).toMatch(/has no authored effect "authored.nope"; it has authored.split/);
  });

  it("one session at a time, and bad ids are refused with the choices", async () => {
    const t = setup();
    expect(await t.fail("effect_authoring_describe")).toMatch(
      /open one with open_effect_authoring/,
    );
    expect(
      await t.fail("open_effect_authoring", { effect: "pixel.nope" }),
    ).toMatch(/the templates are pixel.blank, pixel.rings, pixel.clouds/);
    await t.call("open_effect_authoring", { effect: "pixel.rings" });
    expect(
      await t.fail("open_effect_authoring", { effect: "pixel.blank" }),
    ).toMatch(/already open for authoring \(Rings, from "pixel.rings"\)/);
    expect(await t.call("close_effect_authoring")).toEqual({ closed: "Rings" });
    expect(await t.call("close_effect_authoring")).toEqual({ closed: null });
    // A provider effect opens with values only.
    await t.call("open_effect_authoring", { effect: "fake.gradient" });
    expect(
      await t.fail("effect_authoring_set_source", { source: "out = 1" }),
    ).toMatch(/has no source to edit/);
  });

  it("policy: replay draws but refuses authoring; off draws nothing", async () => {
    const author = setup();
    await authorSplit(author);
    const json = JSON.parse(JSON.stringify(author.c.toJSON()));
    const replay = setup({ authoredEffects: "replay" });
    replay.c.loadJSON(json);
    expect(
      await replay.fail("open_effect_authoring", { effect: "pixel.blank" }),
    ).toMatch(/doesn't allow authoring effects \(authoredEffects: "replay"\)/);
    await replay.call("set_effect_paint", { effect: "authored.split" });
    const off = setup({ authoredEffects: "off" });
    off.c.loadJSON(json);
    expect(
      await off.fail("set_effect_paint", { effect: "authored.split" }),
    ).toMatch(/turned off in this editor/);
    expect(
      (await off.call("list_authored_effects")).effects[0].problem,
    ).toMatch(/turned off in this editor/);
    expect(
      () => new PaintEditorController({ authoredEffects: "maybe" as never }),
    ).toThrow(/use off, replay, author/);
  });

  it("budgets: the trial render, and live frames that are too slow stop playing", async () => {
    const slow = setup({ authoredEffectLimits: { trialRenderMs: 0 } });
    await slow.call("open_effect_authoring", { effect: "pixel.blank" });
    expect(await slow.fail("save_authored_effect")).toMatch(
      /was not saved: a 64×64 trial render took \d+ ms; the limit is 0 ms/,
    );

    const t = setup({ authoredEffectLimits: { liveFrameMs: 0 } });
    await t.call("open_effect_authoring", { effect: "pixel.blank" });
    await t.call("effect_authoring_set_source", {
      source: "out = vec3(fract(time))",
    });
    await t.call("save_authored_effect", { name: "Pulse" });
    t.c.addLayer({ type: "strokes" });
    await t.c.setEffectPaint({ effect: "authored.pulse", live: true });
    t.c.paintStroke({ brushId: "ink-pen", brush: HARD, points: LINE });
    expect(t.c.getAnimation()).toMatchObject({ strokes: 1, sources: 1 });
    expect(
      (await t.call("list_authored_effects")).effects[0].problem,
    ).toBeUndefined();
    await t.c.showEffectTime(100);
    await t.c.showEffectTime(200);
    expect((await t.call("list_authored_effects")).effects[0].problem).toMatch(
      /live playback stopped: frames took \d+ ms, over the 0 ms budget/,
    );
    // Frozen: later frames draw the stroke's own moment.
    const frozen = Buffer.from(t.c.compositePixels().data);
    await t.c.showEffectTime(700);
    expect(Buffer.from(t.c.compositePixels().data).equals(frozen)).toBe(true);
  });

  it("raw shader documents need rawShaders", async () => {
    const t = setup();
    await authorSplit(t);
    const json = JSON.parse(JSON.stringify(t.c.toJSON()));
    const holder = findKey(json, "authoredEffects")!;
    holder.authoredEffects = {
      "authored.raw": {
        name: "Raw",
        document: {
          version: 1,
          providerId: "flair",
          effectId: "x",
          name: "Raw",
          values: {},
          tracks: {},
          presets: [],
          duration: 1000,
          loop: false,
          source: "void main(){}",
          sourceLanguage: "glsl",
        },
      },
    };
    expect(t.c.loadJSON(json)).toEqual([]);
    const listed = await t.call("list_authored_effects");
    expect(listed.effects[0]).toMatchObject({
      id: "authored.raw",
      language: "glsl",
    });
    expect(listed.effects[0].problem).toMatch(
      /written in glsl for the provider "flair"; this editor draws only pixel expression effects \(raw shader source needs rawShaders: true\)/,
    );
    const raw = setup({ rawShaders: true });
    raw.c.loadJSON(json);
    expect(
      (await raw.call("list_authored_effects")).effects[0].problem,
    ).toMatch(
      /needs the provider "flair" with authoring; the registered provider is "fake"/,
    );
  });

  it("keeps a provider's data in its documents through reopening and saving again", async () => {
    const data = { metal: { sourceHash: "abc", msl: "fragment float4 f() { return 1; }" } };
    const t = setup({ rawShaders: true });
    const json = JSON.parse(JSON.stringify(t.c.toJSON()));
    findKey(json, "layers")!.authoredEffects = {
      "authored.raw": {
        name: "Raw",
        document: { version: 1, providerId: "fake", effectId: "fake.gradient", name: "Raw", values: { angle: 45 }, tracks: {}, presets: [], duration: 1000, loop: false, provider: data },
      },
    };
    expect(t.c.loadJSON(json)).toEqual([]);
    await t.call("open_effect_authoring", { effect: "authored.raw" });
    await t.call("effect_authoring_set_values", { values: { angle: 120 } });
    const saved = await t.call("save_authored_effect", { name: "Raw again" });
    const again = JSON.parse(JSON.stringify(t.c.toJSON()));
    const docs = findKey(again, "authoredEffects")!.authoredEffects;
    expect(docs[saved.id].document.provider).toEqual(data);
    expect(docs[saved.id].document.values.angle).toBe(120);
    expect(docs["authored.raw"].document.provider).toEqual(data);
  });

  it("drops unreadable entries with a problem", () => {
    const t = setup();
    const json = JSON.parse(JSON.stringify(t.c.toJSON()));
    const holder = findKey(json, "layers")!;
    holder.authoredEffects = {
      "authored.bad": { name: 1 },
      "not-authored": { name: "x", document: {} },
    };
    expect(t.c.loadJSON(json)).toEqual([
      'The authored effect "authored.bad" could not be read; it was dropped (paint that uses it shows a placeholder).',
      'The authored effect "not-authored" could not be read; it was dropped (paint that uses it shows a placeholder).',
    ]);
  });
});

function findKey(o: any, key: string): any {
  if (!o || typeof o !== "object") return null;
  if (key in o) return o;
  for (const v of Object.values(o)) {
    const f = findKey(v, key);
    if (f) return f;
  }
  return null;
}
