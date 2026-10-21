# Outstanding work

The one list of what is **not done** in `@pixerate/editor`, written after the image, paint, vector, canvas and effects tracks finished (October 2026). Everything else described in `docs/` has shipped. Each item has a reason, a size (S, M, L, as in the vector roadmap) and where it would go.

The video editor keeps its own list in [video-editor-follow-ups.md](./video-editor-follow-ups.md), which is still current. Provider effects in the video editor (#276) shipped after it was written.

## Deferred by decision

These were considered and put off on purpose. Revisit only with a real need.

| Item | Why deferred | Size | Where |
|---|---|:---:|---|
| **Direct CMYK value editing** in the image editor | CMYK and Lab are RGB-proxy modes: pixels stay RGB in the working space and are converted on proof and export. Editing real CMYK numbers needs a CMYK-plus-alpha tile format through the compositor, every paint and retouch tool, PSD and JSON. Proxy mode with soft proofing, `convert_colors` and 16-bit CMYK export covers print work. A cheap step towards it: pick paint colours by CMYK numbers (a `set_foreground_cmyk` tool and CMYK inputs in the colour UI) | L | `src/raster` tile format, `src/image-editor`, `src/cms` |
| **Wet engine option B** (GPU as the live simulation) | Option A shipped: the CPU is the authority and the GPU mirrors it for display, so saves are identical with or without a GPU. Option B would only help very large, fully wet canvases. It needs async pick-up readback, the live picture could differ from the saved one by up to 1/255, and saving would wait for a CPU replay | L | `src/paint/wet/gpu.ts`, `world.ts` |
| **Vector networks** | Every vector tool, effect and exporter is built on subpaths; the main benefit (filling regions between crossing strokes) is covered by Shape Builder and the paint bucket. See [vector-roadmap.md](./vector-roadmap.md#vector-networks-deferred) | L+ | `src/vector`, as an optional node type |
| **Whether to drop CJS** | Halves the published JavaScript and type declarations, but it is a breaking change for `require` users and needs a major version. Kept out of the [build memory and package size work](./build-memory-and-package-size-plan.md), which is done | S (code), major release | `packages/*/package.json`, `tsup.config.ts` |
| **Vector collaboration** | Only worth doing if the editor goes multi-user | L | `src/vector` (fractional indices, per-user undo) |

## Known limits

Shipped behaviour with a documented gap.

| Limit | Why | Size to fix | Where |
|---|---|:---:|---|
| A **fading block (long) shadow is drawn solid in PDF** | It is a gradient with stop opacity, and PDF shadings have no stop opacity. The export says so in its `notes`. A soft mask (`SMask`) with a luminosity shading would fix it | S | `src/vector/pdf.ts` |
| **Brushstrokes are left out of Lottie** | They are raster images, which Lottie shape layers can't hold. The export notes it. They could go out as image layers | S–M | `src/vector/lottie.ts` |
| Other **vector export notes** | PDF and Lottie leave out filters and opacity masks; Lottie draws lenses and path effects without an equivalent as their result. See the PDF and Lottie sections of [vector-editor.md](./vector-editor.md#pdf) | — | `src/vector/pdf.ts`, `lottie.ts` |
| The **Flair paint agent script** is checked in a browser only | It needs a real WebGL context and the Flair catalog, which CI does not have (Flair is a devDependency of the demo only). #284 ran it by hand in the built demo | S–M (a headless GPU job) | `apps/demo`, CI |
| **Brushstrokes on paths are dry only** (canvas and vector) | Wet, mixer, smudge and blender brushes need paint under the stroke, which a standalone stroke image doesn't have. The renderer refuses them | M | `src/paint/brushstroke.ts` |
| **Vector brushstrokes paint one colour** | A gradient paint gives its middle colour, though the shared renderer takes a `PaintSource` since #277 | S | `src/vector/brushstroke.ts` |
| **`WetWorld` has a fixed extent** (at most 8 wet layers and 352 tile slots) | It holds its slots in one `WebAssembly.Memory`. Water that spreads past the slots is lost, and a canvas paint layer can't be fully unbounded. A `paintWetPath` helper would also shorten the demo recipe | M | `src/paint/wet/world.ts` |
| **Some image work stays 8-bit** | Smart object contents and smart filters (including effect filters) render at 8 bits, annotation layers are drawn at 8 bits, retouching on a mask is 8-bit on the pixels it changes, and effect maps come from the 8-bit shape. The viewport is 8-bit by design | M each | `src/image-editor/layers/smart.ts`, `layers/compositor.ts` |
| **PSD import gaps** | Six adjustment kinds (Brightness / Contrast, Exposure, Channel Mixer, Gradient Map, Selective Color, Color Lookup), Dissolve, `clbl`, artboards, vector masks on pixel layers, fill layers, external linked files, multi-patch warps on export. Each has a warning. See [PSD today](./image-editor-layers.md#psd-today) | S–M each | `src/image-editor/psd` |
| **Painterly blend modes are written to PSD as Normal without a warning** by the image editor | Its export maps through `BLEND_TO_PSD` and warns only for `pigment`. The paint editor already uses `standardBlendMode` and reports it | S | `src/image-editor` PSD export |
| **Svelte has no prompt-editor wrapper** | README rows for `usePromptEditor` say "Via core" for Svelte (footnote ¹). A parity gap under AGENTS.md §3 | M | `packages/svelte` |
| **`moduleResolution: "node"` (node10) consumers can't see subpath types for core**, and React and Svelte's `typesVersions` miss `effects` | `exports` is what `bundler` and `node16` read, and `pnpm check:packages` checks those for every subpath. node10 ignores `exports` and needs a `typesVersions` entry per subpath, which core never had | S | `packages/*/package.json`, `scripts/check-packages.mjs` |
| **Canvas paint-layer helpers have no agent tool** | `raster/viewport.ts`, `paint/pointer.ts` and `WetWorld.stepRegion` are building blocks for a host's own paint layer, not an editor feature. Agents draw brushed strokes through `canvas.drawFreehand` instead | — | — |

## Smaller follow-ups found in the code and PRs

### Image editor

- **Free Transform:** groups transform as a whole (refused today); filling the hole with the background colour when a selection on the Background moves (it is left transparent); Content-Aware Scale and Puppet Warp; a perspective-exact warp mesh overlay (the overlay is approximate for perspective corners; the resample is exact). M each, `image-editor/free-transform.ts`.
- **Smart objects:** multi-patch warps in PSD (`quiltSliceX/Y`), Photoshop's Cylinder warp, Camera Raw → `develop` mapping, drawing more Photoshop smart filters (Gaussian Blur and so on), stack modes, a linked filter mask that follows warps, and filter-mask painting that recomposites the whole canvas per stroke update (slow on big canvases). S–M each, `layers/smart.ts`, `psd/smart.ts`.
- **Layer effects:** Blend Interior Effects as Group and Transparency Shapes Layer, gradient smoothness baking, and vector outlines for the stroke effect on shape layers. S–M each, `raster/effects`.
- **Shape and type layers:** text on a path, vertical type and text warps; on-canvas anchor editing for shapes; Photoshop polygon and star `vogk` keys; "Align Edges" for 1 px strokes. See [Follow-ups](./image-editor-shape-type-layers.md#follow-ups).
- **Text editing:** the image editor's `TextEditSession` and the vector editor's text editing could share one caret model. S, `src/text`.
- **Viewport compositing:** slider drags on very large canvases recomposite every tile. Viewport-only compositing with the mip levels from `raster/viewport.ts` would fix it; neither the image nor the paint editor uses them yet. M.

### Paint editor

- **`stroke_path` tool:** the design planned one to paint a vector path onto a layer. `paintPathStroke` exists in `@pixerate/editor/paint`, but no paint-editor tool or UI uses it. S–M, `paint-editor/tools.ts`.
- **Wet engine performance:** shading in the wasm Workers for machines without WebGPU (display shading is TypeScript today, about 1.5 ms per tile); f16 storage for wet state; a slimmer GPU layout (drop the ping-ponged velocity, edge and paper water) to approach the spike's 1.7 G cell-steps/s. M each, `src/paint/wet`.
- **Stale comments:** `paint-editor/paper.ts:3` and `:38` and `document.ts:44` call wet media and time-lapse "later", and `serialize.ts:8` and `:34–36` plan `layerChannels`, though thick paint is saved under `thick`. S.
- **Unbuilt ideas** from the products studied (RYB mixing, soft shadows on thick paint, deckled borders): see [paint-editor.md](./paint-editor.md#influences).

### Vector editor

- **Merge overlapping pencil strokes** (CorelDRAW LiveSketch). S, optional. See [vector-roadmap.md](./vector-roadmap.md#leftovers).
- **Vertical text** and text on the gradient tool's annotator. M, `src/vector`, `src/text`.

### Tests and CI

These tests are opt-in and don't run in CI: the PSD corpus (`pnpm test:corpus`), the wet-media GPU tests (`WET_GPU`, Dawn installed outside the repo), the ffmpeg render tests when ffmpeg is missing, the wet look renders (`OUT`), and the benchmarks (`IMAGE_LAYERS_BENCH`, `DEEP_BENCH`, `WET_BENCH`, `SPREADSHEET_BENCH`, transform bench). There are no unconditional skips or `todo` tests. Running the corpus and the GPU tests on a schedule would catch regressions there. S–M.

## Skills with out-of-date prose

`tests/agent-skills.test.ts` keeps the tool tables in step with the code, but it can't check advice. These need a reread:

- **`pixerate-image-editor`:**
  - The `export_psd` row says it saves "an RGB PSD". It writes CMYK or Lab channels after `set_color_mode`, as the skill says further down.
  - It lists only Pigment blends as written as Normal; the painterly modes are too.
  - The description doesn't mention Blur, Sharpen, History Brush, 16 / 32-bit, colour management or provider effects.
  - The body is at the 500-line limit the test enforces, so the next tool rows need prose moved into `references/` first.
- **`pixerate-paint-editor`:** accurate, but it doesn't say that wet media holds at most 352 tiles, or that multi-threaded wet media needs a cross-origin isolated page (COOP / COEP) and runs on one thread otherwise.
- **`pixerate-vector`:** will need the brush-character rows once the in-flight vector change lands (that change includes the update).
