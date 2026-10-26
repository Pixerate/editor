import { createStyleResolver, createStyleToolProvider, memoryStyleStore } from "@pixerate/editor/agent";
import { chartStyleDomain } from "@pixerate/editor/chart";
import { TokenStore, createTokenStyleSource, tokensStyleDomain } from "@pixerate/editor/tokens";
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

/** The org layer: locked, so later layers cannot change what it sets. */
export const demoOrgStyles = memoryStyleStore({
  "acme-brand/SKILL.md": `---
name: acme-brand
description: Acme's house style for charts and design tokens.
domains: [chart, tokens]
---

Charts use the Acme palette, in order: primary for the main series, secondary to contrast, tertiary for a third.
Prefer bar and line charts; use a pie only for parts of one whole, with at most five slices.
Write titles in sentence case and say the finding ("Revenue doubled in Q3"), not the topic.
`,
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
  domains: [chartStyleDomain, tokensStyleDomain],
  tokens: createTokenStyleSource(demoBrandTokens),
});

// The `style` toolset is the same for every tab, so it is registered once.
demoToolRegistry.register(createStyleToolProvider(demoStyles));
