---
"@pixerate/editor": minor
---

One picture from layered canvases and SVG: composite capture (closes #809).

- `compositeCapture(root, { scale, maxSide, background, format, quality, exclude, includeOverlays, output })` (`/tools`): an image of what a person sees in `root` — canvases (WebGL included), SVG and HTML labels in their order and with their opacity — as a data URL or a Blob, with its pixel size and the scale used. Agent cursors and other overlays are left out unless asked. `findPicture(document)` finds the page contract's `data-picture` container.
- `registerCaptureSource(canvas, ({ scale }) => …)`: a canvas draws itself for captures, so a 2× capture is drawn at 2× rather than stretched, and returns `{ lost: true }` when it can't. A lost WebGL context, from a source or detected on a canvas without one, rejects with `CaptureContextLostError`, which says what to do, instead of giving a blank picture. `capture_view` on an element surface and `rasterizeElement` (`sourceScale`) draw sources at the capture's scale too.
- `renderChart3d` (`/three`) registers its canvas as a capture source, and gains `captureAt(scale)` (draw again at a scale and restore) and `contextLost`. A 3-D chart's labels are HTML over the canvas, so `compositeCapture` exports the chart with its text.
- Demo: Export PNG (2×) on the Charts tab's 3-D view.
