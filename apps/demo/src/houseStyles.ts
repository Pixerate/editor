import { createStyleResolver, createStyleToolProvider, memoryStyleStore } from "@pixerate/editor/agent";
import { chartStyleDomain } from "@pixerate/editor/chart";
import { spreadsheetStyleDomain } from "@pixerate/editor/spreadsheet";
import { diagramStyleDomain } from "@pixerate/editor/diagram";
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
  domains: [chartStyleDomain, tokensStyleDomain, richTextStyleDomain, spreadsheetStyleDomain, diagramStyleDomain],
  tokens: createTokenStyleSource(demoBrandTokens),
});

// The `style` toolset is the same for every tab, so it is registered once.
demoToolRegistry.register(createStyleToolProvider(demoStyles));
