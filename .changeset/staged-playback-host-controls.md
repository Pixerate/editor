---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Agent playback: staged changes. A plan can put `stage` steps after its `commit`: the handler then starts at `commit` while the cursor keeps playing, and each `stage` step lets one `await context.stage?.()` in the handler through (`ToolCallContext.stage`, absent without playback). A tool that adds several things (swatches, a row of nodes) adds them one by one as the cursor reaches each.

Image editor: the Free Transform overlay (and transform mode's layer frame) is drawn like the crop box, with a white frame, the crop's white handles edged in blue and a small reference point instead of the large crosshair.

Image editor panels take the host's own form controls. `setImageEditorControls({ Checkbox, Range, Select })` (Svelte) and `<ImageEditorControlsProvider controls={...}>` (React) make the panels' checkboxes, range sliders and dropdowns (`ControlSlider`, canvas size, layer effects, brush, shape, selection and adjustment layer panels) render the host's components; any not given stay plain inputs. The wrappers `ImageCheckbox`, `ImageRange` and `ImageSelect` are exported.

Svelte `LayerPanel`: the panels follow the controller (the active layer's name, opacity and kind update after each change, not only when the panel mounts), and the Properties opacity slider works in the control's 0–1 range (it set opacity to 1% or less before).
