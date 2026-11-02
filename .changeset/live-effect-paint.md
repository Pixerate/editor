---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Paint editor: effect paint can be laid along each stroke, and can play live.

- **Along the stroke:** `setEffectPaint({ map: { by: 'stroke', length, repeat } })` renders the effect as a strip and paints each pixel with the colour at its distance along the stroke and place across the tip (repeat, mirror or clamp), for dab, particle, bristle and mixer brushes. Replays stay exact, and scaled replays scale the length.
- **Live:** with `live: true`, strokes on a stroke layer keep playing the effect in the view. The document is unchanged. Only the live strokes' areas are redrawn each frame, at most `fps` a second, with one render in flight and at most 8 live effects per painting.
- **API:** `setEffectPlayback`, `getAnimation`, `showEffectTime`, `playEffects`, `renderAnimationFrame` and `withEffectTime`.
- **Agent tools:** `set_effect_paint` takes `map` and `live`, the new `set_effect_playback` plays or pauses live paint, and `export_image` / `export_psd` take `time`.
- **React and Svelte:** the effects panel gets "Along the stroke" (length, repeat) and "Live" options and a play/pause row with a frame rate. The canvas plays live paint while it is mounted.
