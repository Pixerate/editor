---
"@pixerate/editor": minor
---

Add `@pixerate/editor/parameters`, a headless schema-driven parameters editor for effects, shaders, generators and component props. `ParameterSchema` covers number / int (slider or input, unit, step), boolean, choice, color (hex, optional alpha), vector (2–4), image and text fields with labels, descriptions, defaults, collapsible groups and `showIf` conditions. `ParametersController` validates values with sentence errors, keeps a stable `getState()` for `useSyncExternalStore`, records undo steps in a `HistoryManager` (slider drags merge into one via `beginGesture` / `endGesture`), and supports reset, seeded randomize, presets (apply / save / delete), `setSchema`, `toJSON` / `load` and optional keyframe hooks shaped like the canvas `AnimationTrack`. `createParameterCommands` exposes it to the command palette and agents, and `parameterSchemaFromShaderControls` adapts shader `@control` definitions.
