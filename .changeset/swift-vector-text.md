---
"@pixerate/swift": minor
---

**Swift vector editor: text (#624).**

- The shared text engine (`TextLayout.swift`, from `src/text`): `layoutText` with styled runs, paragraphs, line breaking (spaces, break characters, between CJK characters), alignment and justification, tracking, leading, indents, spacing, baseline shift and vertical writing (CJK upright, Latin sideways or upright), carets, hit testing, selection quads, decorations and fragment outlines.
- A `VectorTextShaper` protocol (`resolve`, `metrics`, `measure` over UTF-16 code units, optional `outline`, `vertical` and `families`) with `MetricTextShaper` (`createMetricTextShaper`: per-class advances, 0.8 / 0.2 em ascent and descent, bold 5 % wider) as the default; `setVectorTextShaper` swaps it, and the conformance host forces the metric shaper.
- Text nodes (`VectorText.swift`, from `vector/text.ts`): runs and styles, path measuring, point, area and path text layout with vertical orientation (`layoutVectorText`), glyph boxes or outlines (`vectorTextPaths`), carets, spans, validation (`patchVectorCharacterStyle`, `patchVectorParagraphStyle`, `sanitizeVectorTextFrame`, `sanitizeVectorTextFields`) and the pure edits, including `bakeVectorTextGeometry`.
- Text now bounds, transforms (scale bakes into font sizes), blends (as its glyphs), draws in render data (SVG text spans, or outlines with an outline shaper), exports to SVG (`<g data-vector-text>`, or outlines with effects) and imports (our own text, live text with effects, and foreign `<text>` as point text); frames lay out point, area and path text children, and master pages fill `{page}` / `{pages}` in text.
- The controller has `addText`, `createTextNode`, `setText`, `setTextStyle`, `styleTexts`, `setParagraphStyle`, `setTextFrame`, `setTextOrientation`, `typeOnPath`, `createOutlines`, `getTextLayout`, `setTextShaper`, `setTextDefaults` and the text panel's data (`textPanel`). The 10 text commands run, and the `text` scenario passes (13 of 15 vector scenarios).
