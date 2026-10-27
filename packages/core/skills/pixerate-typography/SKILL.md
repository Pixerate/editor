---
name: pixerate-typography
description: How to choose and load fonts, build resilient font-family fallback stacks, generate modular type scales and heading hierarchies, compute fluid clamp() sizes, audit body text for line length and line spacing, check text contrast with the real font size and weight, split text into letters, words or lines for animation, and drive a font picker. Use when asked to pick or pair fonts, set up type tokens, check readability or legibility, or animate live text.
---

# Typography tools

The typography module is DOM-free: it works on numbers (px sizes, unitless line-heights, em
tracking) and family names, never on rendered pixels. Fonts come from a **font provider** the
host supplies (installed system fonts, a web font service, a design system's families); by
default it is a catalog of common system fonts, which says what is *usually* installed, not
what this machine has.

## Mental model

- A **font spec** is `{ family, weight, style, size (px), lineHeight (unitless), letterSpacing (em) }`.
- A **type scale** multiplies a base size by a ratio per step (`16 × 1.25² = 25`). A **hierarchy**
  names the steps: `caption` (−2), `body-sm`, `body` (0), `h4`, `h3`, `h2`, `h1`, `display` (5).
- A **fallback stack** is the `font-family` value: your family, then a tested cross-platform stack
  for its category, ending in a generic family, so text still renders when the font is missing.
- **Large text** under WCAG 2 is 24px, or 18.67px (14pt) at weight 700+. It needs 3:1 contrast
  for AA instead of 4.5:1. The accessibility tool decides this from the spec for you.

## Working method

1. **Find fonts.** `list_fonts` with `category`, `weight`, `style` or `query`. Only use families it
   returns (or that the user names), and always ship them inside a stack from `resolve_font_stack`.
2. **Load before rendering.** `load_font` before drawing or capturing text in a web font, so the
   first frame does not use the fallback. `loaded: false` means the fallback will show.
3. **Set up the scale.** `generate_type_hierarchy` for named tokens and ready CSS custom
   properties; `suggest_type_scale` for arbitrary steps. Smaller ratios (minor/major third) suit
   dense UI; larger ones (perfect fourth/fifth, golden) suit editorial and marketing pages.
4. **Make it fluid (optional).** `compute_fluid_type_size` for headings that grow between two
   viewport widths. Bounds are in rem so browser zoom and font-size settings still work.
5. **Audit the body text.** `audit_text_readability` with the real text, `fontSize`, `lineHeight`
   and the column `width`: fix `lineLength.status` (45–75 characters) and `lineSpacing`
   (at least 1.5) before polishing anything else.
6. **Check contrast with the type.** `check_typography_accessibility` with foreground, background,
   `fontSize` and `fontWeight`. Use `suggestion` when `passesAA` is false. For pure colour work
   (palettes, dual colours) use the `pixerate-color` tools.
7. **Animate live text.** `segment_text` splits into `grapheme`, `word` (with `wordsOnly`),
   `sentence` or `line` (with `maxCharacters` to wrap) and returns UTF-16 `start` / `end`
   offsets, so letters and words can be staggered without converting text to outlines.
8. **Drive the on-screen picker.** When a font picker is mounted, `get_font_selection` shows what
   is chosen, `list_picker_fonts` what it offers, and `set_font_selection` changes any fields in
   one step and returns the new selection.

## Best practices

- **Two families are usually enough**: one for text, optionally one for headings. Pair by contrast
  of category (serif headings with sans text, or the reverse), not by two similar sans-serifs.
- **Body text at 16px or more**, line-height 1.5–1.7, about 66 characters per line
  (`max-width: 66ch`). Headings get tighter leading (1.1–1.3) and slightly negative tracking; small
  captions slightly positive tracking. The scale tools already recommend these.
- **Use weight 400+ below 24px.** Thin weights lower effective contrast even when the ratio passes.
- **Avoid long runs of capitals** for body text; keep all-caps to short labels.
- **Prefer rem and clamp()** over fixed px for type on the web, so user settings apply.
- **Never assume a font is installed.** A system font in the catalog may be missing on Linux or
  Android; the fallback stack is what makes that safe.

## Tool reference

| Tool | When to use | Returns |
| --- | --- | --- |
| `list_fonts` | Discover families the host offers; filter by `category`, `source`, `weight`, `style`, `query`; `limit` default 50 | `{ fonts: [{ family, category, weights, styles, isVariable?, source }], total, truncated }` |
| `resolve_font_stack` | Turn a family (or stack) into a resilient `font-family` value for its category; also says if the provider lists it | `{ stack, families, category, available }` |
| `suggest_type_scale` | Sizes for arbitrary integer `steps` (-12…12) from `baseSize` (px, default 16) and `ratio` (name or number, default major-third) | `{ ratio, baseSize, steps: [{ name, step, size, lineHeight, letterSpacing }] }` |
| `generate_type_hierarchy` | Named tokens caption…display on one scale, with CSS custom properties (`prefix`, `selector`) | `{ ratio, ratioName?, baseSize, steps: { body, h1, … }, css }` |
| `compute_fluid_type_size` | A size that grows from `minSize` at `minViewport` to `maxSize` at `maxViewport` (all px) | `{ clampCss, slope, intercept, samples }` |
| `audit_text_readability` | Check body text: line length (own lines, or `width` + `fontSize`), line spacing, capitals, tiny or tight type, reading time | `{ lineLength, lineSpacing, allCaps, wordCount, estimatedReadingTimeSeconds, issues }` |
| `check_typography_accessibility` | Contrast for text of a given `fontSize` (px) and `fontWeight`, deciding large text itself; suggests a passing foreground | `{ ratio, large, level, passesAA, passesAAA, required, suggestion?, largeTextMinSize, issues }` |
| `segment_text` | Split text into graphemes, words, sentences or lines with offsets, for staggered animation | `{ segments: [{ text, start, end, index, isWordLike? }], count }` |
| `load_font` | Load a family's face (`weight`, `style`) before rendering or capturing; only listed when the provider can load | `{ family, weight, style, loaded }` |
| `get_font_selection` | Read the mounted font picker's value, CSS and the chosen family's weights and styles | `{ value, css, availableWeights, availableStyles }` |
| `list_picker_fonts` | Families the mounted picker offers (by `category`, `query`), plus recent families | `{ fonts, recent, total, truncated }` |
| `set_font_selection` | Change the picker's family, weight, style, size, lineHeight or letterSpacing in one validated step; weights snap to what the family has | `{ value, css, availableWeights, availableStyles }` |

## Pitfalls

- **Sizes are CSS px.** 12pt is 16px; 18pt is 24px. Convert before calling the tools.
- **lineHeight is a multiplier**, not px: 24px leading on 16px text is `1.5`. When it is omitted
  the audit assumes the browser's `normal` (about 1.2) and says so with `assumed: true`.
- **`line` segmentation does not know the renderer's wrapping.** Without `maxCharacters` it only
  splits on line breaks; with it, it wraps by character count, which approximates proportional
  fonts.
- **A one-line string is not a measure.** `too-short` on a single heading is expected; pass the
  column `width` and `fontSize` to estimate how paragraphs will wrap.
- **The system catalog is not detection.** Without the host opting into Local Font Access,
  `list_fonts` lists commonly installed fonts. Always use `resolve_font_stack` output.
- **Picker fonts may differ from `list_fonts`.** `set_font_selection` only accepts families the
  picker lists; check with `list_picker_fonts`.
