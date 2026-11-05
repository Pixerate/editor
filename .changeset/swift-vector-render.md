---
"@pixerate/swift": minor
"@pixerate/editor": patch
---

**Swift vector editor: scene render data and SVG (#623).**

- `getVectorSceneRenderData` / `VectorEditorController.sceneRenderData` in `PixerateVector`: the document-space paths, groups and paint servers the canvases draw, as the TS returns them, for paths and groups, transforms, opacity, blend modes, linear and radial gradients, paint stacks and live booleans.
- Paint stacks (`vectorFills`, `vectorStrokes`, `withVectorFills`, `withVectorStrokes`, `normalizeVectorPaintStacks`, `vectorPaintLayerNodes`, the sanitizers) and gradient paint servers (`vectorPaintToSvg`, `vectorGradientSvgDefs`, `sanitizeVectorGradient`).
- `vectorDocumentToSvg` now writes gradients (with `data-vector-gradient`), paint stacks (`<g data-vector-path>`), blend modes, filter stacks whose filters draw nothing, and live booleans (drawn shapes plus the hidden source) as the TS does.
- SVG import: `parseVectorSvg` and the `vector.importSvg` command (add or replace): shapes, groups, transforms, `viewBox`, presentation attributes, `<style>` rules and `style` declarations, fill and stroke opacity, gradients through `href` chains, clip paths and masks as mask groups, and this editor's own export. Features not ported yet throw "not ported to Swift yet (#624)".
- The conformance runner reads the `render` step flag and compares `render()` of the host. The new `svg-round-trip` scenario passes, with the four ported scenarios' render steps; the SVG steps of `import-export` replay on their own.
- `String.jsParseFloat` and `String.jsToNumber` in `PixerateCore`: `parseFloat` and `Number` of strings as V8 reads them.

**Core:** conformance steps take an optional `render: true`: the recorder writes `expect.render` from the host's new optional `render()`, and the replay tests compare it like a result. The vector conformance host renders `getVectorSceneRenderData` of its controller's state. New vector scenario `svg-round-trip`.
