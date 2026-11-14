---
"@pixerate/editor": minor
"@pixerate/swift": minor
---

Geometry and typography for data visuals (closes #811, closes #813).

- **Connectors** (`/tools`): `elbow(from, to, { level, radius, axis })` draws one rounded orthogonal connector with a chosen turn level; `fanElbows(root, targets, { gap, step, radius, lead, axis })` draws nested elbows from one root to a row of targets that never cross (the outermost turns nearest the root, step and radius shrink to fit); `roundedPolyline` rounds right-angle corners of any polyline. Each returns its pieces, `M`/`L`/`A` path data that pathops reads, and an exact length.
- **Helices** (`/tools`): `helix([from, to], { amplitude, turns, phase, envelope })` winds a strand around an axis with its depth (envelopes `pinch`, `start`, `end` or a function); `splitByDepth(points, depth)` cuts it into front and back runs exactly where it crosses the axis plane, each with its range along the strand, for over/under braids and ropes.
- **Fitting text** (`/typography`): `fitText(words, width, { measure, min, max, step, tracking })` finds the largest whole- or half-pixel size at which every word fits a column, tightening tracking at `min` down to a floor when asked, and names the word that set the limit; `staggerRows` says when a row needs two staggered rows; `estimatedMeasure(category)` estimates widths without a renderer. The caller measures text, so the steps are pure. New agent tool `fit_text_to_width` in the typography tools.
- Swift: `elbow`, `fanElbows`, `roundedPolyline`, `helix`, `splitByDepth`, `fitText`, `staggerRows` and a CoreText `coreTextMeasure` in PixerateGeometry, checked against fixtures recorded from the TypeScript.
