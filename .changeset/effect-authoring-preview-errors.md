---
"@pixerate/editor": minor
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
---

Effect authoring previews no longer go stale or blank for some effects (#359).

- `createEffectAuthoringSession` starts the playhead at half the effect's length, as catalog thumbnails do, so entrance-style effects and transitions open on a frame that shows them. Pass the new `startTime` option to start elsewhere.
- When `createPreview` cannot make a pixel renderer (for example a vector effect the provider only draws as SVG), the session records why in the new `EffectAuthoringState.previewError`. `effect_authoring_describe` returns it with the playhead `time`, and `effect_authoring_view` refuses with that reason instead of capturing a blank frame.
- `EffectAuthoringEditor` (React and Svelte) clears the canvas when the session changes, catches preview and frame failures instead of leaving an unhandled rejection, and shows the reason over the preview while parameters, keyframes and the timeline stay usable.
