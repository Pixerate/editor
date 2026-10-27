# Shared typography module and font management

Status: **phases 1–5 and 7 built; phase 6 built for effects, the rest is follow-up work** (see
[What is left](#what-is-left)). This document started as the implementation plan for a
centralized, DOM-free typography engine in `@pixerate/editor/typography`; it now records what
was built, where it differs from the plan and why.

---

## Why

Typography was fragmented across the editors:

- The **vector editor** is the only surface with font shaper queries (`vector.listFonts`), full
  metrics (size, tracking, leading, baseline shift), styled runs and outline conversion.
- The **video editor**'s title clips have flat font properties (`fontSize`, `fontFamily`,
  `fontWeight`, `color`, `background`) without tracking, leading or title-safe checks.
- The **canvas** and **chart** editors treat text as plain strings, with no font discovery,
  hierarchy tokens or minimum legible sizes.
- The **rich text editor** relies on DOM/CSS inheritance.
- **Effect authoring** (`@pixerate/editor/effects`) exposed text controls as unconstrained strings,
  with no font selector for `title` effects.
- [`pixerate-color`](../packages/core/src/color) checks WCAG contrast but had to be told whether
  text is "large"; nothing checked measure or line spacing.
- The **animation editor** had to convert text to outlines before splitting it into letters or words.

## Architecture (the colour blueprint)

Built exactly on the [`pixerate-color`](../packages/core/src/color) pattern:

```
packages/core/src/typography/      DOM-free, no third-party imports (entry-isolation tested)
  types.ts        FontSpec, FontWeight, FontCategory, scale and audit result types, labels
  weight.ts       normalizeFontWeight, nearestFontWeight (CSS font-matching order), isFontWeight
  scale.ts        modular ratios, computeTypeScale, generateTypeHierarchy, typeHierarchyToCss,
                  computeFluidSize, recommendedLineHeight / recommendedLetterSpacing
  metrics.ts      auditTextReadability, estimateCharactersPerLine
  stack.ts        FONT_STACKS, parseFontFamily, quoteFontFamily, formatFontFamily, resolveFontFallback
  segment.ts      segmentText (grapheme / word / sentence / line), graphemes, countGraphemes
  accessibility.ts isLargeText, checkTypographyAccessibility (uses color/contrast + color/suggest)
  registry.ts     FontSummary, FontProvider, filterFonts, findFont, combineFontProviders, ensureFontsLoaded
  catalog.ts      SYSTEM_FONT_CATALOG, guessFontCategory, createCatalogFontProvider,
                  createSystemFontProvider, createWebFontProvider, fontFaceCss, webFontSummary
  picker.ts       FontPickerModel, createFontPicker, offeredWeights
  tools.ts        createTypographyToolProvider, createFontPickerToolProvider
```

| Core | React | Svelte |
| --- | --- | --- |
| `@pixerate/editor/typography` | `@pixerate/editor-react/typography` | `@pixerate/editor-svelte/typography` |
| `FontPickerModel` | `useFontPicker`, `<FontPicker>`, `<TypographyControl>` | `fontPickerOf`, `<FontPicker>`, `<TypographyControl>` |

Each package has a `./typography` export, a build entry, and an entry-isolation test row;
`pnpm check:packages` type-checks and imports the new subpaths (it reads `exports`, so no script
change was needed). The React and Svelte entries re-export the core module, like `/color`.

## What was built

### Phase 1: types, scales, measure, stacks, segmentation, accessibility

- **Types.** `FontSpec { family, weight?, style?, size (px), lineHeight? (unitless), letterSpacing? (em), category? }`.
- **Scales.** The eight named ratios (`minor-second` 1.067 … `golden-ratio` 1.618) or a custom
  ratio above 1 and at most 4. Each step carries a recommended line-height (1.5 up to 16px, easing
  to 1.1 at 64px) and tracking (+0.01em below 14px, down to −0.03em at 64px and above).
  `generateTypeHierarchy` names steps −2…5 `caption`, `body-sm`, `body`, `h4`, `h3`, `h2`, `h1`,
  `display`; `typeHierarchyToCss` writes `--<prefix>-<name>-size` (rem), `-line-height` and
  `-letter-spacing` custom properties.
- **Fluid sizes.** `computeFluidSize` returns `clamp(min, slope·vw ± intercept, max)` with rem
  bounds, plus `slope`, `intercept` and `evaluateAt(viewport)`; shrinking type keeps the clamp
  bounds ordered.
- **Readability.** `auditTextReadability(text, { size, lineHeight, letterSpacing, width, category })`
  measures characters per line from the text's own lines, or estimates it from a column `width`
  and `size` (average glyph advance per category). It reports line spacing against 1.5, all-caps
  runs, tiny sizes, very tight tracking, word count and reading time (238 wpm), with an `issues` list.
- **Stacks.** `FONT_STACKS` has the plan's six stacks plus `handwriting` and `display`.
  `parseFontFamily` handles quotes, escapes and commas inside quotes; `resolveFontFallback` appends
  the category's stack, drops duplicates, and leaves a stack that already ends in a generic family alone.
- **Segmentation.** `segmentText(text, granularity, { locale, wordsOnly, maxCharacters })` with
  UTF-16 `start` / `end` offsets, using `Intl.Segmenter` with a regex fallback.
- **Accessibility.** `checkTypographyAccessibility({ font, foreground, background })` decides large
  text (24px, or 18.67px at weight 700+), reports the ratio, level and required ratios, flags tiny
  and thin type, and suggests a passing foreground.

### Phase 2: pluggable providers and catalog

- `FontProvider { id, listFonts(), hasFont(), loadFont?() }` and `FontSummary` as planned, plus
  `platforms` on summaries, `filterFonts`, `combineFontProviders` (merge by family, first wins)
  and `ensureFontsLoaded` (load every face a set of specs needs, once each).
- `SYSTEM_FONT_CATALOG`: metadata for 63 common system fonts on macOS, Windows, iOS, Android and
  Linux; no font files.
- `createSystemFontProvider({ platform?, catalog?, queryLocalFonts? })` and
  `createWebFontProvider({ fonts, fontFaceSet?, createFontFace? })`; see deviations.

### Phase 3: agent tools and skill

`createTypographyToolProvider({ provider? })` (namespace `typography`): `list_fonts`,
`resolve_font_stack`, `suggest_type_scale`, `generate_type_hierarchy`, `compute_fluid_type_size`,
`audit_text_readability`, `check_typography_accessibility`, `segment_text`, and `load_font` (listed
only when the provider can load). `createFontPickerToolProvider(model, { readOnly? })` (namespace
`fontpicker`): `get_font_selection`, `list_picker_fonts`, `set_font_selection`. All have strict
schemas, titles, four annotations and described arguments; they are in the conformance test
(`tests/command-tools.test.ts`), the skill map (`tests/agent-skills.test.ts`) and the new
[`pixerate-typography`](../packages/core/skills/pixerate-typography/SKILL.md) skill.

### Phase 4: headless picker

`FontPickerModel` keeps the value (family, weight, style, size, line height, tracking, category),
category filter, search (prefix matches first), recents, the highlighted option with combobox key
handling (`handleKey`: arrows, Home, End, Enter, Escape), per-family load status, preview text and
CSS for the selection. `getState()` returns the same object until something changes
(`useSyncExternalStore`-safe). `setValue` is for controlled components and does not notify
`onValueChange`; user and agent changes do.

### Phase 5: React and Svelte UI

`<FontPicker>` (combobox over a listbox of families shown in their own face, category filter,
weight and style selects, preview, status) and `<TypographyControl>` (the picker plus size, line
height and letter spacing inputs) in both frameworks, themeable through `--pixerate-font-picker-*`
custom properties, with `useFontPicker` (React) and `fontPickerOf` (Svelte). Both accept a shared
`model`, so the agent's font picker tools and the person edit the same control.

### Phase 6: cross-editor integration (effects)

- `effectControlField` / `effectParameterFields` turn string controls with `format: "font"` or
  `"x-pixerate-control": "font"` into a font choice (families from `options.fonts`, default the
  system catalog; an unlisted current family is kept). React and Svelte `EffectParameters` take a
  `fonts` prop.
- `effectFontFamilies(description, values)` lists the families a title effect uses, to pass to
  `ensureFontsLoaded` before rendering preview frames.

### Phase 7: verification

Unit tests: `packages/core/tests/typography.test.ts`, `typography-tools.test.ts` (every tool
through `ToolRegistry.callTool`, valid and invalid arguments), `typography-picker.test.ts` (model
and effect font controls); `packages/react/tests/typography.test.tsx`;
`packages/svelte/tests/typography.svelte.test.ts`. Font loading is tested with injected
`createFontFace` / `fontFaceSet` / `queryLocalFonts` fakes, so nothing touches the network.
The demo has a **Typography** tab that registers both tool providers.

## Deviations from the plan

1. **`lineHeight` is unitless only, `letterSpacing` is em only.** The plan allowed "multiplier or
   px" and "em or px"; mixing units in one field is ambiguous, so px leading must be divided by the size.
2. **Readability result shape.** `lineSpacing.passesWCAG1412` became `meetsRecommended` (with
   `assumed`), because WCAG 1.4.12 does not require authors to set 1.5 line spacing: it requires
   content to survive users setting it. The 1.5 target is WCAG 1.4.8 (AAA). The result also has
   `lineLength.source`, `wordCount` and `issues`.
3. **Large bold text is 18.67px**, not 18.5px: 14pt × 4/3. Values rounded to 18.66 still count.
4. **`segmentText` adds `sentence`**; `line` splits on breaks and wraps by `maxCharacters`
   (`Intl.Segmenter` has no line granularity and the module cannot see the renderer's measure).
5. **The system provider never calls `document.fonts.check()`**, which returns `true` for fonts
   that are not installed, and never calls `queryLocalFonts()` unless the host passes it (it asks
   the user for permission). Without it, the catalog lists commonly installed fonts, not detected ones.
6. **Extra tools**: `compute_fluid_type_size` (the plan had `computeFluidSize` but no tool, and every
   capability needs an agent path), `load_font`, and the three font picker tools (the picker is a
   user-facing control, so agents get it too).
7. **Accessibility suggestion** reuses a new shared `suggestAccessibleForeground` in `/color`
   instead of calling the `check_color_contrast` tool; it now measures candidates after rounding to hex.
8. **Changesets**: the docs-only changeset was replaced by minor changesets for `@pixerate/editor`,
   `@pixerate/editor-react` and `@pixerate/editor-svelte`.

## What is left

Phase 6 beyond effects is not done; each is an editor-specific change with its own document
model, tools and skill updates:

1. **Effect preview font preloading in `EffectAuthoringEditor`**: the helpers exist
   (`effectFontFamilies` + `ensureFontsLoaded`), but the editors don't take a `FontProvider` yet.
2. **Video titles**: accept `FontSpec` (tracking, leading) in `add_video_clip` / `update_video_clip`
   and add title-safe measure and legibility checks.
3. **Vector**: align `vector.listFonts` / `vector.setTextStyle` with `FontSpec` and `FontProvider`.
4. **Animation**: use `segmentText` for live-text `split` / `cascade` without outlines.
5. **Canvas and chart**: typography tokens in component property panels; minimum readable sizes
   for chart axis labels.
