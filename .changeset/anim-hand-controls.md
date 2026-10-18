---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

The animation editor can now be used by hand, not just played.

- **`<AnimationEditor>`** (React and Svelte) brings together the stage, a playhead scrubber and panels for editing commands, shots and scene settings, with undo and redo (⌘Z / ⇧⌘Z). Pass `editable={false}` to get a player with no editing.
- **`<PlayheadScrubber>`**: a time ruler with shot bands, beat-grid and narration marks, drag or arrow keys to scrub, play / pause, and a loop mode.
- **`<CommandList>`**: a shot's commands in order. Add, reorder, duplicate and delete commands, and change `with` and `delay` inline.
- **`<CommandInspector>`**: a form generated from `MOTION_COMMAND_SCHEMA`, the schema the agent tools take. Enums appear as selects, numbers show their units and limits, and nodes and targets have pickers. It shows the Flair primitive each command plays.
- **`<EasePicker>`**: easing presets, including the springs, with a curve preview sampled from `evaluateEasing`. A spring is drawn over the time it takes to settle.
- **Stage picking**: click an element in `<AnimationStage>` (`onPick` / `onpick`) to pick it, or shift-click to add it to or remove it from the selected command's targets. Picked elements and targets are outlined (`highlight`).
- **`<ShotInspector>`**: a shot's label, hold, speed and camera framing, a cue picker for `at` (a beat or a narration word), and buttons to add, move and delete shots.
- **`<SceneSettings>`**: loop, frame rate, stepped time, target length with a Fit button (`fitMotionScene`), a beat grid, and narration words.
- Every change is one `controller.apply` edit, so it is one undo step. When an edit is refused, the reason is shown.
- **Core:** the components share helpers: `motionCommandFields`, `parseMotionFieldInput`, `motionFieldEdit`, `defaultMotionCommand`, `motionCommandRows`, `duplicateMotionCommandEdit`, `motionEasingCurve` / `motionEasingPath`, `motionNodeAtElement`, `highlightMotionSvg`, `motionRulerTicks`, `fitMotionSceneEdits`, `motionCueChoices`, `parseMotionNarration` and `formatMotionNarration`.
- **New edit and agent tool:** `move_command` reorders a command within its shot as one undo step.
- **Flair import:** preset colours written as `[r, g, b]` channel arrays, as Flair's catalog writes them, are now read as hex.
