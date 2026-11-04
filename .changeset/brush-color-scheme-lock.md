---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Canvas and vector brush default colours now follow `setColorScheme` and support a standing `colorLocked` (`setColorLocked`) setting in core, React (`useCanvasDraw`) and Svelte (`createCanvasDraw`), with a Keep colour toggle on vector brushstroke rows (#589). Agents get `canvas.setColorLocked` (when the draw target has `setColorLocked`), `vector.setColorLocked` and a `keepColour` param on `canvas.drawFreehand`. A kept colour is the current stroke colour; a stroke with the other tool (a highlighter stroke while the pen is out) keeps that tool's default.
