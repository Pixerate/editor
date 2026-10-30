---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Mask views, as in Photoshop. Alt-click a layer's mask thumbnail to show the mask alone in grey, and Alt+Shift-click it (or press the backslash key) to show what it hides as a red overlay over the image; do the same again to go back. `setMaskView` / `getMaskView` on the controller (view state: no undo step, not saved), `handleMaskViewKey` for hosts, and the agent tool `set_mask_view`. `capture_view` draws the mask view when `includeOverlays` is true, so an agent can check a mask. The React and Svelte `LayersPanel` mark the shown mask in its thumbnail's label.
