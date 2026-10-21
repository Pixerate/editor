# Paint editor

`@pixerate/editor/paint-editor` is a digital painting editor in the spirit of Corel Painter, Rebelle and ArtRage: a blank canvas on paper, natural-media brushes, wet paint that flows and dries, thick paint lit by a light, and pigment-like colour mixing. It is its own editor domain, not a mode of the image editor, with its own tools, panels and agent skill (`pixerate-paint-editor`). Underneath, it shares the raster stack and the brush engine with the image editor, so a stroke behaves the same in both and painted layers move between them.

The phases below have all shipped. What is still open is in [outstanding.md](./outstanding.md#paint-editor).

## Modules

| Module | Subpath | Owns |
|---|---|---|
| `src/raster` | `@pixerate/editor/raster` | Tiled copy-on-write surfaces, the layer stack, the per-tile compositor, blend modes (including `pigment` and the painterly modes), the pigment model, viewport helpers |
| `src/paint` | `@pixerate/editor/paint` | The shared brush engine (dabs, coverage, build-up), Mixer Brush and the pick-up / mix exchange, blender and smudge, paper grain, gradient paint (`PaintSource`), path strokes (`paintPathStroke`), the standalone brushstroke renderer, pointer helpers, retouching, `mix_colors` |
| `src/paint/wet` | `@pixerate/editor/paint` | The wet-media simulation: model, TypeScript and WebAssembly SIMD kernels, `WetWorld`, Workers, WebGPU mirror, Kubelka-Munk shading |
| `src/paint-editor` | `@pixerate/editor/paint-editor` | The controller, document, paper library, brush library and engines, guides, stencils, mixing pad, thick paint, stickers, replay, provider effects, agent tools and the UI logic React and Svelte share (`ui.ts`) |

The paint editor adds no storage or compositor of its own. Paper is a compositor content layer, the tracing image is a view-only layer drawn by the viewport only, and documents are saved through the image editor's layer serializer, so the same layer tree opens in both editors.

## Document and canvas

- **Document** (`document.ts`): canvas size and resolution, a paper, and the shared raster layer stack (pixel layers and groups with masks, clipping, locks and blend modes). Layers are immutable and share tiles, so a history entry is a reference to a document state. One stroke is one undo step.
- **Saving** writes JSON plus PNG assets. Thick paint's height and material maps are saved next to the colour (`thick`), and wet settings and recorded wet events are saved, but wet paint itself never is: **saving, PNG / JPEG / WebP and PSD export dry it first**, so a reopened painting is always dry. PSD export maps painterly and `pigment` blend modes to standard ones (`standardBlendMode`) and says what it changed.
- **Paper** (`paper.ts`): a grain pattern with scale, tiling, depth and shading, separate dry and wet grain tuning (contrast, high-pass, invert), colour, and three properties wet media reads: absorption, permeability and roughness. The library has twelve papers in six families (watercolour, drawing, pastel, canvas, panel, smooth), from cold-pressed and hot-pressed to sanded pastel, cotton canvas and gesso.
- **View** (`view.ts`): zoom, pan, rotation and mirroring are view state, so painted pixels never resample. The view is a CSS transform of one full-resolution composite canvas.
- **Pen input** (`input.ts`): pressure, tilt (`tiltX` / `tiltY` or altitude / azimuth), barrel twist and velocity, from coalesced and predicted pointer events. A hand setting (left or right) steers tilt-driven brushes; pressure and position are smoothed separately.

## Brushes

`PaintBrushEngine` (`brushes.ts`) is one of `dab`, `eraser`, `mixer`, `blender`, `smudge`, `wet`, `impasto`, `particle`, `bristle` and `sticker`.

- **Dry media** (`dab`): pencils, pastels, charcoal, markers and inks. The paint editor's own `PenDabWalker` (pressure, tilt, twist, velocity, rotation modes, seeded jitter) feeds the shared `rasterizeDab`, with the paper's grain catching on its peaks, into the shared coverage map and tile writer. Brush rotation is fixed, follows the stroke, or follows the pen's barrel.
- **Blending** (`mixer`, `blender`, `smudge`): the Mixer Brush (a reservoir that picks up and mixes paint, in RGB or pigment), a blender that mixes nearby colours, and smudge. They all go through one pick-up / mix exchange (`paint/exchange.ts`). Brush behaviours add pick-up, mix, dirty brush (keeps the last colour) and multi-coloured brushes.
- **Gradient paint** (`PaintSource`, #273): any engine can paint a gradient sampled per dab by distance, pressure, tilt, speed, direction, time, across the tip or at random.
- **Procedural brushes** (`particle`, #242): `string` (strands of masses on springs), `spring`, `orbit` and `flow` particles, each drawn as dots, a line or a sequence of beads.
- **Bristle brushes** (`bristle`): a tuft of bristles that splay with pressure, flatten with tilt, lag at turns and run dry one by one.
- **Stickers** (`sticker`): procedural stamps (dot, star, heart, leaf, flower, confetti, splat, sparkle, ring) sprayed onto a sticker layer, where each stays an object that can be moved, turned, resized, recoloured or deleted.
- **Library**: built-in presets, saving and removing brushes, JSON import / export and thumbnails rendered from a test stroke.

Every engine is deterministic: jitter is a hash of the stroke's seed and the dab index, and simulations step by distance travelled, not by input sampling. That is what makes replay, undo and agent painting exact.

## Guides, stencils and colour

- **Guides** (`guides.ts`): mirror and kaleidoscope symmetry, perspective guides with one to three vanishing points that strokes snap to, a tracing image under the canvas (with colour sampling) and floating reference images.
- **Stencils** (`stencils.ts`): `ruler` and `arc` guide strokes that start near their edge; `line` and `shape` (rectangle, ellipse, polygon) mask paint. Either kind can switch mode.
- **Colour**: colour harmonies on an RGB or RYB wheel, swatches (including gradient swatches), and a **mixing pad**: a small canvas to paint and smear on with the same engines, then pick from. Pads can be kept and reloaded.
- **Blend modes**: the standard modes, `pigment` (mixes layers as paint), and the painterly `watercolor` (spectral multiply), `tint` (Oklab), `highlight` and `shadow` (#227). They are real B(Cb, Cs) modes in `raster/blend.ts`, so the image editor has them too.

## Pigment mixing model

Blue and yellow make green, not grey (#208). The model is our own, written from the literature, and lives in the shared raster / paint modules so wet media, the Mixer Brush, the mixing pad and the `pigment` blend mode all use it.

1. **Uplift.** Each RGB colour becomes a smooth reflectance spectrum by the sigmoid-polynomial method (Jakob and Hanika, 2019), solved lazily on a 17³ lattice and interpolated trilinearly in linear RGB, which keeps the round trip exact.
2. **Mixing.** Two-constant Kubelka-Munk: K/S = (1 − R)² / 2R per band, scattering equal to luminance (floored at 0.01) times strength, so a little dark pigment tints a lot of white.
3. **Back to RGB** through analytic colour-matching functions (Wyman 2013) under a 6504 K Planckian illuminant. The CIE tables are CC BY-SA, so they are not used.

Cost is about 0.4 µs per pixel. The tuning knob is the scattering exponent (see GOTCHAS, "Pigment Mixing"). Mixbox is not used: it is CC BY-NC with commercial licences from its authors. Repeated KM mixes through 8-bit RGB pixels drift lighter, which is why the wet layer keeps K and S per cell instead of colours.

## Wet media

Watercolour, gouache and oil (`WET_MEDIA`) run on one simulation with different settings (#240, #241).

**Model** (`paint/wet/model.ts`), written from published papers only:
- **Water** is a D2Q9 lattice Boltzmann fluid with partial bounce-back through the paper fibres and a pinned wet front (Chu and Tai, "MoXi", SIGGRAPH 2005). Tilt and flow maps (`none`, `linear`, `swirl`, `radial`, `turbulent`) push it.
- **Paper** soaks water up to its capacity; damp paper stops pinning the front (wet-in-wet). Evaporation is faster along the front, which carries pigment there: edge darkening.
- **Pigment** (Curtis et al., SIGGRAPH 1997) is advected with the water, bleeds between wet cells, settles into grain valleys (granulation), is lifted where water arrives (blooms), and settles completely where a cell dries.
- **Colour** is Kubelka-Munk per cell (absorption K per channel plus one scattering S), so transparent washes multiply like glazes.

**Engine, CPU as the authority:**
- `stepCellsTs` in `kernel.ts` is the specification of one step in exact f32 arithmetic. `assembly/wet.ts` is a lane-for-lane WebAssembly SIMD port with the same bits (`pnpm --filter @pixerate/editor build:wasm` regenerates `kernel-wasm.ts`; a test checks its hash).
- `WetWorld` (`world.ts`) holds up to 8 wet layers ("lanes"), each a sparse set of 256 px tile slots in one `WebAssembly.Memory` (at most 352 slots). It starts on the TypeScript kernel and switches to the wasm kernel once loaded: in Web Workers when the page is cross-origin isolated (COOP / COEP), otherwise on the main thread. All give identical bits.
- **Determinism.** Time is counted in steps, never wall time. Batch boundaries, tile wake-ups and baking are all tied to the step clock, so the result depends only on the edits and when they happened, not on frame rate, worker count or browser.
- Dry tiles are baked into the layer's pixels and their slots freed. `film.ts` shades live tiles for display with deterministic KM.

**WebGPU display mode (Engine B, option A, #267).** With a GPU attached (`attachGpu`, `set_wet_engine` `gpu: "auto"`, from 16 live tiles) the GPU keeps a mirror of the slots: each edit uploads the rows it changed, each batch also runs on the GPU, and `displayGpu` shades every stale tile at once. Between strokes the GPU runs up to 16 steps ahead of the CPU batch in flight (`gpuLead`). The CPU stays the authority for edits, reads, drying, snapshots and saving, so saves are byte-identical with or without a GPU.

**Numbers** (M4 Pro, Chrome, fully wet): wasm with 10 Workers runs 127 steps/s at 2048²; WebGPU runs 795 / 197 / 48 steps/s at 1024² / 2048² / 4096². The GPU path is bandwidth-bound at about 0.82 G cell-steps/s, half the spike's 1.7 G (`spikes/wet-media/RESULTS.md`, PR #215).

**Controls and tools:** dry now, advance, pause, drying speed, add water / wet the paper, blow, canvas tilt for drips, flow maps, a water overlay, re-wetting and lifting.

## Thick paint

A pixel layer can carry a **height** map and a **material** map (gloss and metallic) next to its colour, lit at render time from `PaintLighting` with a Blinn-Phong highlight (`thick.ts`). Relighting never repaints, and only tiles whose inputs changed are relit. Impasto strokes lay colour through the pick-up / mix exchange and raise the height: `brush` (bristle ridges), `tube` (domed blobs), `knife` (scrapes flat while smearing), `roller` and `gloop`. Brushes have paint loading (the paint runs out along a stroke), thinners and an instant-dry toggle, and colours can be metallic.

## Replay and export

Strokes are data (`strokes.ts`), and so are fills, clears, flattened relief and wet events at their simulation clock (`replay.ts`, #241).
- **Time-lapse** repaints the document headlessly and returns PNG frames plus a `VideoProject` of stills, which the video editor's `toVideoFfmpeg` turns into an MP4.
- **High-resolution export** replays at up to 8× scale (points, brush sizes, paper grain), so the picture is painted again with more pixels rather than upscaled.
- What was not recorded as data (imported pixels, merges, layer transforms) is not repeated.

## Beyond the paint editor

- **Brushstrokes on paths.** `paintPathStroke` paints flattened path samples onto a surface, and `renderBrushstroke` with `BrushstrokeCache` (#271, gradient paint in #277) renders a standalone stroke image. The canvas uses them for brushed freehand strokes (#274, #278) and the vector editor for brushstroke stroke layers (#305). #306 added brush character (seeded jitter and paper grain) to the shared renderer. Only dry dab-engine brushes render this way.
- **Paint layers on the infinite canvas** (#275): `raster/viewport.ts` (world ↔ surface mapping, mip levels, `SurfaceViewportRenderer`), `paint/pointer.ts` and `WetWorld.stepRegion`, with a demo recipe in `apps/demo/src/components/CanvasPaintLayerRecipe.tsx`.
- **Provider effects** (#284): effect paper, effect layers, effect fills and light baked into dried paint. See [effects.md](./effects.md).

## Agent path

`createPaintEditorToolProvider` registers about 90 tools: canvas, paper, layers, brushes, colour and strokes; guides, tracing, references, swatches, the mixing pad and stencils; wet media; thick paint; replay; stickers; and `mix_colors`. `createPaintEffectsToolProvider` adds the effects tools. Agents can paint directly on the canvas, with a visible agent cursor (#229).

Stroke-by-stroke painting is a weak fit for a model, so the skill steers agents to what they do well: blocking in shapes and fills, applying a brush or paper across a layer, replaying or varying recorded strokes, washes and glazes, and mixing colours.

## Phases

| Phase | PRs | Shipped |
|---|---|---|
| Pigment model | #208, #210, #211 | Kubelka-Munk mixing, the `pigment` blend mode, the Mixer Brush |
| 1. Domain | #220, #222, #224, #229 | Controller, paper and its library, dry brushes with full pen input, brush library, view rotation, guides, tracing and references, colour harmonies, swatches, mixing pad, React and Svelte components, the demo's Paint tab, agent painting |
| 2. Blending | #227, #233 | Painterly blend modes, blender and smudge, brush behaviours, the pick-up / mix exchange |
| 3. Wet media | #240, #267 | The wet layer, watercolour, the wasm SIMD engine in Workers, then the WebGPU display mode |
| 4–5. Oils and replay | #241 | Thick paint and lighting, oils, paint loading and thinners, drying controls, tilt and drips, time-lapse and high-resolution export |
| 6. Procedural | #242 | Particle and bristle brushes, stickers, stencils |
| 7. Paths | #271, #274, #277, #305, #306 | Brushstrokes on canvas and vector paths through one shared renderer |
| Later | #273, #275, #284 | Gradient paint, canvas paint-layer helpers, provider effects |

## Decisions

1. **Pigment mixing:** our own Kubelka-Munk model, not Mixbox.
2. **GPU:** WebGPU is optional, for wet media display only. Dry painting, thick paint and wet media all work without it.
3. **Wet engine:** option A. The CPU (wasm SIMD) is the authority and the GPU mirrors it for display. Option B, the GPU as the live engine, is deferred (see outstanding.md).
4. **Domain name:** `paint-editor` (`@pixerate/editor/paint-editor`, skill `pixerate-paint-editor`).
5. **Wet paint on save:** dried. Documents never store wet paint.

## Influences

The feature set was shaped by studying Rebelle 8, ArtRage for iPad and Corel Painter's engine as shipped inside CorelDRAW 2026. Only bundle layouts, licence files, resource folder names and UI or symbol strings were read. Nothing was decompiled, and no code, presets, textures or numbers were copied. From them came the wet-media control set, paper split into absorption, permeability and roughness, flow maps, granulation and glazing, painterly blend modes, thick-paint tools, paint loading and thinners, metallic paint, the mixing pad, particle and bristle brushes, sticker spray, stencils, hand setting, separate pressure smoothing, resolution-independent export and brushstrokes on vector paths. Rebelle's licence file showed it licenses Mixbox commercially, which confirmed writing our own pigment model.

**Ideas from them that are not built:**

| Idea | Seen in | Notes |
|---|---|---|
| Cheaper RYB mixing mode | Rebelle (`rybMode`) | RYB exists only as a harmony wheel. A fallback if the spectral model is ever too slow |
| Ray-traced soft shadows on thick paint | Rebelle Pro | Thick paint has diffuse and specular light only |
| Deckled paper borders, glitter | Rebelle, ArtRage | Cosmetic |
| Separate screen and print paper presets | Rebelle | |
| Brushstroke from a mask edge, reverse brushstroke | CorelDRAW Painterly Brush | Vector brushstrokes follow paths only |
| Wet, mixer and smudge brushes on paths | CorelDRAW | Need paint under the stroke (see outstanding.md) |
