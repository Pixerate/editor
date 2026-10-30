---
"@pixerate/editor": minor
---

Agent playback traces selections the way a person would. A lasso (`select_region` with a polygon, and any traced stroke) now presses with a `path` gesture, and in select mode the canvas draws the path traced so far, not a rectangle from the press. `select_subject` traces each outline the model found before the selection lands. That uses the new `ToolCallContext.perform(steps)`, which lets a handler act out cursor steps it only learns mid-call.

- `PresenceActor.gesture` and `{ type: 'press', gesture: 'path' }` steps
- `trackPresenceDrag` reports a `PresenceDrag` (the box plus `path` and `gesture`)
- `planOutlineTrace(outlines)`
- `selectSubject`'s `beforeApply(outlines)` option
- `segmentationOutlines(result)`
