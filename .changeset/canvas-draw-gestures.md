---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add hand-drawn annotation gestures to `createDrawCommands`: `canvas.circle`, `canvas.underline`, `canvas.arrow`, `canvas.bracket`, `canvas.strike`, `canvas.cross` and `canvas.check`. Each takes boxes, points or `{ nodeId }` targets, generates a seeded hand-drawn path (`circleGesture`, `arrowGesture`, … in `@pixerate/editor/canvas`) and draws it through `drawStroke` as one stroke node and one undo step, with a playback plan that traces it. The draw controller gains `nodeBounds(id)` (exposed by `useCanvasDraw` and `createCanvasDraw`) so gestures can resolve node ids. `createCommandToolProvider` gains `tools` / `toolName` options that list chosen commands as tools of their own, with their params as the input schema.
