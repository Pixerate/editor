---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Canvas and vector get the paint editor's "Keep my colour" lock, and a canvas colour taken from a brush's light / dark default follows the colour scheme (#589).

- Canvas draw controller: `setColorLocked` / `colorLocked` (and a `colorLocked` option), which `selectBrush` respects; a colour taken from a light / dark default resolves again on `setColorScheme` until another colour is set; `colorScheme` and `brushSettings()`. Agents get `canvas.selectBrush`, `canvas.setColorLocked` and `canvas.setColorScheme` from `createDrawCommands`.
- Vector controller: `setColorLocked`, a `colorLocked` option, and `colorScheme` / `colorLocked` in the state; `addBrushstroke` and `setBrushstroke` keep the colour while locked. Strokes already made never change. Agents get `vector.setColorLocked` and `vector.setColorScheme`, and `vector.listBrushes` reports both.
- React `useCanvasDraw`: `colorLocked`, `setColorLocked`, `brushSettings` and an `initialColorLocked` option. Svelte `createCanvasDraw`: `colorLocked`, `setColorLocked`, `colorScheme` and `brushSettings`.
- `<VectorAppearancePanel>` (React and Svelte) has a "Keep my colour" toggle under brushstrokes.
