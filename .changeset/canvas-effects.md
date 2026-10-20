---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Canvas provider effects: with an optional `EffectProvider`, shape nodes take an effect fill (clipped to the shape) or an overlay, with live play / hold, opacity and one undo step per change, and canvas scenes take a provider transition played over captured views when stepping into them. Adds `createCanvasEffectsController`, `createCanvasEffectsToolProvider` (`set_canvas_effect_mode`, `list_scene_transitions`, `set_scene_transition` plus the shared effect tools), `runCanvasNodeEffect` and `transitionCanvasView` in core; `useCanvasEffects`, `<CanvasEffectsProvider>`, `<CanvasEffectsPanel>` and a `transitions` option on `useCanvasScenes` in React; `createCanvasEffects`, `setCanvasEffectsProvider`, `<CanvasEffectsPanel>` and a `transitions` option on `createCanvasScenes` in Svelte.
