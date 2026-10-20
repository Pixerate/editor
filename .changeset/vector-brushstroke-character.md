---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Vector brushstrokes can now have their brush's character: seeded size, angle, opacity and scatter jitter, and a procedural paper grain.

- `VectorBrushstroke` gains an optional `seed` (an integer) and `paper` (`{ pattern, seed, scale, depth }`, or `null` for no grain). Only a layer with a seed renders with character, through `renderBrushstroke`'s `character` option with the grain in the path's own space. Layers without a seed render exactly as before, so existing documents keep their look.
- `sanitizeVectorBrushstroke` keeps the new fields, and they round-trip through SVG. New exports: `sanitizeVectorBrushstrokePaper`, `vectorBrushstrokeCharacterError`, `randomVectorBrushstrokeSeed` and `VECTOR_BRUSHSTROKE_MAX_SEED`.
- `addBrushstroke` and `setBrushstroke` take `seed` and `paper`. In a `setBrushstroke` patch, `seed: null` removes the seed and `paper: {}` restores the default paper. `getVectorAppearancePanel` reports each brushstroke's `seed` and `grain`.
- React and Svelte: brushstrokes added from `VectorAppearancePanel` get a random seed, and each brushstroke row has a grain toggle.
- Agents: `vector.addBrushstroke` and `vector.setBrushstroke` take described `seed` and `paper` arguments.
