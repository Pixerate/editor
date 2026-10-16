# Vector editor

`@pixerate/editor/vector` is a headless vector drawing editor: a document of Bézier paths and groups, the select / direct-select / pen / pencil / shape tools, transforms, boolean operations, alignment, grouping, undo, SVG import and export, and agent commands. It has no DOM or third-party imports, so it runs in the browser, Node.js and workers. React (`@pixerate/editor-react/vector`) and Svelte (`@pixerate/editor-svelte/vector`) add the same hooks / runes and an SVG canvas, toolbar and style panel.

## Document model

```ts
import { rectSubpath, type VectorDocument } from "@pixerate/editor/vector";

const doc: VectorDocument = {
  width: 800,
  height: 600,
  background: "#fff",
  nodes: [
    {
      id: "wave",
      type: "path",
      fill: null,
      stroke: "#0ea5e9",
      strokeWidth: 3,
      subpaths: [
        {
          closed: false,
          anchors: [
            { x: 0, y: 100, out: { x: 50, y: 0 } },              // handles are absolute positions
            { x: 100, y: 100, in: { x: 50, y: 200 }, type: "smooth" },
          ],
        },
      ],
    },
    { id: "box", type: "path", fill: { type: "linear", angle: 90, stops: [{ offset: 0, color: "#f43f5e" }, { offset: 1, color: "#7c3aed" }] }, subpaths: [rectSubpath({ x: 200, y: 50, width: 120, height: 80 }, 12)] },
    { id: "g1", type: "group", children: [/* … */] },
  ],
};
```

- A **path** has one or more subpaths (holes and compound shapes), a fill and stroke (any CSS colour, a gradient, or `null`), stroke width / caps / joins / dashes, a fill rule and opacity.
- An **anchor** has optional `in` / `out` handles (absolute document positions). A segment with no handles at either end is a straight line; otherwise it is a cubic Bézier. `type` is `corner`, `smooth` (handles in line) or `symmetric` (in line, equal length) and decides how the opposite handle follows when one is dragged.
- A **group** selects and transforms its children together. Nodes can be hidden (`visible: false`) or locked (drawn, not pickable).

Geometry helpers work on this model directly: `vectorPathData`, `bezierToSubpaths` (SVG path data → anchors, quadratics and arcs become cubics), `vectorNodeBounds` (exact curve bounds), `hitTestVectorNode`, `nearestSegment`, `insertAnchor` (de Casteljau split, shape unchanged), `convertAnchor`, `moveAnchorHandle`, `transformVectorNode` with `translateMatrix` / `scaleMatrix` / `rotateMatrix`, and shape factories (`rectSubpath`, `ellipseSubpath`, `polygonSubpath`, `starSubpath`, `lineSubpath`).

## Controller

```ts
import { VectorEditorController } from "@pixerate/editor/vector";

const editor = new VectorEditorController({
  document: doc,
  defaults: { fill: "#e4e4e7", stroke: "#18181b", strokeWidth: 2 },
  snap: { grid: 8 },
  onChange: (doc) => save(doc),
});

editor.subscribe((state) => render(state)); // state is stable until something changes
```

The UI forwards events in canvas pixels; the controller converts them with its viewport (`screen = document × zoom + (x, y)`):

```ts
canvas.onpointerdown = (e) => editor.pointerDown(local(e), toVectorPointerInput(e));
canvas.onpointermove = (e) => editor.pointerMove(local(e), toVectorPointerInput(e));
canvas.onpointerup = (e) => editor.pointerUp(local(e), toVectorPointerInput(e));
canvas.ondblclick = (e) => editor.doubleClick(local(e));
canvas.onwheel = (e) => editor.wheel(local(e), { x: e.deltaX, y: e.deltaY }, toVectorPointerInput(e));
canvas.onkeydown = (e) => { if (!isVectorTextTarget(e.target) && editor.keyDown(toVectorKeyInput(e))) e.preventDefault(); };
canvas.onkeyup = (e) => editor.keyUp(toVectorKeyInput(e));
```

| Tool (key) | Pointer |
| :--- | :--- |
| Select (V) | Click / Shift-click / marquee to select; drag to move (Shift locks an axis, Alt duplicates); box handles resize (Shift keeps proportions, Alt from the centre); the round handle rotates (Shift snaps to 15°); double-click a path to edit its points |
| Direct select (A) | Click or marquee points; drag points, handles (Alt breaks a smooth pair) or a segment; Alt-drag a point to pull out smooth handles; Alt-click a segment to add a point; double-click a point to toggle corner / smooth |
| Pen (P) | Click for corners, drag for curves (Alt moves only the outgoing handle, Shift snaps to 45°); click the first point to close; Enter / Escape / double-click to finish; click an open path's end to continue it; Backspace removes the last point |
| Pencil (N) | Freehand; the stroke is fitted to cubic Béziers |
| Rectangle (R), Ellipse (O), Polygon (Y), Star (S), Line (L) | Drag out a shape (Shift: square / 45°, Alt: from the centre); returns to Select |

Other keys: Delete / Backspace, arrows (Shift = 10), Mod+Z / Mod+Shift+Z, Mod+A, Mod+D, Mod+G / Mod+Shift+G, Mod+] / Mod+[ (Alt: to front / back), Mod+= / Mod+- / Mod+0, Space-drag or middle-drag to pan, Mod+wheel to zoom.

Every gesture is one undo step (`Move`, `Scale`, `Draw Rectangle`, `Add Point`, `Close Path`, …), recorded in the controller's `HistoryManager` (pass `history` to share one with the rest of the app). `Escape` during a drag puts everything back.

Programmatic API, all undoable: `addShape`, `addPath`, `addNode`, `updateNode`, `setStyle`, `removeNodes`, `translate`, `scale`, `rotate`, `flip`, `transform(matrix)`, `align`, `distribute`, `arrange`, `group`, `ungroup`, `duplicate`, `booleanOp('union' | 'subtract' | 'intersect' | 'exclude')`, `combine`, `breakApart`, `moveAnchor`, `moveHandle`, `convertAnchors`, `insertAnchorAt`, `deleteAnchors`, `setClosed`, `reversePaths`, `copy` / `cut` / `paste` (JSON text, or SVG markup on paste), `loadSvg`, `importSvg`, `setDocument`, `setArtboard`. Viewport: `zoomAt`, `zoomToFit`, `panBy`, `setViewport`, `screenToDocument`, `documentToScreen`.

## Rendering

`getVectorSceneRenderData(state)` returns the document as SVG-ready paths (with gradient defs) and a `transform` for the document layer; `getVectorOverlayRenderData(state)` returns the overlay in screen pixels: outlines, the selection box with its handles, anchors, handles, the marquee, the pen's rubber band and a status string. Draw the overlay outside the transformed layer so handles keep their size at any zoom. The bundled React and Svelte canvases are thin renderers over these two functions.

## SVG

```ts
import { parseVectorSvg, vectorDocumentToSvg } from "@pixerate/editor/vector";

const doc = parseVectorSvg(markup);        // DOM-free: path, rect, circle, ellipse, line, polyline, polygon, g,
                                           // linear / radial gradients, style attributes and transforms
const svg = vectorDocumentToSvg(doc);      // standalone SVG with <defs> for gradients
```

Transforms are baked into the anchors on import (stroke widths are scaled by the transform's average scale). Text, images, clip paths, masks, filters and `<use>` are skipped.

## React

```tsx
import { VectorEditor, useVectorEditorController, useVectorCommands } from "@pixerate/editor-react/vector";

function Drawing() {
  const controller = useVectorEditorController({ document: doc });
  useVectorCommands(registry, controller); // optional: palette and agent commands
  return <VectorEditor controller={controller} height={520} />;
}
```

`<VectorCanvas>`, `<VectorToolbar>` and `<VectorStylePanel>` can be used on their own; `useVectorEditor` / `useVectorEditorState` give the state.

## Svelte

```svelte
<script lang="ts">
  import { VectorEditorController } from "@pixerate/editor/vector";
  import { VectorEditor, useVectorCommands } from "@pixerate/editor-svelte/vector";
  const controller = new VectorEditorController({ document: doc });
  useVectorCommands(registry, controller);
</script>

<VectorEditor {controller} height={520} />
```

`createVectorEditor(controllerOrOptions)` exposes the state reactively (call `destroy()` when done).

## Agent commands

`createVectorCommands(controller)` returns `vector.list`, `vector.select`, `vector.addShape`, `vector.addPath`, `vector.setStyle`, `vector.transform`, `vector.delete`, `vector.boolean`, `vector.align`, `vector.distribute`, `vector.arrange`, `vector.group`, `vector.ungroup`, `vector.setTool`, `vector.exportSvg` and `vector.importSvg`. Register them in a `CommandRegistry` and `createCommandToolProvider` exposes them as agent tools.
