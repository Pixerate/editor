---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add AI inpainting and background removal hooks and tool panel support:
- **Core Canvas 2D Engine**:
  - Add `renderMask(options)` and `toMaskDataURL(options)` to render binary black-and-white inpaint masks from active crop boxes and/or vector annotations (pen strokes dilated, rects/circles filled).
  - Add `applyInpaintedImage(newDataUrl)` and `applyBackgroundRemovedImage(newDataUrl)` on `ImageEditorController` with history tracking and auto-cleanup.
  - Define `InpaintOptions`, `RemoveBackgroundOptions`, `InpaintHook`, `RemoveBackgroundHook`, and `ImageEditorAIHooks`.
- **Svelte 5 Support**:
  - Add `onInpaint`, `onRemoveBackground`, and `aiHooks` props to `ImageEditor.svelte`.
  - Add AI Tools sidebar panel with background removal button/spinner, inpainting prompt textarea, target mask mode switcher (drawn shapes vs crop box), inpaint trigger button, and status/error indicators.
  - Expose mask rendering and AI application methods on `createReactiveImageEditor`.
- **React Support**:
  - Expose mask rendering and AI application methods on `useImageEditor` hook.
  - Add 1:1 matching AI Tools sidebar panel, props, and handlers to `ImageEditor.tsx`.
