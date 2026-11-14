---
"@pixerate/editor": minor
---

A page kit for generated pages (closes #814): `@pixerate/editor/page-kit` exports strings only, so importing it pulls in nothing.

- `PAGE_KIT` is one minified script (about 42 kB, budget 60 kB) that sets `window.pixerateKit` in a sandboxed page. It holds core's own label placement and hull, isometric projection, connectors, fans and helices with front/back runs, path length, point-at-length and trim, `fitText` / `staggerRows` with a canvas or estimated measure, contrast, ink, colour mixing, ramps and hex, nice scales, `linearMap` and number formats, plus a thin page layer: `svg`, `clear`, `onResize`, `theme` (mode, host tokens, `pixerate:theme` redraws), `defineMotion` (the page motion contract `window.pageMotion = { duration, seek(p), play(), stop(), progress, playing }`: frame-pure, rest state first, no animation when hidden or under reduced motion, keeps its frame across redraws), `ease` and `phase`.
- `PAGE_KIT_GUIDE` tells a model what each helper is for; a test checks it names every export and nothing else. `PAGE_KIT_FILES` (`kit.js`, `kit.md`) plugs into genui-core's `assemblePage({ kits })`. `PAGE_KIT_VERSION` and `PAGE_KIT_HASH` tell builds apart.
- Built by `scripts/build-page-kit.mjs` (`pnpm --filter @pixerate/editor build:page-kit`) into a committed, deterministic `bundle.generated.ts`; tests fail when it is stale.
- `formatPlainChartNumber` (`/chart`): `formatChartNumber` without spreadsheet format codes, so a bundle can write numbers without the format-code parser. `formatChartNumber` is unchanged.
