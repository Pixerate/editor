---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Agent playback for the spreadsheet, video, animation and parameters editors.

- **Spreadsheet:**
  - `createSpreadsheetToolProvider` plans its writes (`planSpreadsheetToolPlayback`). `set_cell` is clicked and typed, `set_range` dragged across its block, and row or column edits mark their rows or columns.
  - It plays on the `spreadsheet` surface (option `playbackSurface`). `parseSpreadsheetPlaybackRef` reads cell, row and column refs.
- **Video:**
  - Both video tool providers plan every write (`withVideoPlayback`, `planVideoToolPlayback`). The cursor drags clips to new times or tracks, pulls trims, clicks tracks where clips go in, and clicks the ruler for splits, seeks and markers.
  - Times are `videoTimeRef` / `parseVideoTimeRef` refs.
- **Animation:**
  - Both animation tool providers (`withAnimationPlayback`, `planAnimationToolPlayback`) play on the `animation` surface.
  - The cursor clicks the shot a call names and visits the stage elements its commands target.
- **Parameters:**
  - `parameters.set` visits each control it changes and types the value (`planParameterSetPlayback`, `withParameterPlayback`).
  - Every parameter command plays on the `parameters` surface.
- **Robustness:** a surface rectangle or plan point with a non-finite number is treated as not found, so a bad lookup can no longer hang a tool call.
- **React and Svelte:**
  - `SpreadsheetEditor`, `VideoTimeline` / `VideoEditor`, `AnimationEditor` and `ParametersPanel` take `playback` (default: the playback context), `playbackId`, and a reveal callback (`onPlaybackReveal` / `onplaybackreveal`).
  - New `useElementPlaybackSurface` (React) and `createElementPlaybackSurface` (Svelte) for plain DOM components.
  - The Svelte timeline's lanes also carry `data-track-lane`, as in React.
