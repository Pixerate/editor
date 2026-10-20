---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Provider effects in the animation and vector editors.

- **Animation editor.** `applyMotionEffect` animates nodes with a provider motion effect. Its changes become ordinary commands tagged with `source`, so they preview, export to Flair and import like any command. `addVectorEffect` adds a vector effect's own picture as an artwork group with its shots. `updateMotionEffect` makes an effect again in place, and `removeMotionEffect` takes it out.
- **Vector editor.** `addVectorEffect`, `updateVectorEffect` and `detachVectorEffect` work with groups tagged `providerEffect`.
- **Agent tools.** New providers are `createAnimationEffectsToolProvider` (which adds `add_vector_effect`) and `createVectorEffectsToolProvider`.
- **UI.** React and Svelte add `<AnimationEffectsPanel>`, `<VectorProviderEffectsPanel>`, an `effects` prop on `<AnimationEditor>` and `<VectorEditor>`, `useAnimationEffectsTools` and `useVectorEffectsTools`. `<EffectsBrowser>` gains a `kinds` filter.
- **Fake provider.** It gains `fake.badge`, a vector effect with its own picture.
