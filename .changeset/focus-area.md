---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Select › Focus Area for the image editor: selects the parts of the image that are in focus. It measures the local energy of the Laplacian above the image's measured noise floor, splits it into in and out of focus (Otsu, moved by In-Focus Range), closes small gaps, and fits the edge to the image with the colour guided filter. The selection options bar in React and Svelte has a Focus Area section with In-focus range, Image noise level and Soften edge. Agents use `select_focus_area` (`range`, `noise`, `softness`, `mode`), which also returns the noise level it measured. New exports: `focusArea`, `workPlanes`, `workLuma`, `softMaskToSelection`, `controller.selectFocusArea` and `FocusAreaCommandOptions`. Reduced copies of an image are now cached per size.
