import { describe, expect, it } from "vitest";
import {
  parseColor,
  isColor,
  formatHex,
  formatColor,
  normalizeColor,
  rgbToOklab,
  oklabToRgb,
  rgbToHsl,
  hslToRgb,
  rgbToHsv,
  hsvToRgb,
  oklabToOklch,
  oklchToOklab,
  linearSrgbToDisplayP3,
  displayP3ToLinearSrgb,
  srgbToLinear,
  inSrgbGamut,
  toSrgbGamut,
  deltaEOK,
  relativeLuminance,
  contrastRatio,
  contrastLevel,
  readableTextColor,
  simulateColorVision,
  checkPaletteColors,
  colorHarmony,
  mixColors,
  pushRecentColor,
  NAMED_COLORS,
} from "../src/color/index.js";
import { normalizeTokenColor } from "../src/tokens/color.js";
import { checkChartColors } from "../src/chart/color.js";
import { colorHarmony as paintColorHarmony } from "../src/paint-editor/color.js";
import { mixColorsOklab } from "../src/animation/color.js";

function seededLcg(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe("parsing & formatting", () => {
  it("parses and formats hex colours correctly", () => {
    expect(normalizeColor("#ABC")).toBe("#aabbcc");
    expect(normalizeColor("#aabbccff")).toBe("#aabbcc");
    expect(normalizeColor("#12345678")).toBe("#12345678");
    expect(normalizeColor("#fff")).toBe("#ffffff");
    expect(normalizeColor("#000000")).toBe("#000000");
  });

  it("parses rgb and rgba strings", () => {
    expect(normalizeColor("rgb(255 0 0 / 50%)")).toBe("#ff000080");
    expect(normalizeColor("rgba(0, 128, 255, 0.5)")).toBe("#0080ff80");
    expect(normalizeColor("rgb(100% 0% 0%)")).toBe("#ff0000");
  });

  it("parses hsl and hsla strings", () => {
    expect(normalizeColor("hsl(120 100% 25%)")).toBe("#008000");
    expect(normalizeColor("hsla(240, 100%, 50%, 0.5)")).toBe("#0000ff80");
  });

  it("parses named colours", () => {
    expect(normalizeColor("rebeccapurple")).toBe("#663399");
    expect(normalizeColor("transparent")).toBe("#00000000");
    expect(normalizeColor("white")).toBe("#ffffff");
    expect(normalizeColor("black")).toBe("#000000");
    expect(NAMED_COLORS["coral"]).toBe("#ff7f50");
  });

  it("parses oklab and oklch strings", () => {
    const oklchRed = parseColor("oklch(62.8% 0.2577 29.23)");
    expect(oklchRed).not.toBeNull();
    // each channel within 1/255 of red (1, 0, 0)
    expect(Math.abs(oklchRed!.r - 1)).toBeLessThan(1 / 255 + 0.01);
    expect(Math.abs(oklchRed!.g - 0)).toBeLessThan(1 / 255 + 0.01);
    expect(Math.abs(oklchRed!.b - 0)).toBeLessThan(1 / 255 + 0.01);

    const oklabParsed = parseColor("oklab(0.5 0.1 -0.1 / 0.8)");
    expect(oklabParsed).not.toBeNull();
    expect(oklabParsed!.a).toBeCloseTo(0.8, 2);
  });

  it("parses color() expressions", () => {
    const srgb = parseColor("color(srgb 1 0 0 / 0.5)");
    expect(srgb).toEqual({ r: 1, g: 0, b: 0, a: 0.5 });

    const srgbLinear = parseColor("color(srgb-linear 0.5 0.5 0.5)");
    expect(srgbLinear).not.toBeNull();

    const p3 = parseColor("color(display-p3 1 0 0)");
    expect(p3).not.toBeNull();
  });

  it("parses token objects", () => {
    expect(normalizeColor({ r: 1, g: 0, b: 0, a: 0.5 })).toBe("#ff000080");
    expect(
      normalizeColor({ colorSpace: "srgb", components: [0, 1, 0], alpha: 1 })
    ).toBe("#00ff00");
  });

  it("returns null for invalid inputs", () => {
    expect(parseColor("var(--x)")).toBeNull();
    expect(parseColor("")).toBeNull();
    expect(parseColor("#ggg")).toBeNull();
    expect(parseColor("a".repeat(201))).toBeNull();
    expect(parseColor({})).toBeNull();
    expect(parseColor(42)).toBeNull();
    expect(isColor("var(--x)")).toBe(false);
    expect(isColor("#ff0000")).toBe(true);
  });

  it("supports formatColor to different formats", () => {
    const red = { r: 1, g: 0, b: 0, a: 1 };
    expect(formatColor(red, "hex")).toBe("#ff0000");
    expect(formatColor(red, "rgb")).toBe("rgb(255 0 0)");
    expect(formatColor(red, "hsl")).toBe("hsl(0 100% 50%)");
    expect(formatColor(red, "oklab")).toContain("oklab(");
    expect(formatColor(red, "oklch")).toContain("oklch(");

    const halfBlue = { r: 0, g: 0, b: 1, a: 0.5 };
    expect(formatColor(halfBlue, "hex")).toBe("#0000ff80");
    expect(formatColor(halfBlue, "rgb")).toBe("rgb(0 0 255 / 0.5)");
    expect(formatColor(halfBlue, "hsl")).toBe("hsl(240 100% 50% / 0.5)");
  });
});

describe("tokens parity", () => {
  it("matches normalizeTokenColor on a representative suite", () => {
    const samples = [
      "#FFF",
      "#ffffff",
      "#000000",
      "#0D99FF",
      "#0d99ff",
      "#0000ff80",
      "#000f",
      "#336699",
      "#cccccc",
      "#eeeeee",
      "#123456",
      "rgb(255, 0, 0)",
      "rgba(255 0 0 / 50%)",
      "rgba(0,0,255,0.5)",
      "transparent",
      "black",
      "white",
      { r: 1, g: 0, b: 0, a: 0.5 },
      { colorSpace: "srgb", components: [0, 1, 0], alpha: 1 },
      "red-ish",
      "#12",
      "rgb(1,2)",
      3,
      null,
    ];

    for (const sample of samples) {
      expect(normalizeColor(sample)).toBe(normalizeTokenColor(sample));
    }
  });
});

describe("round trips", () => {
  it("hex -> OKLab -> hex and hex -> HSL -> hex preserve colour for 50 seeded random colours", () => {
    const rand = seededLcg(12345);
    const byte = () => Math.floor(rand() * 256);
    const toHex2 = (n: number) => n.toString(16).padStart(2, "0");

    for (let i = 0; i < 50; i++) {
      const hex = `#${toHex2(byte())}${toHex2(byte())}${toHex2(byte())}`;
      const parsed = parseColor(hex)!;

      // Hex -> OKLab -> Hex
      const oklab = rgbToOklab(parsed);
      const backRgbFromOklab = oklabToRgb(oklab);
      expect(formatHex(backRgbFromOklab)).toBe(hex);

      // Hex -> HSL -> Hex
      const hsl = rgbToHsl(parsed);
      const backRgbFromHsl = hslToRgb(hsl);
      expect(formatHex(backRgbFromHsl)).toBe(hex);

      // Hex -> HSV -> Hex
      const hsv = rgbToHsv(parsed);
      const backRgbFromHsv = hsvToRgb(hsv);
      expect(formatHex(backRgbFromHsv)).toBe(hex);
    }
  });

  it("OKLab <-> OKLCH round trip", () => {
    const lab = { l: 0.7, a: 0.1, b: -0.15, alpha: 1 };
    const lch = oklabToOklch(lab);
    const backLab = oklchToOklab(lch);
    expect(backLab.l).toBeCloseTo(lab.l, 5);
    expect(backLab.a).toBeCloseTo(lab.a, 5);
    expect(backLab.b).toBeCloseTo(lab.b, 5);
  });
});

describe("Display P3 & Gamut mapping", () => {
  it("handles Display P3 red properly", () => {
    const parsed = parseColor("color(display-p3 1 0 0)")!;
    expect(parsed).not.toBeNull();

    // Out of sRGB gamut
    expect(inSrgbGamut(parsed)).toBe(false);

    // Linear sRGB is about (1.2249, -0.0421, -0.0196) (tolerance 1e-3)
    const linR = srgbToLinear(parsed.r);
    const linG = srgbToLinear(parsed.g);
    const linB = srgbToLinear(parsed.b);
    expect(linR).toBeCloseTo(1.2249, 3);
    expect(linG).toBeCloseTo(-0.0421, 3);
    expect(linB).toBeCloseTo(-0.0196, 3);

    // formatHex maps into sRGB gamut and is still clearly red (r > 0.9)
    const hex = formatHex(parsed);
    const mapped = parseColor(hex)!;
    expect(inSrgbGamut(mapped)).toBe(true);
    expect(mapped.r).toBeGreaterThan(0.9);
    expect(mapped.g).toBeLessThan(0.1);
    expect(mapped.b).toBeLessThan(0.1);
  });

  it("toSrgbGamut preserves in-gamut colours and clamps out-of-gamut colours preserving lightness", () => {
    const inside = { r: 0.4, g: 0.6, b: 0.8, a: 1 };
    expect(toSrgbGamut(inside)).toEqual(inside);

    const outside = parseColor("color(display-p3 1 0 0)")!;
    const mapped = toSrgbGamut(outside);
    expect(inSrgbGamut(mapped)).toBe(true);

    const outsideLab = rgbToOklab(outside);
    const mappedLab = rgbToOklab(mapped);
    expect(Math.abs(outsideLab.l - mappedLab.l)).toBeLessThan(0.02);
  });
});

describe("Contrast & Readability", () => {
  it("calculates WCAG contrast ratio correctly", () => {
    const black = { r: 0, g: 0, b: 0, a: 1 };
    const white = { r: 1, g: 1, b: 1, a: 1 };
    expect(contrastRatio(black, white)).toBeCloseTo(21, 2);

    // #777777 on white ≈ 4.48 -> fail (AA requires 4.5 for normal text), AA with large: true
    const gray77 = parseColor("#777777")!;
    const grayRatio = contrastRatio(gray77, white);
    expect(grayRatio).toBeCloseTo(4.48, 1);
    expect(contrastLevel(grayRatio, { large: false })).toBe("fail");
    expect(contrastLevel(grayRatio, { large: true })).toBe("AA");
  });

  it("composites translucent foreground over background", () => {
    const halfBlack = { r: 0, g: 0, b: 0, a: 0.5 };
    const white = { r: 1, g: 1, b: 1, a: 1 };
    // Half black on white produces gray #808080 equivalent
    const ratio = contrastRatio(halfBlack, white);
    expect(ratio).toBeGreaterThan(3);
    expect(ratio).toBeLessThan(5);
  });

  it("determines readable text colour", () => {
    expect(formatHex(readableTextColor(parseColor("#ffffff")!))).toBe("#000000");
    expect(formatHex(readableTextColor(parseColor("#000000")!))).toBe("#ffffff");
    expect(formatHex(readableTextColor(parseColor("#ffff00")!))).toBe("#000000"); // yellow -> dark text
    expect(formatHex(readableTextColor(parseColor("#000080")!))).toBe("#ffffff"); // navy -> light text
  });
});

describe("Vision, Harmony and Mixing parity", () => {
  it("checkPaletteColors matches checkChartColors", () => {
    const palette = ["#ff0000", "#00ff00", "#0000ff", "#ffff00"];
    const chartRes = checkChartColors(palette);
    const palRes = checkPaletteColors(palette);
    expect(palRes).toEqual(chartRes);
  });

  it("colorHarmony matches paint-editor colorHarmony", () => {
    const harmonies = [
      "complementary",
      "split-complementary",
      "analogous",
      "triadic",
      "tetradic",
      "square",
      "monochromatic",
    ] as const;

    for (const h of harmonies) {
      const fromColor = colorHarmony("#2a4b8d", h);
      const fromPaint = paintColorHarmony("#2a4b8d", h);
      expect(fromColor).toEqual(fromPaint);
    }
  });

  it("mixColors in oklab matches mixColorsOklab", () => {
    const c1 = "#ff0000";
    const c2 = "#0000ff";
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const mixed = mixColors(c1, c2, t, { space: "oklab" });
      const animMixed = mixColorsOklab(c1, c2, t);
      expect(mixed).toBe(animMixed);
    }
  });

  it("pushRecentColor manages recent colours array", () => {
    let recent: string[] = [];
    recent = pushRecentColor(recent, "#ff0000", 3);
    expect(recent).toEqual(["#ff0000"]);
    recent = pushRecentColor(recent, "#00ff00", 3);
    expect(recent).toEqual(["#00ff00", "#ff0000"]);
    recent = pushRecentColor(recent, "#ff0000", 3); // duplicate moves to front
    expect(recent).toEqual(["#ff0000", "#00ff00"]);
    recent = pushRecentColor(recent, "#0000ff", 3);
    recent = pushRecentColor(recent, "#ffff00", 3); // exceeds max 3
    expect(recent).toEqual(["#ffff00", "#0000ff", "#ff0000"]);
  });
});
