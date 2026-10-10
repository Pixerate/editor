---
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
---

Fix the image editor reverting AI edits, and `useHistory` losing history:

- **React `useImageEditor` / `<ImageEditor src>` and Svelte `<ImageEditor src>`:** applying an inpainting or background-removal result no longer immediately reloads the original `src`. Previously the image was reloaded whenever the editor's source differed from `src`, which was always true after an AI edit. The image now reloads only when `src` itself changes.
- **Svelte `createReactiveImageEditor`:** new `destroy()` method that stops syncing controller state. `<ImageEditor>` now calls it for its internal editor on unmount; previously that subscription leaked.
- **React `useHistory`:** passing options inline (`useHistory({ maxDepth: 10 })`) no longer creates a new `HistoryManager`, and wipes the history, on every render. Options are read on the first render.
