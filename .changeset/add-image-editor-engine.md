---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add UI-agnostic Canvas 2D image editor engine with cross-framework parity across Vanilla JS, React, and Svelte 5:
- **Core Canvas 2D Engine**: persistent interactive crop overlay with 8 resize handles, aspect ratio locking, geometric hit-testing, transformations (rotate, flip), color adjustments (brightness, contrast, saturation, exposure, temperature, blur, opacity), drawing and annotation vector layers with live draft camera projection (pen, rect, circle, arrow, line, text), zoom/pan viewport, live compare mode, and JSON state serialization.
- **Gleamforge Depth Alpha Masking**: threshold and brightness depth alpha blending with softness, invert, and `removeAlpha`.
- **React Support**: `useImageEditor` hook and `<ImageEditor />` component with interactive crop box dragging, handle resizing, live annotation preview, top toolbars, and side control panels.
- **Svelte 5 Support**: `createReactiveImageEditor` rune helper and `<ImageEditor />` component with 1:1 functional parity.
