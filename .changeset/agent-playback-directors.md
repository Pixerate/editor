---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Agent playback for the chart and paint editors, sharing one cursor with their directors, and `runToolScript` in core.

- **Chart:**
  - `createChartToolProvider` plans its calls (`withChartPlayback`, `planChartToolPlayback`). Inspector options, the data grid and the toolbar are clicked.
  - With a director, `set_chart_values` and `select_chart_element` play through it (`playback: 'self'`).
  - `chartPointRef` and `locateChartPoint` find points.
- **Paint:**
  - Both paint tool providers plan their writes (`withPaintPlayback`, `planPaintToolPlayback`, `paintPlaybackPanel`). Each write opens its side panel and points at the control.
  - With a director, strokes, fills and replays play through it.
- **React and Svelte:**
  - `ChartEditor` and `PaintEditor` take `playback`, `playbackId` and a reveal callback.
  - Given the director's presence, they share it with playback (one cursor) and draw it over their panels.
  - `usePlaybackSurface` / `createPlaybackSurface` accept a shared presence store.
  - Paint panels carry `data-paint-tab` and `data-paint-panel`.
- **Rich text:** `insert_chart` shows the agent's caret where the chart goes in.
- **Scripts:** `runToolScript` (with `toolResultValue` and `toolResultError`) plays scripted agent turns (notes and tool calls) through any `ToolSource`. With `playback`, notes show on the cursor.
