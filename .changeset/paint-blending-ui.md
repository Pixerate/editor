---
"@pixerate/editor": patch
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Paint editor blending UI, in parity for React and Svelte. `BrushPanel` gains an engine section from the shared `brushEngineControls`: blender strength and blend distance, smudge strength and length, pick-up and mix ratios, Mixer Brush load, Pigment / RGB mixing, a dirty-brush toggle, multi-colour mode, colours, order, softness and dabs per colour, and a swatch of what the brush carries with Load / Clean. It also has a brush blend menu grouped into Standard and Paint modes. The `ColorPanel` mixing pad gains a pick sample size, a Mix button for the paint and second colours in parts, and Keep pad with a list of kept pads. Core adds the shared helpers `brushEngineControls`, `multiColorSliders`, `patchBrushValue`, `brushLoadColor`, `PAD_SAMPLE_SIZES` and `padSampleRadius`, and the palette knife becomes a pigment smudge that drags streaks of both paints.
