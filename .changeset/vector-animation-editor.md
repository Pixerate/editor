---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add a UI-agnostic animation editor for vector artwork (`@pixerate/editor/animation-editor`), modelled on Lingo's scenes. A `MotionScene` is the vector editor's artwork plus shots of commands (enter, exit, draw, move, rotate, scale, fade, style, morph, follow a path, pulse, shake, live path-effect tweens) and camera moves, with timing taken from the content. `motionFrameAt` / `motionFrameToSvg` draw any frame, `checkMotionScene` reports coded issues with "did you mean" suggestions, `AnimationEditorController` edits all-or-nothing with undo and plays on an injectable clock, and `createAnimationEditorToolProvider` gives agents 22 tools. `toFlairSvgMotion`, `toFlairVectorEffect` and `toFlairEffectDocument` export to Flair's vector motion, catalog effects (with colour controls and presets) and effect editor. React adds `useAnimationEditor`, `useAnimationEditorTools`, `<AnimationEditor>`, `<AnimationStage>` and `<ShotTimeline>` (`@pixerate/editor-react/animation-editor`); Svelte adds `createAnimationEditor`, `useAnimationEditorTools` and the same components (`@pixerate/editor-svelte/animation-editor`).
