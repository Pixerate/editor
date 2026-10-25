---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add general-purpose effect authoring support across core, React, and Svelte:
- Contract types `supportsAuthoring` and `openAuthoring` in `@pixerate/editor/effects`.
- `createEffectAuthoringSession` with observable state, parameter controls, keyframe tracks and easing, playback loop and clock, undo/redo history, presets, and source code compilation with diagnostic issues.
- 15 MCP-annotated agent tools and the `pixerate-effect-authoring` skill.
- React bindings: `useEffectAuthoring` hook and `<EffectAuthoringEditor />`.
- Svelte bindings: `effectAuthoringOf` store and `<EffectAuthoringEditor />`.
