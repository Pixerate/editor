import { createStyleResolver, createStyleToolProvider, memoryStyleStore } from "@pixerate/editor/agent";
import { chartStyleDomain } from "@pixerate/editor/chart";
import { spreadsheetStyleDomain } from "@pixerate/editor/spreadsheet";
import { diagramStyleDomain } from "@pixerate/editor/diagram";
import { canvasStyleDomain } from "@pixerate/editor/canvas";
import { typographyStyleDomain } from "@pixerate/editor/typography";
import { imageStyleDomain } from "@pixerate/editor/image-editor";
import { paintStyleDomain } from "@pixerate/editor/paint-editor";
import { animationStyleDomain } from "@pixerate/editor/animation-editor";
import { videoStyleDomain } from "@pixerate/editor/video-editor";
import { generationStyleDomain } from "@pixerate/editor/generation";
import { parametersStyleDomain } from "@pixerate/editor/parameters";
import { vectorStyleDomain } from "@pixerate/editor/vector";
import { effectAuthoringStyleDomain } from "@pixerate/editor/effects";
import { stickerStyleDomain } from "@pixerate/editor/stickers";
import { brushStyleDomain } from "@pixerate/editor/brushes";
import { TokenStore, createTokenStyleSource, tokensStyleDomain } from "@pixerate/editor/tokens";
import { richTextStyleDomain } from "@pixerate/editor";
import { demoToolRegistry } from "./agentTools";

/** The brand tokens the org style's `$token` references resolve against. */
export const demoBrandTokens = new TokenStore();
demoBrandTokens.transact("seed", () => {
  const brand = demoBrandTokens.createCollection("Acme", ["Default"]);
  demoBrandTokens.createVariable({ collectionId: brand.id, name: "brand/primary", type: "color", value: "#0b5fff" });
  demoBrandTokens.createVariable({ collectionId: brand.id, name: "brand/secondary", type: "color", value: "#ff6a00" });
  demoBrandTokens.createVariable({ collectionId: brand.id, name: "brand/tertiary", type: "color", value: "#12a150" });
});
demoBrandTokens.replaceState(demoBrandTokens.getState(), { reason: "seed" });

/** One-of-a-kind chart looks the org offers (group "look"): the user picks one, in the chart tab or through choose_style. */
const look = (name: string, description: string, defaults: Record<string, unknown>) => ({
  [`${name}/SKILL.md`]: `---\nname: ${name}\ndescription: ${description}\ndomains: [chart]\ngroup: look\n---\n\n${description}\n`,
  [`${name}/chart.json`]: JSON.stringify({ defaults }, null, 2),
});

/** The org layer: locked, so later layers cannot change what it sets. */
export const demoOrgStyles = memoryStyleStore({
  // The org's rules for sheets and diagrams (check_spreadsheet_style, check_diagram_style).
  "acme-data/SKILL.md": `---
name: acme-data
description: Acme's rules for spreadsheets and diagrams.
domains: [spreadsheet, diagram]
---

Headers and labels in sentence case. Money with two decimals. Diagrams flow left to right.
`,
  "acme-data/spreadsheet.json": JSON.stringify(
    { headerCase: "sentence", numberFormats: { currency: '"$"#,##0.00', percentage: "0.0%" }, freezeHeader: true, checks: ["header-case", "number-formats", "freeze-header"] },
    null,
    2,
  ),
  "acme-data/diagram.json": JSON.stringify(
    { directions: ["LR", "TB"], labelCase: "sentence", maxLabelLength: 40, checks: ["direction", "label-case", "label-length"] },
    null,
    2,
  ),
  // The org's rules for boards and type (check_canvas_style, check_typography_style).
  "acme-design/SKILL.md": `---
name: acme-design
description: Acme's rules for canvas boards and type.
domains: [canvas, typography]
---

Corners 0, 4 or 8. Strokes 1 or 2. Everything on the 8-unit grid. Type from the house scale.
`,
  "acme-design/canvas.json": JSON.stringify({ cornerRadii: [0, 4, 8], strokeWidths: [1, 2], fontSizes: [12, 14, 16, 20, 24, 32], grid: 8, checks: ["corner-radii", "stroke-widths", "font-sizes", "grid"] }, null, 2),
  "acme-design/typography.json": JSON.stringify({ weights: [400, 600, 700], sizes: [12, 14, 16, 20, 24, 32], lineHeight: { min: 1.3, max: 1.7 }, checks: ["weights", "sizes", "line-height"] }, null, 2),
  // The org's rules for photos and paintings (check_image_style, check_paint_style).
  "acme-pictures/SKILL.md": `---
name: acme-pictures
description: Acme's rules for photos and paintings.
domains: [image-editor, paint-editor]
---

Photos ship square or 4:5 with a natural look. Paintings on watercolour paper.
`,
  "acme-pictures/image-editor.json": JSON.stringify({ aspectRatios: ["1:1", "4:5", "16:9"], adjustments: { saturation: { min: -30, max: 30 } }, checks: ["aspect-ratio", "adjustment-ranges"] }, null, 2),
  "acme-pictures/paint-editor.json": JSON.stringify({ papers: ["cold-pressed", "hot-pressed", "rough-watercolor"], maxLayers: 20, checks: ["paper", "max-layers"] }, null, 2),
  // The org's rules for vector art, effects, stickers and brushes (check_vector_style, check_effect_authoring_style,
  // check_sticker_style, check_brush_style).
  "acme-assets/SKILL.md": `---
name: acme-assets
description: Acme's rules for vector art, authored effects, stickers and brushes.
domains: [vector, effect-authoring, stickers, brushes]
---

Strokes 1, 2 or 4; corners 4 or 8. Effects loop within four seconds. Stickers and brushes only with licences we can sell under.
`,
  "acme-assets/vector.json": JSON.stringify({ strokeWidths: [1, 2, 4], cornerRadii: [4, 8], checks: ["stroke-widths", "corner-radii"] }, null, 2),
  "acme-assets/effect-authoring.json": JSON.stringify({ maxDuration: 4000, loop: true, checks: ["timing"] }, null, 2),
  "acme-assets/stickers.json": JSON.stringify({ commercialOnly: true, checks: ["commercial"] }, null, 2),
  "acme-assets/brushes.json": JSON.stringify({ requireSourceLicence: true, checks: ["source-licences"] }, null, 2),
  // The org's rules for motion (check_animation_style, check_video_style).
  "acme-motion/SKILL.md": `---
name: acme-motion
description: Acme's rules for animation and video.
domains: [animation-editor, video-editor]
---

Calm motion: ease out, nothing faster than 200 ms, hold each shot long enough to read.
`,
  "acme-motion/animation-editor.json": JSON.stringify({ easings: ["ease-out", "ease-in-out", "linear"], durations: { min: 150, max: 2000 }, minHold: 400, checks: ["easings", "durations", "holds"] }, null, 2),
  "acme-motion/video-editor.json": JSON.stringify({ fps: [30, 25, 24], titleSizes: { min: 40 }, transitions: ["crossfade", "dip"], maxTransition: 1000, checks: ["fps", "title-sizes", "transitions"] }, null, 2),
  // The org's rules for generated art (check_generation_style before spending).
  "acme-generation/SKILL.md": `---
name: acme-generation
description: Acme's rules for generated images.
domains: [generation]
---

Generated art is flat and calm, never photorealistic, never with text in it.
`,
  "acme-generation/generation.json": JSON.stringify({ maxCount: 4, promptSuffix: "flat vector illustration, calm colours", negativeTerms: ["text", "watermark"], bannedTerms: ["photorealistic"], checks: ["limits", "prompt-suffix", "negative-terms", "banned-terms"] }, null, 2),
  // The org's writing style for documents (the Documents tab): checked by check_rich_text_style.
  "acme-writing/SKILL.md": `---
name: acme-writing
description: Acme's writing style for documents and reports.
domains: [rich-text]
---

Write plainly: short sentences, the finding first. Headings in sentence case.
`,
  "acme-writing/rich-text.json": JSON.stringify(
    {
      headingCase: "sentence",
      properNouns: ["Acme", "Pixerate", "Word", "Mermaid"],
      maxHeadingLevel: 3,
      quotes: "curly",
      terms: [{ avoid: "utilize", use: "use" }, { avoid: "click here", note: "link text says where it goes" }],
      thousandsSeparator: ",",
      checks: ["heading-case", "heading-levels", "quotes", "terms", "number-format"],
    },
    null,
    2,
  ),
  ...look("look-calm", "Calm charts: smooth lines, no stacking.", { curve: "smooth", stacking: "none" }),
  ...look("look-dense", "Dense charts: stacked bars and step lines for dashboards.", { curve: "step", stacking: "stacked" }),
  "acme-brand/SKILL.md": `---
name: acme-brand
description: Acme's house style for charts and design tokens.
domains: [chart, tokens]
---

Charts use the Acme palette, in order: primary for the main series, secondary to contrast, tertiary for a third.
Prefer bar and line charts; use a pie only for parts of one whole, with at most five slices.
Write titles in sentence case and say the finding ("Revenue doubled in Q3"), not the topic.
`,
  // The brand every domain shares: charts derive their theme from it (chart.json refines it).
  "acme-brand/brand.json": JSON.stringify(
    {
      name: "Acme",
      colors: { primary: { $token: "brand/primary" }, secondary: { $token: "brand/secondary" }, accent: { $token: "brand/tertiary" }, text: "#1a1a1a", background: "#ffffff" },
      fonts: { heading: "Inter", body: "Inter" },
    },
    null,
    2,
  ),
  "acme-brand/chart.json": JSON.stringify(
    {
      palette: [{ $token: "brand/primary" }, { $token: "brand/secondary" }, { $token: "brand/tertiary" }],
      theme: { fontFamily: "Inter, system-ui, sans-serif" },
      checks: ["palette-only", "distinguishable", "min-contrast", { id: "allowed-type", types: ["bar", "line", "area", "pie", "donut"] }],
    },
    null,
    2,
  ),
  "acme-brand/tokens.json": JSON.stringify(
    {
      namePattern: "^[a-z0-9-]+(/[a-z0-9-]+)*$",
      contrastPairs: [
        { fg: "color/text", bg: "color/surface", ratio: 4.5 },
        { fg: "color/accent", bg: "color/surface", ratio: 3 },
      ],
      checks: ["name-pattern", "contrast-pairs"],
    },
    null,
    2,
  ),
});

/** The user layer: a personal preference on top of the org's. */
export const demoUserStyles = memoryStyleStore({
  "big-labels/SKILL.md": `---
name: big-labels
description: My preference for readable charts.
domains: [chart]
---

I read charts on a laptop: turn data labels on and keep the text large.
`,
  "big-labels/chart.json": JSON.stringify({ theme: { fontSize: 14 }, defaults: { dataLabels: true } }, null, 2),
});

/** House styles for the demo's chart and tokens tabs. */
export const demoStyles = createStyleResolver({
  layers: [
    { id: "org", store: demoOrgStyles, locked: true },
    { id: "user", store: demoUserStyles },
  ],
  domains: [chartStyleDomain, tokensStyleDomain, richTextStyleDomain, spreadsheetStyleDomain, diagramStyleDomain, canvasStyleDomain, typographyStyleDomain, imageStyleDomain, paintStyleDomain, animationStyleDomain, videoStyleDomain, generationStyleDomain, parametersStyleDomain, vectorStyleDomain, effectAuthoringStyleDomain, stickerStyleDomain, brushStyleDomain],
  tokens: createTokenStyleSource(demoBrandTokens),
});

// The `style` toolset is the same for every tab, so it is registered once.
demoToolRegistry.register(createStyleToolProvider(demoStyles));
