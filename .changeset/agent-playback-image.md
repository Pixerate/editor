---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Agent playback for the image editor: every image tool call can be acted out by the agent's cursor.

- Core:
  - `createImageEditorToolProvider` and `createImageEffectsToolProvider` plan each write with `planImageToolPlayback` and play on the `image` surface.
  - Before each write the cursor opens the tool's panel. Then it traces `points`, drags out boxes, clicks positions, visits the sliders `set_adjustments` moves, or visits the layers a call names.
  - New `withImagePlayback`, `createImagePlaybackLocator` and `imagePlaybackPanel`.
  - A generic `open` playback step and `PlaybackSurface.open` let a plan open part of the editor.
  - Results that return `layerId` or `layer.id` are ringed after the call.
- React and Svelte:
  - `ImageEditor` takes `playback` (default: the playback context), `playbackId` (default `image`) and a reveal callback (`onPlaybackReveal` / `onplaybackreveal`).
  - It draws the cursor over the canvas and its panels, and its tabs carry `data-image-tab`.
