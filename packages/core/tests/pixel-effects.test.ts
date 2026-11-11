import { describe, expect, it } from "vitest";
import {
  checkEffectProvider,
  compilePixelSource,
  createPixelEffectProvider,
  createPixelEvaluator,
  PIXEL_TEMPLATES,
  pixelHash,
  pixelNoise,
} from "../src/effects/index.js";

const manual = () => () => () => {};

function issuesOf(source: string) {
  const r = compilePixelSource(source);
  return {
    ok: r.ok,
    issues: r.issues.map((i) => `${i.severity}@${i.line}: ${i.message}`),
  };
}

function px(source: string, w = 2, h = 2, time = 0, values = {}) {
  const r = compilePixelSource(source);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  const out = new Uint8ClampedArray(w * h * 4);
  createPixelEvaluator(r.program).render(w, h, time, values, out);
  return [...out];
}

describe("pixel expressions: compiling", () => {
  it("compiles every template with no issues", () => {
    for (const t of PIXEL_TEMPLATES) {
      const r = compilePixelSource(t.source);
      expect(r.ok, t.id).toBe(true);
      expect(r.issues, t.id).toEqual([]);
    }
  });

  it("reads controls with types, defaults, ranges and their line comment", () => {
    const r = compilePixelSource(
      "control speed: number = 1 range 0 4 // Turns a second.\ncontrol ink: color = #FF8800\ncontrol on: bool = true\ncontrol at: vec2 = vec2(0.5, -1) range -2 2\nout = vec4(ink * speed * on, at.x + at.y)",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.program.controls.map(({ line: _l, ...c }) => c)).toEqual([
      {
        name: "speed",
        type: "number",
        default: 1,
        min: 0,
        max: 4,
        description: "Turns a second.",
      },
      {
        name: "ink",
        type: "color",
        default: "#ff8800",
        description: "The ink control.",
      },
      {
        name: "on",
        type: "bool",
        default: true,
        description: "The on control.",
      },
      {
        name: "at",
        type: "vec2",
        default: [0.5, -1],
        min: -2,
        max: 2,
        description: "The at control.",
      },
    ]);
  });

  it("reports problems with their line numbers and what to do", () => {
    expect(issuesOf("let a = 1\nout = vec3(b)")).toEqual({
      ok: false,
      issues: [
        'error@2: there is no "b"; defined so far: a; built in: uv, pos, size, time, PI, TAU',
      ],
    });
    expect(issuesOf("out = uv + vec3(1)")).toEqual({
      ok: false,
      issues: [
        'error@1: can\'t use "+" on a vec2 and a vec3; make them the same size (e.g. with .xy or vec3(…))',
      ],
    });
    expect(issuesOf("let a = 1")).toEqual({
      ok: false,
      issues: [
        "error@1: nothing is drawn: end with a line such as out = vec3(uv, 0.5)",
      ],
    });
    expect(issuesOf("out = uv")).toEqual({
      ok: false,
      issues: [
        "error@1: out is a number (grey), a vec3 (colour) or a vec4 (colour and alpha), not a vec2",
      ],
    });
    expect(issuesOf("out = vec3(uv.z)").issues).toEqual([
      'error@1: a vec2 has no ".z"; it has .x .y',
    ]);
    expect(issuesOf("control c: color = 3\nout = c").issues).toEqual([
      "error@1: a colour control's default is #rrggbb, not the number 3",
    ]);
    expect(
      issuesOf("control n: number = 5 range 0 1\nout = vec3(n)").issues,
    ).toEqual(["error@1: the default 5 is outside range 0 1"]);
    expect(issuesOf("out = vec3(1)\nlet x = 2").issues).toEqual([
      'error@2: "out = …" must be the last line; move this line above line 1',
    ]);
    expect(issuesOf("let sin = 1\nout = vec3(sin)").issues[0]).toBe(
      'error@1: "sin" is a function; pick another name',
    );
    expect(issuesOf("out = vec3(1, 2)").issues).toEqual([
      "error@1: vec3 needs 3 parts in all (or one number for all), and these make 2",
    ]);
    expect(issuesOf("out = noise(1)").issues).toEqual([
      "error@1: noise takes a vec2 (e.g. noise(uv * 8)), not a number",
    ]);
    // Names inherited from Object.prototype are ordinary names.
    expect(issuesOf("let toString = 1\nout = vec3(toString)")).toEqual({
      ok: true,
      issues: [],
    });
    expect(issuesOf("out = toString(1)").issues).toEqual([
      'error@1: there is no function "toString"; the functions are sin, cos, tan, asin, acos, atan, sqrt, exp, log, abs, sign, floor, ceil, fract, pow, mod, min, max, clamp, mix, step, smoothstep, select, length, distance, dot, normalize, hash, noise, vec2, vec3, vec4',
    ]);
    expect(issuesOf("out = vec3(1) $").issues).toEqual([
      'error@1: unexpected character "$"',
    ]);
    expect(issuesOf("let a = (1 +\n 2)\nout = vec3(a)")).toEqual({
      ok: true,
      issues: [],
    });
  });

  it("keeps going after an error so every bad line is reported", () => {
    expect(issuesOf("let a = foo\nlet b = uv.q\nout = vec3(1)").issues).toEqual(
      [
        'error@1: there is no "foo"; built in: uv, pos, size, time, PI, TAU',
        'error@2: ".q" isn\'t a part of a vector; use up to four of x y z w (or r g b a)',
      ],
    );
  });

  it("warns about unused controls and lets but still compiles", () => {
    expect(issuesOf("control a: number = 1\nlet b = 2\nout = vec3(0)")).toEqual(
      {
        ok: true,
        issues: [
          'warning@1: control "a" isn\'t used',
          'warning@2: "b" isn\'t used',
        ],
      },
    );
  });

  it("refuses programs over the cost or length limit", () => {
    const heavy = `out = vec3(${Array.from({ length: 300 }, () => "noise(uv)").join(" + ")})`;
    const r = compilePixelSource(heavy);
    expect(r.ok).toBe(false);
    expect(r.issues[0].message).toMatch(
      /^the program does \d+ steps per pixel; the limit is 1024/,
    );
    expect(
      compilePixelSource("out = vec3(1)", { maxSourceLength: 5 }).issues[0]
        .message,
    ).toBe("the source is 13 characters; the limit is 5");
  });
});

describe("pixel expressions: evaluating", () => {
  it("draws uv as colour at pixel centres", () => {
    expect(px("out = vec3(uv, 0)")).toEqual([
      64, 64, 0, 255, 191, 64, 0, 255, 64, 191, 0, 255, 191, 191, 0, 255,
    ]);
  });

  it("grey, alpha, clamping and NaN", () => {
    expect(px("out = 0.5", 1, 1)).toEqual([128, 128, 128, 255]);
    expect(px("out = vec4(2, -1, sqrt(-1), 0.25)", 1, 1)).toEqual([
      255, 0, 0, 64,
    ]);
    expect(px("out = vec3(log(-1), 0, 0)", 1, 1)).toEqual([0, 0, 0, 255]);
  });

  it("uses controls, time and functions", () => {
    const src =
      "control c: color = #ff0000\ncontrol k: number = 1\nout = vec3(c.r * k, step(1, time), mod(-1, 3) / 4)";
    expect(px(src, 1, 1, 0)).toEqual([255, 0, 128, 255]);
    expect(px(src, 1, 1, 1000, { k: 0.5, c: "#808080" })).toEqual([
      64, 255, 128, 255,
    ]);
    expect(
      px(
        "out = vec3(select(uv.x > 0.5, 1, 0), smoothstep(0, 1, 0.5), clamp(3, 0, 0.25))",
        2,
        1,
      ),
    ).toEqual([0, 128, 64, 255, 255, 128, 64, 255]);
    expect(
      px(
        "out = vec3(length(vec2(3, 4)) / 10, dot(vec2(1), vec2(0.25)), normalize(vec2(0, 2)).y)",
        1,
        1,
      ),
    ).toEqual([128, 128, 255, 255]);
    expect(
      px(
        "out = vec3(atan(1, 1) / PI * 4 - 0.5, pow(0.5, 2), -vec2(-0.5).x)",
        1,
        1,
      ),
    ).toEqual([128, 64, 128, 255]);
  });

  it("hash and noise are fixed numbers (Swift and MSL match them)", () => {
    expect(pixelHash(0, 0)).toBe(0);
    expect(pixelHash(1, 0)).toBe(0.2367340091150254);
    expect(pixelHash(-2, 5)).toBe(0.1857259776443243);
    expect(pixelHash(-3.5, 7.25)).toBeCloseTo(pixelHash(-4, 7), 12);
    expect(pixelNoise(0.5, 0.5)).toBeCloseTo(
      (pixelHash(0, 0) + pixelHash(1, 0) + pixelHash(0, 1) + pixelHash(1, 1)) /
        4,
      12,
    );
    expect(pixelHash(1e12, -1e12)).toBe(pixelHash(1e9, -1e9));
  });
});

describe("pixel expression provider and authoring", () => {
  it("conforms to the effects contract, authoring included", async () => {
    expect(
      await checkEffectProvider(
        createPixelEffectProvider({ session: { schedule: manual() } }),
      ),
    ).toEqual([]);
  });

  it("opens a template with source editing", async () => {
    const p = createPixelEffectProvider({ session: { schedule: manual() } });
    const s = await p.openAuthoring!({ effectId: "pixel.blank" });
    const st = s.getState();
    expect(st.sourceLanguage).toBe("pixel");
    expect(st.source).toBe(PIXEL_TEMPLATES[0].source);
    expect(st.compiled).toBe(true);
    expect(Object.keys(st.description.controls.properties)).toEqual([
      "top",
      "bottom",
    ]);
    expect(typeof s.setSource).toBe("function");
  });

  it("setSource: errors keep the last good controls, a fix changes them, undo goes back", async () => {
    const p = createPixelEffectProvider({ session: { schedule: manual() } });
    const s = await p.openAuthoring!({ effectId: "pixel.blank" });
    expect(s.setValue("top", "#000000").ok).toBe(true);

    const bad = await s.setSource!(
      "control top: color = #000000\nout = vec3(nope)",
    );
    expect(bad).toEqual({
      ok: true,
      issues: [
        {
          severity: "error",
          line: 2,
          message:
            'there is no "nope"; defined so far: top; built in: uv, pos, size, time, PI, TAU',
        },
      ],
    });
    expect(s.getState().compiled).toBe(false);
    expect(s.getState().issues).toHaveLength(1);
    expect(Object.keys(s.getState().description.controls.properties)).toEqual([
      "top",
      "bottom",
    ]);

    const good = await s.setSource!(
      "control top: color = #ffffff // Top.\ncontrol glow: number = 0.5 range 0 1 // Glow.\nout = vec4(top, glow)",
    );
    expect(good).toEqual({ ok: true, issues: [] });
    const st = s.getState();
    expect(st.compiled).toBe(true);
    expect(Object.keys(st.description.controls.properties)).toEqual([
      "top",
      "glow",
    ]);
    // "top" is still there and its value still fits, so it is kept.
    expect(st.values).toEqual({ top: "#000000", glow: 0.5 });
    expect(st.description.transparent).toBe(true);

    const preview = await s.createPreview({ width: 1, height: 1 });
    expect([...(await preview.render({ time: 0 })).data]).toEqual([
      0, 0, 0, 128,
    ]);

    expect(s.undo()).toBe(true);
    expect(s.getState().compiled).toBe(false);
    expect(s.undo()).toBe(true);
    expect(s.getState().source).toBe(PIXEL_TEMPLATES[0].source);
    expect(Object.keys(s.getState().description.controls.properties)).toEqual([
      "top",
      "bottom",
    ]);
    // The preview follows the source that compiles now.
    const back = (await preview.render({ time: 0 })).data;
    expect([back[0], back[3]]).toEqual([128, 255]);
    preview.dispose();
  });

  it("refuses a source over the length limit and changes nothing", async () => {
    const p = createPixelEffectProvider({
      limits: { maxSourceLength: 40 },
      session: { schedule: manual() },
    });
    const s = await p.openAuthoring!({ effectId: "pixel.blank" }).catch(
      (e) => e,
    );
    expect(String(s.message)).toMatch(
      /can't be opened: the source is \d+ characters; the limit is 40/,
    );
    const p2 = createPixelEffectProvider({ session: { schedule: manual() } });
    const s2 = await p2.openAuthoring!({ effectId: "pixel.blank" });
    const before = s2.getState();
    expect(await s2.setSource!("x".repeat(70000))).toEqual({
      ok: false,
      message: "the source is 70000 characters; the limit is 65536",
    });
    expect(s2.getState()).toBe(before);
  });

  it("exports a document with its source and reopens it anywhere", async () => {
    const p = createPixelEffectProvider({ session: { schedule: manual() } });
    const s = await p.openAuthoring!({ effectId: "pixel.rings" });
    await s.setSource!("control k: number = 0.25 range 0 1 // Grey.\nout = k");
    s.setValue("k", 0.75);
    s.setKeyframe("k", 0, 0);
    s.setKeyframe("k", 1000, 1);
    const doc = JSON.parse(JSON.stringify(s.exportDocument()));
    expect(doc).toMatchObject({
      version: 1,
      providerId: "pixel",
      effectId: "pixel.rings",
      sourceLanguage: "pixel",
      source: "control k: number = 0.25 range 0 1 // Grey.\nout = k",
    });
    const again = await createPixelEffectProvider({
      session: { schedule: manual() },
    }).openAuthoring!({ document: doc });
    expect(again.getState().source).toBe(doc.source);
    expect(again.getState().tracks).toEqual(s.getState().tracks);
    const preview = await again.createPreview({ width: 1, height: 1 });
    expect([...(await preview.render({ time: 500 })).data]).toEqual([
      128, 128, 128, 255,
    ]);
  });

  it("a document whose source does not compile is refused with the lines", async () => {
    const p = createPixelEffectProvider({ session: { schedule: manual() } });
    const doc = {
      version: 1,
      providerId: "pixel",
      effectId: "pixel.blank",
      name: "Broken",
      values: {},
      tracks: {},
      presets: [],
      duration: 1000,
      loop: false,
      source: "out = vec3(q)",
      sourceLanguage: "pixel",
    };
    await expect(p.openAuthoring!({ document: doc })).rejects.toThrow(
      /doesn't compile \(line 1: there is no "q"/,
    );
  });
});
