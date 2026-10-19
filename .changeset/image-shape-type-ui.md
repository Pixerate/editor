---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Shape and type tools in the React and Svelte image editors. `<ImageEditor>` gains a Shape tool (drag to draw live rectangles, ellipses, polygons, stars and lines; Shift for squares, circles and 45° lines, Alt from the centre) and a Type tool (click for point text, drag for a paragraph box, click existing text to edit it on the canvas with a caret, selection, arrow keys, Backspace / Delete, Enter, Cmd/Ctrl+A and IME input; Esc finishes). New `<ShapeOptionsBar>` (kind, fill, stroke, width, radius, sides, points, line weight and arrowhead; edits the active shape too) and `<TypeOptionsBar>` (font from the editor's fonts, size, bold, italic, colour, alignment; styles the selection while editing). `<LayersPanel>` shows thumbnails with a badge for shape and type layers and warns about missing fonts. Core adds the shared logic (`ShapeDrawGesture`, `applyShapeOptions`, `TypeToolGesture`, `TextEditSession`, `typeLayerAt`, `layerHasThumbnail`, `layerWarning`), the `shape` and `type` tools and the renderer's `textEdit` overlay. The demo's Image tab adds a poster agent script.
