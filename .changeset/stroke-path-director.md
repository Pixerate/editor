---
"@pixerate/editor": minor
"@pixerate/swift": minor
---

Play `stroke_path` through `PaintDirector` when a director is passed (`{ kind: 'strokes' }`), pacing each subpath with the agent cursor and committing all subpaths as one undo step, `PaintEditorController.group` now accepts an async function (the step stays open, refusing other changes, until it settles; changes after an `await` go through its `within` argument), and add `speed` (`0.01..100` px/ms) to `samplePath` and `stroke_path` (#587).
