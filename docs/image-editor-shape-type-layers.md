# Image editor shape and type layers (design)

**Status:** implemented. Core in #231 (shapes) and #234 (type), PSD mapping in #235, React / Svelte UI and the demo in #237. This note was written after the code, so it records what was built and why. It is a follow-up of [Image editor layers](./image-editor-layers.md#built-since-v1).

Before this work, drawn objects were annotation layers: one `Annotation` per layer, drawn by the old annotation renderer, and written to PSD as pixels. Shape and type layers replace them with real vector and text layers. They can be edited after they are drawn, render sharp after any number of moves or transforms, and map to Photoshop's shape and type layers.

## Goals and non-goals

**Goals**
- Shape layers: live rectangles (with per-corner radii), ellipses, polygons, stars and lines with arrowheads; free paths; Photoshop's path operations; fill and stroke in colour, gradient or pattern.
- Type layers: point and paragraph text with character and paragraph styles over runs.
- Both behave like pixel layers for everything above their content: masks, effects, clipping, blend modes, opacity, fill opacity, thumbnails, rasterize.
- Old documents (v1 / v2) open, render and save exactly as before, and the annotation API keeps working.
- Real PSD shape and type layers in and out, with unchanged layers written back byte for byte.
- Every capability has an agent tool (AGENTS.md §4) and works the same in React and Svelte (§3).

**Not in this change:** text on a path, vertical type, text warps, on-canvas anchor editing for shapes, Photoshop's polygon and star `vogk` keys, and Photoshop's "Align Edges" snapping of 1 px strokes. See [Follow-ups](#follow-ups).

## Model

Both types live in `layers/model.ts` and join the `ImageLayer` union. They share one idea: **the vectors or the text are the layer, and `surface` is a render cache.**

```ts
interface ShapeLayer extends LayerBase {
  type: 'shape';
  components: ShapeComponent[]; // bottom (first) to top
  fillRule?: 'nonzero' | 'evenodd';
  inverted?: boolean;           // fill everything except the combined area
  fill: ShapePaint | null;      // EffectFill (colour, gradient, pattern) + opacity
  stroke: ShapeStroke | null;   // width, paint, align, cap, join, miterLimit, dashes, dashOffset
  surface: PixelSurface;        // rendered pixels, document space
  offset: { x: 0; y: 0 };       // a shape moves through its geometry
  fillOpacity?: number;
  annotation?: Annotation;      // the annotation it was migrated from, while unchanged
  psd?: ShapePsdData;           // blocks read + signature
}

interface ShapeComponent {
  op: 'combine' | 'subtract' | 'intersect' | 'exclude';
  subpaths: VectorSubpath[];    // document px, absolute handles (the vector editor's anchors)
  live?: LiveShape;             // rect | ellipse | polygon | star | line, with its own transform
}

interface TypeLayer extends LayerBase {
  type: 'type';
  text: string;
  runs: TextRun[];              // { length, style: TextStyle }, lengths in UTF-16 units
  paragraphs: ParagraphRun[];   // whole paragraphs, line break included
  frame: { kind: 'point'; origin?: 'baseline' | 'top' } | { kind: 'box'; width: number; height: number };
  transform?: AffineMatrix;     // text space → document
  antiAlias?: boolean;
  surface: PixelSurface;
  offset: { x: 0; y: 0 };
  fillOpacity?: number;
  rendering?: 'stored';         // pixels from a PSD or a save, not drawn here yet
  missingFonts?: string[];
  annotation?: Annotation;
  psd?: TypePsdData;            // TySh as read + signature + unmodelled blocks
}
```

**Shapes follow Photoshop's component model.** A component's subpaths are filled together with the layer's fill rule, so opposite windings cut holes. Components are then folded bottom to top with their operation, and the first one always combines. The stroke follows the outline of the combined area, centred, inside or outside it. Open paths always stroke centred.

**Live shapes stay live.** A component drawn as a rectangle, ellipse, polygon, star or line keeps its parameters in `live`, with an affine `transform` for where its own frame lands. Its `subpaths` are always the shape that `live` describes. Editing the subpaths directly drops `live`. A line is a filled bar of `weight` pixels with optional arrowheads, as in Photoshop, not a stroked path.

**Type is styled runs over plain text.** `TextStyle` holds family, weight, italic, size (px), colour, opacity, tracking (1/1000 em), leading, baseline shift, underline, strike-through and a PostScript name from a PSD. `ParagraphStyle` holds alignment (justify included), auto leading, indents and spacing. Point text grows from its origin with one line per paragraph. Box text wraps inside `width × height`. Everything else (move, rotate, scale, skew, flip) goes into `transform`.

**Why a render cache.** `hasSurface` and `isRenderedLayer` let the compositor, effects, masks, clipping, thumbnails, Merge Down and PSD export treat shape and type layers like pixel layers and smart objects without knowing about vectors. The cost is a rule: nothing re-renders the surface implicitly. Every change goes through an operation that renders again (`updateShapeLayer`, `rerenderShape`, `offsetShape`, `updateTypeLayer`, `rerenderText`). Painting `pixels` on these layers is refused, and `rasterize_layer` turns them into pixel layers (`shapeAsPixelLayer`, `typeAsPixelLayer`). The surface is in document space at offset (0, 0), clipped to the canvas grown by `MAX_EFFECT_REACH` (512 px), so effects near the edge still see the content.

## Rendering shapes

`layers/shape.ts` renders without a canvas, tile by tile, into the layer's surface. It has no DOM dependency, so shapes render the same in browsers, Node, Workers and tests.

1. **Geometry, memoised per layer object.** Each component is flattened to polylines (`flattenPath`, curves within a fixed tolerance). The stroke area comes from the curve path operations: `outlineStroke` (a clean outline) for curved paths of up to 64 commands, otherwise the raw `strokeOutlineRings`. Raw rings of a curve tighter than half the stroke width turn inside out, and clean outlines get slow on long pen strokes, hence the limit. Inside and outside strokes are drawn at twice the width and then clipped by the fill area.
2. **Coverage.** `layers/vector-raster.ts` has two rasterizers:
   - `rasterizeCoverage` (*exact*): the signed-area accumulation rasterizer of font-rs, extended with clipping on every side. A pixel's coverage is the exact area of the path inside it, but only while the path does not overlap itself.
   - `rasterizeCoverageSampled` (*sampled*): 16 sub-rows per pixel row, each with exact horizontal coverage of the spans the fill rule keeps. Overlapping parts count once. Edges are within 1/32 px vertically.

   Single-contour fills use exact coverage. Strokes and multi-contour components use sampled coverage, because stroke outlines overlap at joins, and a line's bar and arrowhead are separate subpaths that overlap. With exact coverage those overlaps were up to 47 levels too opaque. Components are combined per pixel with `combineCoverage` (union, subtract, intersect, xor on coverage values).
3. **Paint.** Fill and stroke colours come from the layer-effect fill code (`effectFillColors`), so gradients and patterns are shared with effects. Gradients aligned with the layer use the shape's geometry bounds. The stroke is composited over the fill per pixel in straight alpha.

**Equivalence with annotations.** `tests/image-shape-migration.test.ts` compares each annotation kind rendered as a shape with a 16 × 16 point-sampled reference of the old canvas drawing.

## Rendering type

### Layout is in core, fonts are pluggable

`layers/text.ts` does all the layout: paragraphs, line breaking (at spaces and after break characters, and between wide CJK characters), alignment and justification, tracking, leading, indents, spacing, baseline shift, underline and strike-through, caret positions and hit testing (`textIndexAt`, `caretAt`). Everything that needs a font goes through a `TextShaper`:

```ts
interface TextShaper {
  readonly id: string;                                    // part of the layout cache key
  resolve(font): { family: string; available: boolean };  // fallback when missing
  metrics(font): { ascent: number; descent: number };
  measure(text, font): ArrayLike<number>;                 // text.length + 1 caret offsets, kerning included
  outline?(text, font, x, y): BezierPath;                 // glyph outlines (pure)
  draw?(ctx, text, font, x, y): void;                     // onto a 2D canvas
  families?(): string[];
}
```

Why this split:
- **One layout everywhere.** Canvas 2D has no line breaking, justification or per-run styling, and the browser's own layout (DOM, SVG) differs per engine and isn't available in Node. Our layout gives the same lines for the same measurements in every host, and the on-canvas editor, agents (`get_text_layer` returns the laid-out lines) and PSD export all use it.
- **Fonts belong to the host.** Fonts are large, licensed and platform-specific, so core does not bundle or parse them. The browser already has fonts and draws text well. A server or test can load font files and draw outlines.
- **Outlines make Convert to Shape possible**, and they make rendering deterministic for tests.

`layers/text-shapers.ts` has two shapers:
- `createCanvasTextShaper`: the browser's fonts through `measureText` and `fillText`. It is the default in browsers. A family is missing when it measures the same as both `monospace` and `serif` (the browser fell back), so web fonts must be loaded before layout. Its `metrics` report `emHeightAscent` (falling back to the font box), which keeps migrated text where the old renderer put it. It cannot give outlines.
- `createOutlineTextShaper(fonts)`: glyph outlines and kerned advances from font objects shaped like opentype.js's `Font`, typed structurally so core does not depend on opentype.js. Pure, so it works without a DOM. `tests/helpers/box-font.ts` is a deterministic box font for tests.

The controller creates the canvas shaper lazily. Hosts override it with `ImageEditorOptions.textShaper` or `setTextShaper`. Layouts are memoised per layer object and shaper id.

### Drawing

`renderText` lays out once, then:
- with an outline shaper, fills each fragment's outlines (plus decoration bars) through the sampled rasterizer, tile by tile, in the run's colour and opacity (`antiAlias: false` thresholds at 0.5);
- with a drawing shaper, draws onto a canvas over the ink bounds with the text matrix and reads it back into a surface.

**Without a shaper** (Node or jsdom with no outline shaper set), type layers keep the pixels they were saved with (`rendering: 'stored'`, stored as a PNG asset in v3 JSON). Edits that would need drawing are refused with an error that says how to fix it, and `addTextLayer` throws. A PSD's type layers also open with `rendering: 'stored'`, showing Photoshop's pixels until the first edit, so a file with fonts we lack still looks right. `missingFonts` lists families drawn with a fallback, and the layers panel shows it as a row warning.

**Convert to Shape** (`convertTextToShape`) turns the text's outlines into a shape layer with the same id, name, mask, effects, opacity and blend. The fill is the first run's colour. It needs an outline shaper and refuses on the canvas one.

## Migration of annotation layers

Pen, rectangle, ellipse, line and arrow annotations load as shape layers (`shapeFromAnnotation`). Text annotations load as type layers (`typeFromAnnotation`). Image annotations, and annotations whose colour can't be read, stay annotation layers. `annotationLayerFor` in `layers/migrate.ts` makes that choice.

**A migrated layer keeps its `annotation` while it is unchanged.** Rebuilding an annotation from a shape isn't exact in floating point (an ellipse's box `x − rx` back to `x`, for one). So the layer keeps the source annotation, and these read it:
- `legacyView` and `isLegacyShape`. A document that still has the v1 / v2 shape (Background, adjustment layers, then plain annotation-derived layers whose id and name match their annotation) writes v1 / v2 byte for byte.
- The `annotations` state view, `selectedAnnotationId` and `updateAnnotation`. `updateAnnotation` rebuilds the layer from the merged annotation, or falls back to an annotation layer when its colour can't be read.
- The renderer's annotation overlay. Plain migrated layers at the top of the stack still draw as crisp vectors at screen resolution, as before.

Any shape or text edit, a duplicate, a move or a transform drops `annotation`. The layer then leaves the `annotations` view and saves as v3. The annotation's blend mode moves to the layer.

**Text placement.** The old renderer drew text with `textBaseline = 'top'`, the top of the em box. Migrated type layers use `frame: { kind: 'point', origin: 'top' }`, so the first baseline is one ascent below the origin. Canvas also drew every whitespace character as a space, so migration replaces line breaks with spaces. `tests/image-type-tools.test.ts` checks that the new drawing calls match the old ones. Where no shaper exists, migrated text is created undrawn and draws on the first edit where one does.

**v3 JSON.** Shapes save their vectors (`SerializedShapeLayer`) and render again on load, so they have no asset. Type layers save their text, runs, paragraphs, frame and transform, plus the rendered pixels as a PNG asset, so a load without the fonts still shows them. Both keep `annotation` while it is set and their PSD blocks (base64) for round trips.

## Free Transform

Shape and type layers transform as a whole, like smart objects. A selection does not limit them, and `content` must be `layer` (rasterize the layer to transform part of it). Both rely on the matching layer-space rule in GOTCHAS ("Layer Pixels and Masks Are in Layer Space…").

- **Shapes** map their paths, never their pixels (`resampleShape`). The frame is the geometry bounds, given at least 1 px of width and height so a straight line can turn. Under an affine map, live shapes stay live: the map is multiplied into `live.transform` (`transformShapeComponents`). Perspective, distort and warp map the anchors and turn components into plain paths. Previews render only the visible clip. A linked mask moves with the layer.
- **Type** sets its text matrix from the corners (`resampleType`, `matrixFromCorners`). The frame is the text's own box (`typeFrame`). Only affine changes are allowed (scale, rotate, skew, flips). Distort, perspective and warp are refused with a pointer to `rasterize_layer`. A linked mask follows the matrix change.
- Both drop `annotation`. The Move tool and `offset_layer` move the geometry too (`offsetShape` for shapes, the translation of the text matrix for type), so offsets stay (0, 0).

## PSD mapping

### Shapes (`psd/paths.ts`, `psd/shapes.ts`)

| Block | Holds | Model |
|---|---|---|
| `vsms` (or `vmsk` in older files) | Path records: 26-byte records, knots as 8.24 fixed-point fractions of the document height and width | `components` |
| `vscg`, or `SoCo` / `GdFl` / `PtFl` | Fill content: colour, gradient, pattern | `fill` |
| `vstk` | Stroke (widths in points, converted at the file's resolution) and whether the fill is on | `stroke`, `fill: null` |
| `vogk` | Live shape origins per component: rectangle, rounded rectangle, ellipse, line with arrowheads | `components[].live` |

`paths.ts` reads and writes path records. The operation is stored in bytes 2–3 of a subpath length record (undocumented, as psd-tools found): 1 or -1 combine, 2 subtract, 3 intersect, 0 exclude, and -1 after a component's first subpath means "same component". `componentsFromVectorBlock` starts a component at every subpath whose operation is not -1. A first component that subtracts starts from a full canvas, so it becomes `inverted: true`, with the later operations swapped for their duals (combine ↔ subtract).

On import, shapes are **drawn from their paths**, not from Photoshop's pixels. Across 546 shape layers of the public corpus, the alpha matches Photoshop's within antialiasing, apart from a few 1 px strokes that Photoshop snaps to the grid and icons whose stored pixels are offset by half a pixel. Anything approximated produces a warning naming the layer. A shape without a readable path comes in as its stored pixels.

### Type (`psd/engine-data.ts`, `psd/type.ts`)

`TySh` holds a version, the text-space → document transform (six doubles), the text descriptor (`TxLr`: `Txt `, anti-aliasing, bounds and `EngineData`), the warp descriptor and four trailing values. `engine-data.ts` parses and writes EngineData, Photoshop's PostScript-like syntax of dictionaries, arrays, UTF-16 strings, names, numbers and booleans. Dictionaries keep their key order, so a parse and a write give back what Photoshop wrote, apart from whitespace and number formatting.

- **Units.** EngineData sizes are text-space units, which the transform maps to document pixels, so they are already our pixels. Unlike `vstk` widths, no resolution conversion is needed.
- **Runs.** EngineData's text always ends with an extra `\r`, which the last paragraph run and the last style run each cover. Line breaks are `\r`. Import reads the text from `Txt ` and fits the runs to it (`fitRuns`). Export writes the extra `\r` and makes both last runs one longer (`buildEngineData`).
- **Box text** keeps its origin in `BoxBounds`. Import folds its top-left into our transform, so our box starts at (0, 0).
- **Fonts.** PostScript names map to family, weight and italic (`fontFromPostScript`, after photocraft's `guess_from_postscript`). The name is kept on the style so the exact face is written back.

### Writing back: signature-based verbatim blocks

A full model of either block would be large, and anything we don't model (Photoshop-only text settings, extra `vogk` keys) would be lost on every save. So import keeps the blocks it read together with a **signature** of what it understood: `shapeSignature` (components, fill, stroke, fill rule, inverted) and `typeSignature` (text, runs, paragraphs, frame, transform, anti-aliasing), stored in `layer.psd`.

On export (`shapeBlocks`, `tyShForLayer`):
- **Unchanged** (the signature still matches): the blocks are written back **byte for byte**.
- **Changed shape**: all blocks are written from the model (`vsms`, `vscg`, `vstk` when there is a stroke or no fill, `vogk` for live rectangles, ellipses and lines). Losses become export warnings: even-odd written as nonzero, shape fill opacity (no PSD equivalent), and different start and end arrowheads (Photoshop has one arrowhead size). Polygons and stars are written as plain paths.
- **Changed type**: the old EngineData is the template, and the text, runs, paragraphs, fonts, frame and transform are patched into it, so Photoshop-only settings survive. A layer with no `TySh` gets a new one. An unchanged "none" warp stays, and a warp we can't draw is dropped once the text is edited.

Both still write their rendered pixels as the layer's channels, so viewers without a vector or text engine show our result. Shape and type layers count as `mapped` / `approximated` in `inspect_psd`, not as pixel layers.

## UI

**Shared logic in core.** As with the layers panel (`layers/panel.ts`), the rules live in core so React and Svelte share one implementation. `layers/shape-type-ui.ts` has:
- `ShapeToolOptions` / `TypeToolOptions` with defaults, and `applyShapeOptions` for the options bar on a selected shape.
- `liveShapeForDrag` (Shift for square, circle or 45° line; Alt to draw from the centre) and `ShapeDrawGesture`. The layer is added on the first real move (one undo step), and its component updates live without history until the pointer is released.
- `TypeToolGesture`. A click on type edits it at the clicked character (`typeLayerAt`). A click elsewhere adds point text, and a drag adds paragraph text in the dragged box.
- `TextEditSession`: caret and selection in UTF-16 units, typing, deleting, moving, clicking, styling the selection, and `overlay()` (caret segment, selection quads, frame), which the renderer draws through its `textEdit` option. The first change of a session records one undo step, and the rest join it.

The components only translate DOM events and draw the overlay. `ShapeOptionsBar` and `TypeOptionsBar` exist in both packages. The layers panel shows thumbnails for shape and type layers (`layerHasThumbnail`) and the missing-fonts warning (`layerWarning`).

**Typing goes into a hidden textarea.** The canvas can't take text input, and composed (IME) text arrives as `compositionend` / `input`, not as keys. Both editors render a 1 px transparent `<textarea data-testid="type-input">` while a session is open and focus it on the next tick after mouse-up. Editing keys go to `TextEditSession.handleKey` unless `isComposing`. Undo and clipboard shortcuts are left to the browser (see the GOTCHAS entry).

## Agent tools

Shape tools (`shape-tools.ts`) and type tools (`type-tools.ts`) are on the image-editor provider. Each has a strict schema, a title, all four annotations, validates before it changes anything, and returns what it changed. Each write is one undo step.

| Tool | Kind | Returns |
|---|---|---|
| `get_shape_layer` | read | Components (index, op, live parameters, subpaths, bounds), fill rule, fill, stroke, geometry and rendered bounds, `annotationId` while migrated |
| `add_shape_layer` | write | The layer and shape. A live `shape`, a free path (SVG path data or anchors), or several `components`; fill defaults to the foreground colour |
| `update_shape` | write | The shape after the change (fill, stroke, fill rule) |
| `set_shape_component`, `add_shape_component`, `remove_shape_component` | write | The shape, components by index from `get_shape_layer` |
| `merge_shape_components` | write | The shape with one combined component (live shapes become paths) |
| `list_fonts` | read | Families the current shaper can draw, and which shaper |
| `get_text_layer` | read | Text, runs and paragraphs as `start` / `end` ranges, frame, transform, laid-out lines, bounds, `missingFonts`, `rendering` |
| `add_text_layer` | write | The layer and text layer. Point text at a baseline origin, or box text |
| `set_text`, `set_text_style`, `set_paragraph_style` | write | The text layer; ranges are `start` / `end` from `get_text_layer` |
| `set_text_frame` | write | The text layer, switched between point and box text |
| `set_text_orientation` | write | The text layer, set horizontal or vertical (columns top to bottom, right to left) |
| `convert_text_to_shape` | write (destructive) | The new shape and warnings; refuses without an outline shaper |

The existing tools cover the rest: `list_layers` summarises shapes, `transform_layer` applies Free Transform with the rules above, `rasterize_layer` makes pixel layers, `paint_stroke` refuses `pixels` on rendered layers, and `inspect_psd` / `import_psd` / `export_psd` map them. Type tools that would draw text refuse with the reason when there is no shaper.

The domain skill (`packages/core/skills/pixerate-image-editor/SKILL.md`, with `references/shapes-and-type.md`) has a "Shapes and text" working method and a row per tool. The tools are in the `command-tools.test.ts` conformance list.

## Testing

- `tests/image-shape-layers.test.ts` and `tests/image-type-layers.test.ts` cover the model, rendering, layout and transforms. Type tests use the deterministic box font, so they need no DOM and no system fonts.
- `tests/image-shape-migration.test.ts` checks that migrated annotations render as before and that v1 / v2 round trips stay byte-exact. `tests/image-type-tools.test.ts` does the same for text, and checks that the new drawing calls match the old ones.
- `tests/image-shape-tools.test.ts` and `tests/image-type-tools.test.ts` call every tool through `ToolRegistry.callTool` with valid and invalid arguments.
- `tests/image-psd-shapes-type.test.ts` covers path records, the blocks, EngineData parse / write, the byte-for-byte write-back while unchanged and the regenerated blocks after edits. The opt-in corpus (`pnpm test:corpus`) checks every file still opens and round-trips.
- `tests/image-shape-type-ui.test.ts` covers the shared gestures and text session. The React and Svelte suites type into the hidden textarea.

## Follow-ups

| Follow-up | Notes |
|---|---|
| Text on a path, vertical type, text warps | `TySh` warps are kept only while the text is unchanged |
| On-canvas anchor editing for shapes | Reuse the vector editor's path editing on `components[].subpaths` |
| Polygon and star `vogk` keys | Written as plain paths today, so Photoshop sees them as paths |
| Photoshop "Align Edges" | Snap 1 px strokes to the pixel grid as Photoshop does, to close the remaining corpus differences |
