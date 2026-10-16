---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Variable-width (tapered / profiled) strokes for the vector editor: `strokeWidthProfile` with left / right side scales and monotone interpolation, presets (taper start / end / both, bulge, pinch, teardrop, wave, pressure) and parametric taper / wave generators; exact outlines refitted to Bézier curves (caps, joins, dashes, live corners, arrowheads and alignment) used for rendering, hit-testing, SVG export (round-trips the profile) and Outline Stroke; a Width tool (W) with draggable width points; pencil strokes record pen pressure; a `vector.setWidthProfile` agent command; and a profile picker with reset in both style panels. The polygon boolean engine classifies edges with a band index, making large overlays much faster.
