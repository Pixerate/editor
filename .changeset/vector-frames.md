---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Vector frames and artboards with resizing constraints.

- A group with `frame` set draws a background and clips its children, and selects and snaps by its rectangle. Top-level frames are artboards, and their names show on the canvas.
- New ways to make and edit frames: the Frame tool (F), `addFrame`, `frameSelection` and `setFrame`.
- When a frame is resized, its children follow their `resizing` constraints: left, right, left & right, centre or scale, and the vertical equivalents.
- `frameToSvg` exports a single artboard. SVG export and import round-trip frames.
- New agent commands: `vector.listFrames`, `vector.addFrame`, `vector.frameSelection`, `vector.setFrame`, `vector.setResizing` and `vector.exportFrameSvg`.
- New `VectorFramePanel` components for React and Svelte.
