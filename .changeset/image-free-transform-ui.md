---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Free Transform UI in React and Svelte: `<ImageEditor>` opens a Free Transform with Ctrl/Cmd+T or the Free Transform / Transform Selection buttons, draws the frame, eight handles and a movable reference point on the canvas, and shows `<FreeTransformOptionsBar>` (mode switch: Free, Rotate, Skew, Distort, Perspective; reference-point locator; X / Y, W / H % with a proportional chain, angle, H / V skew; interpolation; Commit / Cancel). Drags follow Photoshop: corners scale proportionally (Shift frees them, Alt scales from the reference point), sides scale one axis, Ctrl/Cmd distorts a corner or skews a side, Ctrl/Cmd+Alt+Shift makes perspective, outside rotates (Shift in 15° steps), inside moves; Enter commits, Esc cancels, arrows nudge. The shared model is `FreeTransformTool` in `@pixerate/editor/image-editor`, and the renderer draws it through the new `freeTransform` render option. `<LayersPanel>` gains a mask link (chain) button and a Link / Unlink Layer Mask menu item.
