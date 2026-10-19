# Image editor layers (design proposal)

**Status:** decisions recorded (see [Decisions](#decisions)). Phase 1 is implemented; where it differs from this proposal, [Implementation notes](#implementation-notes) says how and why. The PSD work depends on it.

Today `@pixerate/editor/image-editor` edits one image. This proposal adds a real layer stack (pixel, adjustment and group layers with masks, blend modes, clipping and opacity) and painting on tiled, copy-on-write pixel storage. Once that exists, Photoshop PSD read and write maps almost one to one.

## Today

| Part | Where | Notes |
|---|---|---|
| Source image | `ImageEditorState.sourceUrl`, decoded element in the controller | Immutable. AI edits (`applyInpaintedImage`, background removal) replace it wholesale. |
| Base sliders | `ImageAdjustments` (brightness … tint, `process`) | Applied to the source first. |
| Adjustment layers | `ImageAdjustments.layers` | Bottom to top over the base result, each with blend, opacity and an optional mask (`AdjustmentLayerMask`, `r1:` RLE in natural pixels). |
| Blur, opacity, depth mask | `ImageAdjustments.blur` / `.opacity`, `depthMask` | Applied after the layers. |
| Annotations | `annotations` | Vector overlay in natural pixels, drawn last. |
| Crop and rotate | `crop`, `transform` | Non-destructive projection of natural pixels (`getBaseProjection`). |
| Rendering | `renderer.ts` `renderBaseImage` | Draws the cropped region at full resolution into one `ImageData`, then runs `applyAdjustments` over all of it in one pass. |
| Undo | `controller.ts` `HistoryEntry` | Each entry is a full `SerializedImageEditorState` plus the source snapshot. Selections are shared because they are immutable. |

Two limits rule out "just add pixel layers on top". First, adjustments run as one pass over a single buffer, so they cannot sit between pixel layers. Second, history serializes the whole state on every entry, which can't scale to pixel data.

## Goals and non-goals

**v1 goals**
- Pixel, adjustment and group layers in one ordered stack, with name, visibility, opacity, fill opacity, all 26 blend modes (plus pass-through for groups), clipping masks, raster layer masks and locks.
- Painting: brush and eraser with pressure, Edit › Fill, and painting into layer masks, limited by the selection.
- Tiled, sparse, copy-on-write pixel storage, so a stroke costs only the tiles it touches, and undo shares everything else.
- Old documents (schema v1 / v2) open and render exactly as before. Existing APIs, components and agent tools keep working.
- Every capability is reachable by agents (AGENTS.md §4), with parity across core, React and Svelte (§3).

**Not in v1:** layer effects (drop shadow, stroke …), type, shape and smart-object layers, free transform of layers (moving is in), clone / heal / smudge / mixer tools, 16-bit or float layers, colour management. Each is planned as a follow-up under [Follow-ups after v1](#follow-ups-after-v1).

## Document model

All layer geometry lives in **document space**, which is the existing natural-pixel space. Crop, rotation, selections, masks and annotations already use it, so they keep working unchanged. Crop and rotate stay a non-destructive view over the whole document.

```ts
type ImageLayer = PixelLayer | AdjustmentLayerNode | GroupLayer | AnnotationLayer;

interface LayerBase {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;              // 0..1
  blend: BlendMode;             // groups also accept 'pass-through'
  clipped?: boolean;            // clip to the nearest unclipped layer below
  mask?: RasterMask;
  locks?: { pixels?: boolean; transparency?: boolean; position?: boolean; all?: boolean };
}

interface PixelLayer extends LayerBase {
  type: 'pixel';
  surface: PixelSurface;        // immutable, tiled, sparse
  offset: { x: number; y: number }; // integer move without re-tiling
  fillOpacity?: number;         // 0..1, PSD "Fill"
  filters?: LayerFilter[];      // live filters, applied bottom to top before mask and blend
}

type LayerFilter =
  | { kind: 'develop'; enabled: boolean } & DevelopSettings // brightness … tint, process
  | { kind: 'blur'; enabled: boolean; radius: number };

interface AnnotationLayer extends LayerBase {
  type: 'annotation';
  annotation: Annotation;       // the existing pen / rect / circle / arrow / line / text / image object
}

interface AdjustmentLayerNode extends LayerBase {
  type: 'adjustment';
  kind: AdjustmentKind;         // the existing ten kinds and params
  params: AdjustmentParamsMap[AdjustmentKind];
}

interface GroupLayer extends Omit<LayerBase, 'blend'> {
  type: 'group';
  blend: BlendMode | 'pass-through';
  children: ImageLayer[];       // bottom to top
  collapsed?: boolean;          // UI only
}

interface RasterMask {
  surface: MaskSurface;         // 1 byte per pixel, tiled
  defaultValue: 0 | 255;        // value outside the painted tiles (PSD default colour)
  density?: number;             // 0..1
  feather?: number;             // Gaussian σ in px
  enabled?: boolean;
  source?: DepthMaskOptions;    // parametric: generated from a depth map instead of painted
}

// ImageEditorState gains:
layers: ImageLayer[];           // bottom to top; [0] is "Background" for opened images
activeLayerId: string | null;
activeTarget: 'pixels' | 'mask';
```

**Background layer.** Opening an image creates one `PixelLayer` named "Background" from the decoded source. `sourceUrl` stays as the original file's URL for compatibility and for "revert".

**Base sliders, blur and depth mask (decided: as photocraft does it).** Photocraft has no document-level develop step. Its develop controls (temperature, tint, exposure, contrast …) are a Camera Raw smart filter on one layer (`crates/io/src/camera_raw_map.rs`, `SmartObject::smart_filters`), and blur is a filter too. Everything is a layer or belongs to one. Here:
- The base sliders become a `develop` filter on a pixel layer. Opening an image puts it on the Background layer, and any pixel layer can have one. Layers above are not re-toned.
- New blur is a `blur` filter on a layer.
- The depth mask becomes a parametric layer mask (`RasterMask.source`) on its layer. Photocraft has no depth mask; a layer mask is its nearest equivalent.
- Output `opacity` (export alpha) stays document-level.
- The existing `setAdjustments` / `set_adjustments` API edits the active pixel layer's `develop` filter, or the Background's when no pixel layer is active.

*Legacy blur.* Today blur runs after the adjustment layers, and blurring then applying an adjustment doesn't give the same pixels as the reverse order. A migrated v1 / v2 document with blur > 0 and adjustment layers therefore keeps its blur as a document-level `legacyOutputBlur` step so it still renders identically. New edits never create one.

**Annotations (decided: as photocraft does it).** Photocraft keeps drawn objects in the stack as shape and type layers. Its document-level `notes` are Photoshop's non-printing Notes (`Anno`), not drawings. Here each annotation becomes an `AnnotationLayer`: one object per layer, drawn by today's annotation code. It can be reordered, grouped, masked and blended like any other layer, and painted pixels can sit above it.
- The follow-up shape and type layers replace annotation layers as real vector and text layers.
- The `annotations` state array, the annotation methods and `selectedAnnotationId` keep working as a view over annotation layers. New annotations go to the top of the stack unless an `aboveId` is given.
- "Rasterize layer" turns an annotation layer into a pixel layer.

## Module layout

The surfaces, the generic layer stack and the compositor are shared with the planned paint editor (`docs/paint-editor.md`), so they live outside the image editor, in modules with no DOM or framework imports (typed arrays only, so they run in Node and Workers):

| Module | Subpath | Holds |
|---|---|---|
| `packages/core/src/raster` | `@pixerate/editor/raster` | Tiled copy-on-write surfaces, the PNG / zlib codec, blend modes, Gaussian blur of coverage planes, the generic layer stack (pixel layers, groups, raster masks, clipping, locks, tree helpers) and the per-tile compositor engine with its caches |
| `packages/core/src/paint` | `@pixerate/editor/paint` | The brush engine (phase 3): brush model, dab walking and spacing, tip rendering, flow build-up and the stroke coverage buffer |
| `packages/core/src/image-editor` | `@pixerate/editor/image-editor` | The photo-specific parts on top: develop and blur filters, adjustment and annotation layers, depth masks, selections, AI hooks, PSD mapping, the controller, its agent tools and the UI glue |

The compositor engine knows pixel layers and groups. An editor plugs its own layer kinds in through a `CompositorProfile`: layers that filter what is below them (adjustment layers), content layers it draws itself (annotations), per-layer pixel filters, and parametric mask sources (depth masks). The image editor's `LayerCompositor` is the engine with the photo profile. The image editor subpath still re-exports the surface and codec names it exported before.

## Tiled surfaces

The design follows photocraft's `photocraft_raster::Surface`: a sparse `BTreeMap<TileCoord, Arc<Tile>>`, 256 px tiles, a default pixel and shared tiles.

```ts
const TILE = 256;

interface PixelSurface {
  readonly tiles: ReadonlyMap<number, Tile>; // key = packed (tx, ty)
  readonly bounds: Rect | null;              // union of non-transparent tiles
}
interface Tile { readonly data: Uint8ClampedArray } // 256×256 RGBA8, straight alpha, frozen
```

- **Pixel format.** 8-bit straight-alpha RGBA, the same as `ImageData`. That means `blendImageData` and the adjustment LUTs work on tiles unchanged. Masks use the same structure at 1 byte per pixel.
- **Sparse and unbounded.** A missing tile is fully transparent (or the mask's `defaultValue`). Layers may extend past the canvas, as PSD layer rects do.
- **Copy-on-write.** Surfaces and tiles are never mutated after commit. A write produces a new surface that shares every untouched tile. A stroke edits a private *draft* copy of each tile it touches, and commits once at pointer-up.
- **Uniform tiles.** A tile whose pixels all have one value is stored once and shared, which keeps "fill layer with colour" and "hide all" masks cheap.
- **Pure TypeScript.** Tile code has no DOM dependency, so it runs in Node tests and later in a Worker. Tiles are transferable `ArrayBuffer`s.
- **Memory.** A tile is 256 KB, so a full 4000 × 3000 layer is 192 tiles (48 MB). History adds only touched tiles per step. `ImageEditorOptions` gains `maxHistoryBytes` next to `maxHistoryDepth`, and the oldest entries are evicted first.

## Rendering

The stack is composited per tile in document space. The result then goes through today's projection, output opacity and, for migrated documents only, `legacyOutputBlur`.

1. **Visible tiles only.** Only tiles that intersect the crop and viewport are composited.
2. **Per tile, bottom to top**, into an accumulator:
   - *Pixel layer:* read the tile (applying `offset`) and run its filters. `develop` is per pixel. `blur` needs neighbours, so the blurred layer is cached as its own surface and invalidated with a margin of 3σ around changed tiles. Then multiply by mask × density and blend with `blendImageData` at opacity × fill.
   - *Annotation layer:* draw the annotation into the tile's buffer with today's annotation code, then mask and blend it like a pixel layer.
   - *Adjustment layer:* apply its LUT or per-pixel kernel to the accumulator, then blend the result back over the accumulator through the mask and opacity. All ten existing kinds are per pixel, so this is tile-local.
   - *Group:* pass-through composites children straight onto the accumulator. Any other blend renders the children into a transparent buffer and blends it once.
   - *Clipping:* a run of clipped layers is composited, then limited by the alpha of its base layer.
3. **Caches.**
   - A prefix cache keeps the composite of layers `0..k` per tile. Changing layer `k+1` (a slider drag, a stroke) recomputes only from there up.
   - Strokes invalidate only the tiles they touch.
   - Feathered masks are blurred once into a cached surface, so mask application stays tile-local.
4. **Zoomed out.** Composite from per-surface mip tiles (built lazily and invalidated per tile) instead of full resolution. If the phase 1 benchmarks pass without them, they can wait.

Compositing uses the pure TS blend path so results are deterministic and testable. The canvas `globalCompositeOperation` fast path stays an optimisation only where it matches exactly (see the soft-light entry in GOTCHAS.md).

**Equivalence requirement.** A v1 / v2 document must render pixel-identically through the new pipeline. Phase 1 tests compare the old and new renderers on randomised adjustment stacks.

## Painting

The brush engine ports a subset of photocraft's `crates/paint` (MIT / Apache-2.0, credited in THIRD_PARTY_NOTICES.md like the earlier ports):

- **Strokes are data.** `{ tool, brush, color, target: { layerId, channel: 'pixels' | 'mask' }, points: { x, y, pressure?, t }[], seed }`. Any jitter is a hash of seed and dab index, so a stroke replays the same way for undo, agents and tests.
- **v1 brush:** computed round tip (size, hardness, angle, roundness, spacing), pressure to size and opacity, smoothing, and Photoshop's opacity-versus-flow build-up. Dabs accumulate coverage with flow up to the opacity ceiling inside a stroke buffer, and the stroke composites once at stroke opacity.
- **Tools:** Brush (B), Eraser (E) erasing to transparency (or to the background colour on a transparency-locked layer), Edit › Fill / Clear inside the selection, and Move (V) for whole-layer offsets.
- **Constraints:** the selection's coverage multiplies every dab. Lock transparency keeps alpha. Locked layers refuse strokes with a reason.
- **Mask painting.** When `activeTarget` is `'mask'`, strokes paint gray (black hides, white reveals) into the mask surface.
- **Live preview.** During a stroke only the touched tiles are recomposited, with the stroke buffer drawn over the layer. Pointer input uses `getCoalescedEvents()` and pointer capture.
- **History.** One stroke is one undo step.

## Layer operations

New layer, duplicate, delete, reorder, group / ungroup, merge down, merge visible, flatten, layer via copy / cut (from the selection), set properties, add mask (reveal all / hide all / from selection), apply mask, delete mask, enable / disable mask, add / edit / remove layer filters, rasterize layer (annotation or filtered pixel layer), and move (offset).

**AI hooks (decided: new layer for multi-layer documents only).** In a document with more than one layer, inpainting writes its result to a new pixel layer above the active layer, limited to the selection, and background removal adds a layer mask to the target layer. In a single-layer document, `applyInpaintedImage` and `applyBackgroundRemovedImage` keep today's replace behaviour, now replacing the Background layer's pixels. Both gain an optional `target: 'new-layer' | 'replace'` that overrides the default.

**Selection sampling.** The magic wand and select-by-colour gain `sample: 'composite' | 'active-layer'`. The default, `'composite'`, matches today's behaviour.

## Undo and serialization

**History** stores immutable state objects (the layer tree plus everything else) instead of serialized JSON. Unchanged layers and tiles are shared between entries, as selections are today. The cost of an entry is roughly the tiles it changed.

**Schema version 3** (`toJSON` / `loadImageEditorDocument`):

```ts
{
  version: 3,
  width, height,
  layers: SerializedLayer[],    // tree; pixel layers reference assets
  assets: Record<string, string>, // id → PNG data URL (layer cropped to its bounds), unless external
  activeLayerId, crop, transform, opacity, legacyOutputBlur?, selection
  // develop settings, blur and depth masks live on their layers; annotations are layers
}
```

- Pixel surfaces serialize as one PNG per layer, cropped to its bounds and stored with its offset, which compresses far better than raw tiles. Masks serialize as gray PNG or the existing `r1:` RLE.
- `toJSON({ assets: 'external', store })` lets hosts keep pixels out of the JSON through an `ImageEditorAssetStore { put(blob): Promise<string>; get(ref): Promise<Blob> }`.
- **Backward compatibility.** `migrateSerializedImageEditorState` lifts v1 / v2 into v3:
  - The source becomes the Background layer, carrying the base sliders as its `develop` filter and the depth mask as its parametric mask.
  - `adjustments.layers` become adjustment layers above it.
  - Annotations become annotation layers on top, in their current order.
  - Blur becomes a `blur` filter on the Background, or `legacyOutputBlur` when adjustment layers exist (see above).

  A document that has only that shape (an unpainted Background, then adjustment layers with full-canvas masks, then annotation layers) keeps writing v1 / v2 byte for byte, as v2 does for layer-free states today.
- **API compatibility.** `addAdjustmentLayer`, `updateAdjustmentLayer`, `moveAdjustmentLayer`, `removeAdjustmentLayer`, `toggleAdjustmentLayer`, `clearAdjustmentLayers` and `getAdjustmentLayers` keep their signatures and act on adjustment layers in the stack. New layers go to the top unless an optional `aboveId` / `parentId` is given. `AdjustmentLayersPanel` stays exported in React and Svelte, as a filtered view of the layers panel.

## Agent tools

These are added to the image-editor provider. Each one has a strict schema, a title, all four annotations, and returns what it changed (AGENTS.md §4).

| Tool | Kind | Returns |
|---|---|---|
| `list_layers` | read | Tree: id, type, name, bounds, visible, opacity, fill, blend, clipped, locks, mask summary, active |
| `add_pixel_layer` | write | New id. Empty, solid colour, or from an image (base64 / URL) with offset; `aboveId` / `parentId` |
| `duplicate_layer`, `remove_layer` | write | New id / removed id |
| `move_layer` | write | New index and parent (`aboveId`, `belowId` or `parentId`) |
| `set_layer_properties` | write | The layer after the change (name, visible, opacity, fillOpacity, blend, clipped, locks) |
| `group_layers`, `ungroup_layer` | write | Group id / child ids |
| `merge_down`, `flatten_image` | write | Resulting layer id |
| `offset_layer` | write | New offset and bounds |
| `add_layer_mask`, `apply_layer_mask`, `remove_layer_mask` | write | Mask summary |
| `paint_stroke` | write | Changed bounds and layer id. Takes points in document px, brush settings and target channel; one undo step |
| `fill_pixels`, `clear_pixels` | write | Changed bounds. Selection or whole layer, colour, opacity, blend |
| `layer_via_copy` | write | New id |
| `add_layer_filter`, `update_layer_filter`, `remove_layer_filter` | write | The layer's filter list after the change (`develop` or `blur`); drags commit once |
| `rasterize_layer` | write | Pixel layer id (annotation layer, or pixel layer with filters baked) |
| `render_preview` | read | Gains optional `layerId` (that layer only) |

The existing adjustment-layer tools gain optional `aboveId` / `parentId`. Write tools refuse with the reason on locked or hidden-and-locked targets, unknown ids, or a target channel without a mask, and they validate everything before changing anything.

The change also updates `packages/core/skills/pixerate-image-editor/SKILL.md` (tool rows plus a layers and painting working method), adds the tools to the `command-tools.test.ts` conformance list, and keeps `agent-skills.test.ts` in sync.

## UI (React and Svelte, in parity)

- `LayersPanel`: thumbnails (from mip tiles), drag to reorder and nest, visibility, lock, opacity and fill sliders, blend menu, clipping toggle, mask thumbnail (click to target the mask, Shift-click to disable it), and context-menu operations.
- `BrushOptionsBar`: size, hardness, opacity, flow, smoothing, pressure toggles. Shortcuts: `[` / `]` for size, `Shift+[` / `Shift+]` for hardness, number keys for opacity.
- Foreground and background colour swatches (`D` default, `X` swap).
- Toolbar: Move, Brush, Eraser.
- The demo Image Editor tab shows the panel and registers the new providers in its agent-tools panel. README feature matrix rows are added for layers, painting and (later) PSD.

## Phases

Each phase ships on its own with tests, a changeset, the skill update, README matrix rows and GOTCHAS entries.

1. **Surfaces, model and compositor.** Tiled surfaces, the layer tree, the per-tile compositor with caches, the history refactor, schema v3 and migration. No visible change: single-layer documents render identically, proven by the equivalence tests. Includes benchmarks.
2. **Layer operations.** Controller methods, agent tools, `LayersPanel` in React and Svelte, demo.
3. **Painting.** Brush engine subset, brush / eraser / fill / clear / move, mask painting, `paint_stroke`, options bar.
4. **Integrations.** AI hooks targeting layers, rasterize layer, selection sampling modes, serialization with an external asset store.
5. **PSD read and write** (below).

## PSD on top of layers

The source is photocraft's `crates/psd`. It is a clean-room Rust reader and writer for PSD and PSB (about 13.6 k lines, MIT / Apache-2.0, depending only on `flate2` and `thiserror`). It never panics on malformed input, decodes lazily, and round-trips unmodified files byte for byte. Mapping PSD adjustment blocks to parameters lives in `crates/io/src/adjust_map.rs`, and document import / export in `crates/io/src/psd_import.rs` and `psd_export.rs`.

The plan is to port the needed subset to TypeScript, as earlier photocraft ports were done, rather than ship WebAssembly:

| Port | From |
|---|---|
| Header, layer and mask info, channel data, layer tree, tagged blocks (`luni`, `lsct`, `lyid`, `iOpa`, `clbl`, `lspf`), resources (resolution, ICC) | `header.rs`, `file.rs`, `layer.rs`, `tagged.rs`, `tree.rs`, `resources.rs` |
| Raw, RLE (PackBits), ZIP and ZIP-with-prediction | `compression.rs`, `pixels.rs`. Inflating uses `DecompressionStream('deflate')`, as `import/zip.ts` already does for `deflate-raw`. Writing uses RLE, which is synchronous and what Photoshop writes for 8-bit files. |
| ActionDescriptor read and write (needed by `vibA`, `blwh`, `phfl`) | `descriptor.rs` |
| Adjustment blocks for our ten kinds: `curv`, `levl`, `hue2`, `vibA`, `blnc`, `blwh`, `nvrt`, `post`, `thrs`, `phfl` | `io/src/adjust_map.rs` |
| Builder / writer | `builder.rs`, `io/src/psd_export.rs` |

**Mapping.** Pixel layers, groups (including pass-through), adjustment layers, user masks (rect + default colour → `RasterMask`), clipping, opacity, fill, visibility and 26 of the 27 blend modes map directly.

**Import gaps.** Each of these produces a warning listing the affected layers:
- Type, smart-object, fill and shape layers come in as pixel layers, using the raster Photoshop stores in their channels.
- Layer effects (`lfx2`) are not rendered.
- Dissolve becomes Normal.
- `brit`, `expA`, `mixr`, `grdm`, `selc` and `clrL` adjustments are not supported.
- CMYK, Lab, 16-bit and 32-bit files are converted to 8-bit RGB.
- ICC profiles are ignored.

**Export.** 8-bit RGB PSD (PSB above 30 000 px) with real layers, adjustment layers and masks.
- Layer filters (`develop`, `blur`) and parametric depth masks are baked into their layers' pixels and masks, with a warning. The smart-object follow-up writes `develop` as a Camera Raw smart filter instead, as photocraft does.
- Annotation layers are written as pixel layers in their stack position. The shape and type follow-up writes them as shape and type layers.
- The merged image is our own render, so viewers without a compositor show our result.

**Not in scope.** A lossless round trip of arbitrary PSDs (photocraft keeps every unknown block raw). Opening and re-saving drops what the model doesn't hold, and the warnings say what.

**Agent tools.** `inspect_psd` (read: layer list with mapped / unsupported status), `import_psd` (base64 bytes → created layer ids and warnings) and `export_psd` (base64, size, warnings). The controller gains `loadPsd(bytes)` and `toPsd()`.

## Risks

- **Compositing speed in JS** at 12 MP or more with many layers. Mitigations: prefix cache, dirty tiles, visible tiles only, mips. A Worker is the next step if the phase 1 benchmarks miss the budget (target: under 16 ms per pointer event for a 100 px brush on a 4000 × 3000, 10-layer document).
- **Memory** of full-resolution layers in a browser tab. Mitigations: sparse and uniform tiles, `maxHistoryBytes`.
- **The history refactor** touches every controller method that records history today, so it needs careful tests.
- **8-bit only:** heavy adjustment stacks over painted layers can band. 16-bit tiles are a later format option.

## Implementation notes

What the implementation does differently from the proposal above, and why. Each phase adds its notes here.

### Phase 1 (surfaces, model, compositor, history, schema v3)

**Shared modules.** Phase 1 places the surfaces, codec, blend modes, generic layer types and the compositor engine in `src/raster` (see Module layout), so the paint editor can reuse them without importing the image editor. The compositor was split into the engine and the image editor's profile; the equivalence tests ran unchanged against the split.

**Exact legacy equivalence needs a compatibility route for some old documents.** Compositing in document space and projecting afterwards cannot reproduce the old order of operations in a few cases, so documents that still have the exact v1 / v2 shape (`isLegacyShape`) render through the old base path when one of these holds (`needsLegacyBase` in `layers/render.ts`):

| Case | Why document space can't match it |
|---|---|
| A rotation that is not a quarter turn, or a crop with fractional coordinates | The old path resampled the source first and adjusted the resampled pixels. |
| An enabled depth mask | It was applied after the blur, with the depth map resampled by the canvas through the projection. |
| Output opacity below 1 | Alpha was rounded once by opacity and again by the depth mask, in that order. |
| A Background blur filter with a crop or a 90° / 270° turn | The old box blur clamped at the crop edge and ran on the rotated buffer (its two passes round in a different order after a quarter turn). |
| A migrated `legacyOutputBlur` over a source with transparency | The canvas would premultiply the composite before the blur. |
| An adjustment-layer mask stored at another size than the canvas | It was resampled through the projection on every render; the stack holds a canvas-sized copy. |

Every other document, single-layer or not, renders through the tiled compositor. The equivalence tests (`tests/image-layers-equivalence.test.ts`) compare the old pipeline with the new one on 60 random documents (process 1 and 2 develop settings, up to three random adjustment layers of every kind with random masks, feather, density, blend modes and opacity, blur, crops, quarter turns and flips, sources with and without transparency) and require byte equality for every one the renderer sends to the compositor. A browser check in Chromium compared the two routes' viewport and export canvases (including annotations, rotations, flips, crops and zoom 0.4 to 3.7) and found no differing byte.

**Consecutive adjustment layers are one compositing step.** `applyAdjustmentLayers` runs a stack in float and rounds once, so the compositor groups a run of adjacent adjustment layers into one step. The prefix cache works per step, so a slider drag on one of them restarts at the start of its run.

**Prefix cache and dirty rectangles.** Each tile keeps a checkpoint below the step that changed last and, when the caller names it, below the active layer (`checkpointLayerId`). Callers that know where pixels changed (a stroke's dabs) pass `dirty` rectangles, and changed tiles are then recomposited only there. Neither was spelled out above.

**Benchmarks** (`IMAGE_LAYERS_BENCH=1`, Node 25 on an Apple-silicon (arm64) Mac, 4000 × 3000, 10 layers): a 100 px dab costs 1.5 ms median (2.1 ms p95) with tone-curve adjustments above the painted layer, and 3.7 ms median (4.9 ms p95) with Vibrance and Hue/Saturation above it, so the 16 ms budget holds without a Worker. A first full composite takes 2.9 s / 6.1 s, an unchanged re-render 1 ms, and a slider drag on the top adjustment layer 350 to 400 ms per frame, because it recomposites every tile of the 12 MP canvas. Viewport-only compositing and mip tiles were not needed for the brush budget and are not implemented yet. Slider drags on very large canvases are the place to add them.

**Annotations.** Annotation layers at the top of the stack (plain: visible, opacity 1, normal blend, no mask, not clipped) are still drawn as vectors over the result at screen resolution, exactly as before, so they stay sharp when zoomed. Any other annotation layer is rasterized into the tiles at document resolution with the annotation renderer. An annotation layer with the Normal blend uses its annotation's own `blend`.

**New adjustment layers go below the annotations.** `addAdjustmentLayer` without a position puts the layer above the other adjustment layers (or, without any, above the topmost layer that is not an annotation), so adjustments never tint annotations, as before. `aboveId` / `parentId` place it anywhere.

**Migration API.** `migrateSerializedImageEditorState` keeps its contract (it cleans v1 / v2 states without changing their shape, and existing callers rely on that). The lift into v3 is the new `migrateToLayeredState(data, size)`; `loadJSON` and `initialState` lift any version. `loadImageEditorDocument` reads v3 section by section and treats v2 as current instead of newer.

**PNG and zlib in TypeScript.** Layer assets use a synchronous TypeScript PNG codec (`raster/png.ts`, `raster/zlib.ts`) instead of canvas `toDataURL`: the canvas premultiplies alpha, so partly transparent painted pixels would not round-trip, and `toJSON()` must stay synchronous. Encodings are memoised per surface. The PSD phase can use the same inflate instead of `DecompressionStream`.

**The Background's pixels.** The Background layer of an opened image carries `source: 'document'` and resolves its pixels from the decoded source image (or, without a canvas, from `setSamplePixels`). It writes no asset, so a v3 document with an unpainted Background stays as small as v1.

**Smaller points.** A pixel layer's mask moves with its `offset`. In a clipping group, the base layer's fill opacity also limits the clip shape (Photoshop clips to the base pixels before fill). `list_layers` arrived in phase 1, so the new model had an agent path from the start; the write tools follow in phase 2. `ImageEditorOptions.maxHistoryBytes` (default 512 MiB) bounds the tiles held only by undo steps.

### Phase 2 (layer operations, tools, panel)

**Extra tools.** Besides the tools in the table above, phase 2 adds `set_active_layer` (agents need to pick the layer the base sliders edit), `add_group` (the panel's New Group), `merge_visible` and `set_layer_mask_properties` (any layer's mask density, feather and enabled flag). Each is one operation with its own strict schema.

**Merge Down.** The merged layer keeps the lower layer's name, opacity and blend; the lower layer's mask, fill and filters are baked. As in Photoshop, the result looks the same only when the lower layer is opaque at 100 % normal: a faded lower layer fades the merged content, and an upper blend mode stops seeing what is below the lower layer where that one is transparent. Merges that include annotation layers need a canvas, so outside a browser they refuse and say so.

**Default positions.** New pixel layers and groups go above the active layer (Photoshop's behaviour), or on top when no layer is active. New adjustment layers keep the phase 1 rule (above the others, below annotations).

**Panel model in core.** The row list, drop placement and the layer menu (`layers/panel.ts`) live in core, so the React and Svelte panels share one implementation of the rules.

**Thumbnails** are point-sampled from the tiles (`getLayerThumbnail`) and cached per surface, not built from mip tiles, which do not exist yet.

### Phase 3 (painting)

**Ported subset.** The computed round tip (photocraft's measured Photoshop profile), spacing, pressure to size and opacity, simple exponential smoothing, and opacity-versus-flow build-up. Sampled tips, jitter, scattering, texture, dual brush, wet edges and 8-bit dithering are not ported. Strokes keep a `seed` field for replays, but v1 brushes have no jitter to seed.

**Live strokes.** A `PaintStrokeSession` (from `beginStroke`) recomputes only the part of each tile that the new dabs touch, always from the tile as it was before the stroke, because coverage is cumulative. It hands the changed rectangles to the viewport through the controller's pending dirty list, which any other change resets to "everything". Exports and `compositePixels` therefore use their own compositors, so the viewport compositor's cache only ever holds the viewport's stack (the dirty-rectangle path relies on that).

**Benchmarks with the real stroke engine** (same machine and document as phase 1, a 100 px brush at hardness 0.5, three coalesced samples 4 px apart per pointer event): 5.3 ms median (6.7 ms p95) per event with tone-curve adjustments above the painted layer, and 8.9 ms (10.8 ms p95) with Vibrance and Hue/Saturation above it. Committing the stroke takes 1 to 2 ms.

**Eraser and masks.** On a mask, the brush paints the grey value of its colour, and the eraser paints the background colour (Photoshop's behaviour). On a transparency-locked layer, the eraser also paints the background colour. Fill and Clear follow the same rules. Painting the Background drops its `source: 'document'` flag, so the document is then saved as v3 with the Background as an asset.

**Paint state.** The brush settings and foreground / background colours are view state on the editor state (`state.paint`, `setPaintOptions`). They are not recorded in history or saved, as in Photoshop.

### Phase 4 (integrations)

**What counts as multi-layer.** The AI hooks use the new-layer behaviour when the document has more than one pixel layer or group (`isMultiLayer`). Adjustment and annotation layers don't count: they are edits of the image, and old documents with adjustment layers or annotation scribbles keep the replace behaviour they always had.

**What the hooks see.** In new-layer mode the editor sends the composite of the layers (without annotations, in the source frame) instead of the source image. Otherwise a result built from the original pixels would ignore what was painted on top (`toAIInputDataURL`). In replace mode it still sends the source. Inpainting into a new layer keeps annotation layers (they may be real labels now); the replace mode still clears them, as before.

**Background removal mask.** The result's alpha replaces the target layer's mask, and the target is the active pixel layer or the Background. A result of another size is resampled bilinearly to the canvas, which the old replace path did implicitly by loading a new source.

**Selection sampling.** `composite` (the default) keeps the old behaviour for old-shape documents: the source, or with `sampleMerged` the adjusted image. In layered documents it is the composite of the pixel layers without adjustment layers and filters, or with `sampleMerged` the full composite. `active-layer` reads the active pixel layer alone.

**Rasterize Layer** keeps the layer's id, name, opacity, mask and locks. An annotation's own blend mode becomes the layer's blend when the layer was Normal. Baking a blur filter keeps only the pixels inside the canvas, because the filter clamps there.

**External assets.** `toJSON({ assets: 'external', store })` returns a promise; `store.put` receives each PNG once per store (memoised by content). Loading uses the new `loadJSONAsync(data, { store })`; the synchronous `loadJSON` and `initialState` take inline (data URL) assets only. Old-shape documents have no assets, so they are unaffected.

### Phase 5 (PSD read and write)

**Opening a PSD replaces the document.** `loadPsd(bytes)` / `import_psd` replace the layers, crop and rotation in one undo step, and the document has no source image afterwards: every pixel comes from the layers. Where the renderer needs a source (viewport, export, `renderSourceView`), it draws from a transparent canvas of the document size, so PSDs and v3 documents loaded without an image render. AI hooks default to the new-layer behaviour in such documents. The tool returns the created layer ids as planned, and also the tree.

**The export is in the source frame.** Crop, rotation and flips are not applied to the PSD (a layered PSD has nowhere to keep them), and neither are the document opacity or an old document's output blur. `toPsd` says so in its warnings. Filters are baked with the compositor, parametric masks become pixel masks that keep their density and feather, annotation layers are rasterized in a browser and left out (with a warning) elsewhere, and the merged image is our composite. The resolution of an opened PSD is written back.

**The merged image is matted over white.** Photoshop stores the colour of transparent merged pixels blended over white, which neither the spec nor the plan mentioned. The export mattes, and reading a flat file with alpha (and the corpus comparison) un-mattes.

**Smaller differences from the plan.**
- Inflating uses the synchronous `raster/zlib.ts` from phase 1, not `DecompressionStream`, so import stays synchronous.
- Opacity, fill and mask density come in as whole percents (`round(byte / 255 × 100) / 100`), as Photoshop shows them, so values round-trip.
- When every layer of a file is left out (a file with only unsupported adjustments), the merged image opens as the Background, with a warning, instead of an empty document.
- Artboards and vector masks on pixel layers get warnings of their own. `clbl` (blend clipped layers as a group) is not read; clipped layers always blend one by one.
- A malformed layer rectangle leaves that layer empty, with a warning, instead of failing the file.

**Corpus.** `pnpm test:corpus` fetches 490 files (psd-tools at `b1b454b`, without `third-party-psds/`, and ag-psd at `04d927d`; sha256 per file in `tests/psd-corpus.manifest.json`) into the git-ignored `packages/core/corpus/psd/`. Every file opens. After the matte fix, the median difference between our composite and Photoshop's merged image is 0.09 levels (mean absolute, alpha-weighted), and 298 of the 465 files with layers are within 3 levels. The rest are files with effects, type, unsupported adjustments, artboards and similar. Every file exports and reopens with the same tree and the same pixels. The opt-in test asserts no read errors, the round trip and the median.

## Decisions

1. **Base sliders, blur and depth mask** are handled as photocraft handles them: as filters and masks on layers, not a document-level step. See [Document model](#document-model).
2. **Annotations** are handled as photocraft handles them: they are layers in the stack (`AnnotationLayer`). Real shape and type layers follow after v1.
3. **AI inpainting and background removal** create a new layer or mask only in multi-layer documents. Single-layer documents keep the replace behaviour.
4. **PSD test corpus** comes from public, MIT-licensed fixture sets (below). No local files are used.

## PSD test corpus

| Source | Licence | Contents |
|---|---|---|
| [psd-tools](https://github.com/psd-tools/psd-tools) `tests/psd_files/` | MIT | 316 PSD / PSB files: 0 and 1 layers, 8 / 16 / 32-bit, colour modes, profiles, adjustments, blend modes, masks, group clipping, effects, gradients, transparency |
| [ag-psd](https://github.com/Agamnentzar/ag-psd) `test/` | MIT | 175 files, mostly read-write pairs per feature (adjustments, annotations, blend-if, layer masks, artboards, animation …). photocraft's own corpus used these |

- Fixtures are downloaded by a script into a git-ignored `corpus/psd/` folder, pinned to a commit with checksums, and run by an opt-in `pnpm test:corpus`, the way photocraft's `corpus` feature works. The normal test suite uses small generated files only.
- **Skip `tests/psd_files/third-party-psds/`** from psd-tools. Its name suggests files from other authors whose licence may not be MIT, so check it before use.
- Blender's `tests/files/imbuf_io/reference/psd-*.psd` exist locally in the photocraft download folder, but Blender's test-file licence is unclear, so they are not used.
- Local search found PSDs in `~/Documents` (client and personal work). They are not used, and nothing from them goes into the repo.

## Follow-ups after v1

Each follow-up is its own design note and change, built on the v1 layer stack and tiled surfaces, with agent tools, React / Svelte parity, PSD mapping and tests like v1. Photocraft modules to port from are listed for each.

| Follow-up | Scope | Builds on | photocraft source | PSD |
|---|---|---|---|---|
| **Layer effects** | Drop shadow, inner shadow, outer / inner glow, bevel & emboss, satin, colour / gradient / pattern overlay, stroke. Live, per layer, scaled with the layer; fill opacity excludes effects | Compositor (effects render between layer content and blend) | `doc/src/effects.rs`, `io/src/effects_map.rs` | `lfx2` / `lmfx` read and write |
| **Shape layers** | Vector fill and stroke layers, replacing rect / circle / line / arrow / pen annotation layers. Path editing reuses `@pixerate/editor/vector` | Annotation layers (migrated) | `doc/src/vector.rs`, `io/src/vector_map.rs` | `vscg`, `vsms`, `vogk`, `vstk` |
| **Type layers** | Editable point and paragraph text with character and paragraph styles, replacing text annotation layers | Annotation layers (migrated) | `crates/text`, `io/src/text_import.rs`, `io/src/text_styles_map.rs` | `TySh` and EngineData |
| **Smart objects and smart filters** | Embedded or linked contents, non-destructive transform, a smart-filter stack (the v1 `develop` / `blur` filters move here; Camera Raw mapping) | Free transform; layer filters | `io/src/smart_map.rs`, `io/src/linked.rs`, `io/src/camera_raw_map.rs` | `PlLd`, `SoLd`, `SoLE`, `lnk2` / `lnk3` |
| **Free transform** | Scale, rotate, skew, distort, perspective and warp of pixel layers and selections, with resampling and a live preview | Tiled surfaces | `crates/geom` (transform, `warp.rs`, already partly ported for vector envelopes) | Baked into pixels, or into the smart-object transform |
| **Retouch tools** | Clone stamp, healing brush, spot healing, smudge, mixer brush, dodge / burn / sponge | Brush engine from v1 | `paint/src/retouch.rs`, `mixer.rs`, `replace.rs` | Pixels only |
| **16-bit and float layers** | `Uint16` / `Float32` tile formats, adjustments without banding, high-bit PSD in and out | Tile format field in v1 | `color` (`PixelFormat`, `SampleType`), `io/src/pixels.rs` | 16 / 32-bit channels |
| **Colour management** | Embedded ICC profiles, working space, soft proof, convert to profile, CMYK and Lab documents | 16-bit layers | `crates/cms`, `color/` | ICC resource 1039, colour modes |

**Suggested order.** Layer effects first: they are the most common PSD content lost in v1. Then free transform, which smart objects need. Shape and type layers can run in parallel with free transform. Retouch tools come after that, and 16-bit layers before colour management.
