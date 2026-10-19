---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add a Mixer Brush. `@pixerate/editor/paint` gains `MixerStroke`: a reservoir loaded with paint plus a pickup well that takes up the canvas colour under each dab, with `wet`, `load`, `mix`, `loadEachStroke`, `cleanEachStroke` and `mixing: 'rgb' | 'pigment'` (Kubelka-Munk, so blue dragged through yellow goes green). The image editor adds the `mixer` paint tool (Shift+B) to `beginStroke` / `paintStroke` and `PaintGesture`, with `setPaintOptions({ mixer })`, `loadMixerBrush`, `cleanMixerBrush` and `emptyMixerBrush`; strokes respect the selection and locks and are one undo step. Agents get `tool: "mixer"` and `mixer` settings on `paint_stroke`, plus `get_mixer_brush`, `load_mixer_brush` and `clean_mixer_brush`. React and Svelte `<BrushOptionsBar>` show the Mixer tool with Wet / Load / Mix sliders, Load / Clean buttons, load and clean each stroke toggles and an RGB / Pigment toggle.
