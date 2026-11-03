---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Effects along a path.

- **Effects contract:**
  - `EffectSummary.accepts` and `EffectSearchOptions.accepts: ['path']` find effects with a control that draws along a path given at run time.
  - `pathControlsOf(description)` names those controls.
  - An optional `EffectProvider.pathFromText` writes words as single-stroke path data.
  - `checkEffectProvider` checks that path controls and `accepts` agree.
  - The fake provider gains `fake.trail` (an overlay) and `fake.route` (a vector effect), both drawn along a path, and writes words as paths.
- **Video editor:** `setEffectPath` gives an effect clip or clip effect its path from frame points, path data, a clip's mask outline or words. Points are mapped into the picture the effect renders, so a clip effect follows its moved clip. New agent tool `set_video_effect_path`; `search_effects` takes `accepts`, and `describe_effect` returns `pathControls`.
- **Animation editor:** `addVectorEffect` / `add_vector_effect` take `path: { node }` (the node's world outline; the picture lands on the node at scale 1) or `path: { text }`.
- **React and Svelte:** `VideoEffectsPanel` shows a Path row for path effects (Draw path on the preview, Use mask outline, Write words, Clear path), and `VideoPreview` takes the pointer while a path is drawn.
