---
"@pixerate/editor": minor
---

The animation editor plays Flair's clip-path reveals, and exports them and follows to Flair exactly:

- **New styles:** `enter` gains `wipe` (an edge travelling `direction`, default right), `iris` (from the centre; `shape`: `circle` or `box`) and `split` (from a line through the middle; `orientation`: `horizontal` or `vertical`). `exit` gains `wipe`. They match Flair's `entrance.wipe`, `entrance.iris`, `entrance.split` and `exit.wipe`, padding the clip for the stroke. A node with no width or height fades instead, and `checkMotionScene` warns `reveal-no-box`.
- **Frames:** reveals are clips in the node's box units, `MotionFrame.clips` (the vector model has no clips). `motionFrameToSvg` and `<AnimationStage>` wrap each clipped node in a group with an `objectBoundingBox` clip path, through `vectorDocumentToSvg`'s new `wrap` option.
- **Flair export:** a reveal is a wrapper group plus a clip rect or circle whose attributes animate. A follow is Flair's `along` (with `orient` when it turns) on a wrapper, along a copy of the path in the node's parent's units, instead of sampled transform steps.
- **Follows** are measured in the node's parent's units (a follow inside a rotated or scaled group now turns the right way), and with `rotate`, moves made during the follow turn with the path. `motionNodeOffset` takes a `follow` flag and returns the follow apart.
