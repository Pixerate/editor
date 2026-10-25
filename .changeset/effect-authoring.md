---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add general-purpose effect authoring support across core, React, and Svelte:
- Contract types `supportsAuthoring` and `openAuthoring` in `@pixerate/editor/effects`.
- `createEffectAuthoringSession`, a generic session over any provider: observable state, control values, keyframe tracks with easing, playback, undo/redo, presets, and saved documents that are validated when reopened. Source editing (`setSource`, compile issues) is part of the session contract for providers that support it; the generic session has none.
- `effectSampleInputs` for previews of filters and transitions.
- 15 MCP-annotated agent tools and the `pixerate-effect-authoring` skill.
- React bindings: `useEffectAuthoring` hook and `<EffectAuthoringEditor />`.
- Svelte bindings: `effectAuthoringOf` store and `<EffectAuthoringEditor />`.
