# @pixerate/editor

## 0.223.0

### Minor Changes

- 6ae71cc: Hosts that build their own image editor sidebar from `layerPanels` now get every selection and masking panel the editor's own `ImageEditor` shows, and agents find workflow skills from discovery.

  - **Panels:** `layerPanels` adds `channels` and `paths` after `selection` for every layer and with none, and shows `mask` ("Mask & Edges") for a layer with a painted or a vector mask. Svelte's `LayerPanel` renders them: `selection` now includes Refine Edge (Check Edge, Show Last Change, Separate Subject, only uncertain areas), `channels` the Channels panel, `paths` the Paths panel, and `mask` the vector mask's soft edges and the layer's Edge Colour. Before, `mask` rendered a placeholder.
  - **Tool panels:** `imageToolPanel` maps the Pen, Path Selection and Direct Selection tools to `paths`.
  - **Playback:** `compare_selections`, the selection recipe tools, `freeze_selection` and `separate_subject` play in the Select panel, and `set_edge_*` in Layers. A test now fails when a new write tool has no playback panel.
  - **Workflow skills in discovery:** `listSkills` reads `metadata.kind` and `metadata.reference` (`SkillInfo.kind`, `SkillInfo.reference`; `parseSkillFrontmatter` returns `metadata`). `list_toolsets` lists each toolset's workflow skills as `workflows`, and `get_skill` and `pixerate-agent-tools` say to read the one that matches the job.
  - **Skill evals for agent harnesses:** the workflow skill eval runner is exported from `@pixerate/editor/tools`: `listSkillEvals`, `imageEvalFixturePixels`, `callEvalTool`, `failedEvalChecks`, `matchesEvalExpectation` and the `SkillEval` types. An app runs the same `evals/*.json` with its own agent in place of the known-good solution.

## 0.222.3

### Patch Changes

- de331fc: Three new video workflow skills, each with evals: `pixerate-video-social-cut` (vertical and square reframes, the hook first, platform lengths, titles in the safe area), `pixerate-video-colour-grade` (correct and match shots, one look on an adjustment clip, LUTs with skin protected) and `pixerate-video-montage` (selects on the beat, pacing, transitions with handles, music and the ending). Skill evals can now start from a video project.

## 0.222.2

### Patch Changes

- d05e3aa: Three new paint workflow skills, each with evals: `pixerate-paint-watercolour` (paper, light to dark, wet-in-wet and wet-on-dry, drying before glazing), `pixerate-paint-oil-impasto` (toned ground, thin to thick, pigment mixing, impasto relief and light) and `pixerate-paint-sketch-to-finish` (sketch, ink, flats, clipped shading and light). `pixerate-paint-editor` is back under 450 lines, with the wet media and oil detail in `references/wet-media.md` and `references/oils.md`. Skill evals can now start from a paint canvas.

## 0.222.1

### Patch Changes

- 1f0ff66: Three new vector workflow skills, each with evals: `pixerate-vector-icon-set` (one grid, padding, stroke, caps and radius across a set, crisp coordinates, symbols, SVG), `pixerate-vector-logo` (marks from live booleans, optical corrections, an aligned lockup, colour variants as symbols, outlined delivery files) and `pixerate-vector-illustration` (block in back to front, gradients and stacked fills, masks, blends, subtle shadows). `pixerate-vector` is back under 450 lines, with its drawing best practices in `references/best-practices.md`. Skill evals can now start from vector artwork and check with read-only commands such as `vector.list`.

## 0.222.0

### Minor Changes

- 36aa7fe: Three new image workflow skills: `pixerate-image-photo-correction` (frame, light, colour, local, look, each checked for clipping and neutral greys), `pixerate-image-portrait-retouch` (blemishes, stray hairs, dodge and burn, eyes and teeth on their own layers) and `pixerate-image-product-photo` (product on white, a grounding shadow, centred marketplace crops), each with evals. `pixerate-image-editor` is back under 450 lines: its correction, effect, transform and smart object advice moved into the workflow skills and its reference files.

  New agent tool `measure_region`: measures a rectangle of the composited image without a render (the histogram summary plus the mean colour and a red-blue and green-magenta cast), so agents can check a neutral reference, skin or a background, and so checks work where `render_preview` cannot.

## 0.221.1

### Patch Changes

- ef9f3e9: Workflow skills get their own checks, a template and evals, and there is a new one: `pixerate-spreadsheet-clean-import`, which teaches agents to turn imported or pasted data into tidy data (structure, headers, currency and comma decimals, day-first dates, leading zeros, missing values, duplicates, validation). Each workflow skill now ships scenarios in `evals/*.json` (task, starting document, checks and a known-good solution). The reference skills for the image editor, spreadsheet and video editor list their workflow skills, and `skills/README.md` has separate tables for reference and workflow skills.

  `inspect_mask_edge` no longer counts anti-aliasing as softness: `softFraction` measures only transitions wider than about 2 px, so a clean Magic Wand or ellipse selection of a hard-edged object no longer reports "Very soft".

## 0.221.0

### Minor Changes

- 948eb43: Live selections, a prototype of #392 item B. A selection now keeps its recipe, the steps that made it, beside its bitmap. The bitmap is still what every other command uses.

  **Recording:** each of these commands records a JSON step when it changes the selection:
  - marquees and polygons
  - the magic wand
  - Color Range and its presets
  - Select All and Inverse
  - modify
  - a plain colour refine

  A replacing shape starts a new recipe. Any other change drops the recipe, leaving the selection frozen: quick, object, subject, sky and focus selections, Quick Mask painting, loaded masks and channels, or refining with edits.

  **Editing:** `get_selection_recipe`, `edit_selection_step`, `insert_selection_step`, `remove_selection_step` and `freeze_selection` (plus the matching controller methods and `setSelectionRecipe`) change a step and replay the recipe from scratch as one undo step. Steps are checked first and nothing changes on an error.

  **Saving:** recipes are part of undo history and saved in documents.

  **Core:** `readRecipeStep`, `replaySelectionRecipe`, `describeRecipeStep` and `recipeStepSetting`.

  **React and Svelte:** `SelectionRecipePanel` (Selection steps in the Selection panel) lists the steps, edits each one's mode and main setting, removes steps and freezes.

## 0.220.0

### Minor Changes

- 0253e7d: Hybrid vector masks (#392, item 1). Each segment of a vector mask can now have its own edge, so one mask can hold sharp sides and hair:
  - **`hard`** (the default) is the path's own edge.
  - **`feather`** blurs across the curve by `radius` px.
  - **`matte`** solves a corridor from `inner` px inside to `outer` px outside the path. It uses the colour-guided filter against the layer's own pixels (the Background's come from the source image).

  Where modes meet they blend over a few pixels, with no seam. The work happens only in tiles along the path, so a 12 MP mask with soft edges renders in a few hundred ms. It's cached with the layer.

  **API changes:**
  - **Model:** `VectorMask.edges`.
  - **Core:** `hybridVectorMaskCoverage` and `validVectorMaskEdges`.
  - **Controller:** `controller.setVectorMaskEdge`.
  - **Agent tool:** `set_vector_mask_edge`. `get_vector_mask` now also returns `edges` and `segmentCount`.
  - **Other tools:** `inspect_mask_edge`, `compare_selections` and rasterizing see the hybrid coverage.

  **Saving:**
  - Edges are saved in documents.
  - They're dropped when a new path no longer has their segment.
  - PSD export bakes a hybrid mask into the pixel mask, with a warning.

  **Canvas:** Alt+Shift-click a vector mask segment with Direct Selection to cycle hard → feather → matte. Feathered segments are drawn amber and dashed, matte ones magenta.

  **React and Svelte:** a `VectorMaskEdgesPanel` in the Layers panel lists the soft edges and edits their settings.

## 0.219.2

### Patch Changes

- 11c5222: Object Selection without a model: a click on a small object inside a large region of another colour (a boulder in a river, a tree in a forest) no longer selects the region. When the first search runs into the band around it, a cut from a small disk at the click is kept, and used if the search ends up reaching three sides of the image. Checked on the demo's photos: clicks on a boulder and a tree in the lake photo now select just them (before: the whole image).

## 0.219.1

### Patch Changes

- 7835e34: Object Selection without a model (GrabCut): a click now learns the object's colours from a disk around the click instead of the whole search window. A click on an object whose surroundings reach the window's edge (a castle in mist on a hill) no longer selects the whole image, and a click on a fruit no longer takes its shadow. An object smaller than the disk is re-seeded from what was found. On the new synthetic evaluation, mean IoU over 15 box and click cases rises from 0.785 to 0.934, and the castle clicks take about 75 ms instead of 1.5 s. Box selection is unchanged.

## 0.219.0

### Minor Changes

- 57e639d: Separate Subject (#392, item 3). The new `separate_subject` tool and `controller.separateSubject({ layerId, dilate, fill, seed, signal, onProgress })` split the selected subject from its background in one undo step:
  - **Subject layer:** a copy of the layer masked by the selection, placed on top and made active.
  - **Background plate:** a second copy with the subject's area, grown by `dilate` (default 8 px), Content-Aware Filled. With `fill: 'none'` the area is left transparent instead.
  - **Fill area channel:** an alpha channel marking the filled area, so a bad patch can be loaded and filled again.
  - **Source layer:** hidden.

  The fill is computed before anything changes, so cancelling leaves the document as it was. The same `seed` gives the same plate.

  React and Svelte add `SeparateSubjectPanel` (Separate Subject in the Refine Edge panel), with a grow amount, a fill on/off option, progress and Cancel.

  Content-Aware Fill now reports real progress while it fills, weighted by each level's size, instead of jumping from 0% to done. `contentAwareFill` takes an `onProgress` option.

## 0.218.1

### Patch Changes

- e553890: Two fixes:
  - **Marching ants:** they now march along diagonal and curved selection edges, instead of the whole line flashing. The outline is stroked as joined paths (`selectionOutlinePaths`), so the dash pattern no longer restarts at every one-pixel step.
  - **Crop on load:** an image that loads after the crop tool was opened now starts uncropped. A whole-image crop made at the placeholder size grows to the image's real size, and a real crop is kept as it is.

## 0.218.0

### Minor Changes

- ded4294: `extendCanvas` (and `extend_canvas`) keeps wet paint wet when `left` and `top` are whole 256 px tiles: the wet simulation moves with the picture and flows on exactly as if the canvas had not grown, so a host that grows a canvas while someone paints no longer dries their strokes and stops them mixing. Other shifts still dry the paint first. Adds `moveWetSnapshot` (`@pixerate/editor/paint`) and `PaintWetLayers.canExtend` / `extend`.

## 0.217.0

### Minor Changes

- 25e8142: Compare two selections (#392, item D).

  **What it does:** the new `compare_selections` tool and `controller.compareSelections(a, b, { minArea, show })` report what changed between two selections. Each of `a` and `b` can be:
  - the current selection
  - the selection a number of undo steps back (`a` defaults to one step back)
  - a saved channel
  - a layer's painted or vector mask

  **What it returns:**
  - the added and removed area, with the largest pieces and their bounds
  - the IoU
  - the coverage change, which also catches edges that only softened
  - whether the two are identical

  **On the canvas:** with `show` (the default), added area is tinted green and removed area red until the selection next changes. This is view state only, with no undo step. `controller.clearSelectionDiff()` hides it.

  **Core:** `compareSelectionMasks`, `selectionDiffPixels` and `controller.selectionFrom(source)`.

  **React and Svelte:** a "Show Last Change" button (`SelectionChangeCheck`) in the Refine Edge panel.

## 0.216.0

### Minor Changes

- 8845aa3: Smart selections report where they are unsure, and refinement can work only there (#392, item C).

  - **New results:** `select_subject`, `select_object`, `select_sky` and `quick_select` now also return:
    - `uncertainRegions`: up to 20 regions with bounds, area and confidence, least confident first
    - `uncertainCount`
    - `edgeConfidence`

    These are the stretches of the new selection's edge with no image edge under them.

  - **Core:** `controller.selectionUncertainty()` and the pure `selectionUncertainty(mask, pixels)` return the trimap's unknown band as a mask plus the regions.
  - **Refine:** `refine_selection` and `refineSelectionTo` take `regions` (rectangles) and refine only inside them, leaving the rest of the selection as it was. Regions that miss the image are rejected before anything changes.
  - **React and Svelte:** the Refine Edge panel adds "Only uncertain areas".

## 0.215.0

### Minor Changes

- 2b2558e: Live edge colour on a cutout (#392, item 2). These are layer properties applied when compositing, so nothing is baked:
  - **Decontamination:** unmixes the old background from a soft mask edge. It uses the pixels the mask hides.
  - **Despill:** takes the old background's hue out of the edge and keeps luminance. It's a heuristic and leaves bounced light alone.
  - **Live cast:** tints the edge with what is behind the layer, sampled live, or with a fixed colour.

  API changes:
  - **Core:** a generic `LayerEdgeColor` (`layer.edge`) in the raster engine. The 8-bit and 16/32-bit compositors apply the live cast. Decontamination and despill run with the layer's own filters, over the canvas (`applyEdgeUnmix`, `despillEdge`).
  - **Controller:** `getEdgeColor` and `setEdgeColor`, which validate before changing anything and record one undo step.
  - **Agent tools:** `get_edge_color`, `set_edge_decontamination`, `set_edge_despill` and `set_edge_ambient`.
  - **Documents:** settings are saved in documents. PSD export bakes decontamination and despill into the pixels and warns that the live cast is left out.
  - **React and Svelte:** an `EdgeColorPanel` (Edge Colour in the Layers panel) with one undo step per slider drag.

## 0.214.0

### Minor Changes

- 2e75a6a: Measure a mask's edge without looking at it (#392, item A). The new read-only `inspect_mask_edge` tool and `controller.inspectMaskEdge(target, { layerId, minArea })` report on the selection, a layer's painted mask or its vector mask:
  - `haloScore`: old background left just inside the edge
  - `edgeAlignment`: the share of the edge on strong image edges
  - `jaggedness`: outline turning beyond what closing it needs, per 100 px
  - `softFraction`
  - `holes` and `islands`
  - up to five `worst` regions, ready for `capture_view`
  - `issues` with suggested fixes, judged against `MASK_EDGE_THRESHOLDS`

  The analysis is the pure `inspectMaskEdge(mask, pixels)` in core. React and Svelte add `MaskEdgeCheck` (a Check Edge button with the scores and findings) to the Refine Edge panel. The masking workflow skill now measures the edge before and after cleanup.

## 0.213.0

### Minor Changes

- 1461fa9: On-canvas path editing: the Pen (`path-pen`), Path Selection (`path-select`) and Direct Selection (`direct-select`) tools edit the active path, the active shape layer or the active layer's vector mask. Drag anchors, handles and segments (each drag one undo step), select with a marquee or Shift, Alt-click to convert an anchor, Delete removes selected anchors; the Pen draws new subpaths (a new Work Path when nothing is targeted), drags out handles, closes on the first anchor and adds or deletes anchors on an existing path. Core adds `PathEditGesture`, `RenderOptions.pathEdit`, and `pathEditTarget`, `getPathEditComponents`, `setPathEditComponents` and `startWorkPath` on the controller. Both canvases route the tools and draw the overlay, the editors' Annotations tab offers them, and clicking empty space in the Paths panel deselects the path.

## 0.212.0

### Minor Changes

- 87ab257: Content-Aware Fill can output to a duplicate layer. `output: 'duplicate-layer'` paints the fill into a copy of the layer, above it, as one undo step; this is in `content_aware_fill`, the controller (`ContentAwareFillOutput`) and the workspace's Output To.

  The workspace's sampling area can now be painted anywhere in the image. Images up to 4 MP show whole; on larger ones the view starts with room around the selection of twice its larger side, at least 256 px each way, and Expand View (`ContentAwareFillSession.expandView`) doubles it up to the whole image, keeping what was painted.

## 0.211.0

### Minor Changes

- a977596: Document paths and a Paths panel for the image editor. Paths are vector outlines kept with the document but on no layer: the Work Path, which Make Work Path traces from the selection and replaces each time until it's saved, and saved paths.

  - **What you can do with one:** load it as a selection (Shift adds, Alt subtracts), fill or stroke it on a pixel layer without touching the selection, turn it into a vector mask, rename it (renaming saves the Work Path), duplicate or delete it.
  - **Saved with the document:** paths are in undo history, `toJSON` and PSD files, as image resources 2000–2997 for saved paths and 1025 for the Work Path.
  - **UI:** `<PathsPanel>` in React and Svelte shows outline thumbnails, under Channels.
  - **Agent tools:** `list_paths`, `get_path`, `make_work_path`, `add_path`, `set_path_geometry`, `rename_path`, `duplicate_path`, `delete_path`, `fill_path` and `stroke_path`. `path_to_selection` and `add_vector_mask` take a `pathId`.
  - **Controller:** `getPaths`, `getPath`, `setActivePath`, `makeWorkPath`, `addPath`, `setPathGeometry`, `renamePath`, `duplicatePath`, `deletePath`, `loadPathAsSelection`, `fillPath`, `strokePath` and `addVectorMaskFromPath`.
  - **Other new exports:** `DocumentPath`, `pathSvgData`, `pathBounds`, `readPaths`, `serializePaths` and `readShapeComponents`.

- 35d0860: Quick Selection grows while you drag. As the brush moves, the stroke so far is computed (in the selection worker when there is one; one at a time, catching up with the newest points) and shown in place of the selection. That uses the new `controller.setSelectionPreview` and the renderer's `state.selectionPreview`, which are view state only, with no undo step and nothing saved. Releasing applies the stroke as one undo step, as before; cancelling drops the preview. The gesture's `draftPath` for Quick Selection is now `null` (the live result replaces the brush path), and `previewed` resolves once a preview has caught up.

### Patch Changes

- 5945227: PSD export now writes a vector mask's density and feather into the layer's mask record, as Photoshop does, so they survive a round trip. A layer with only a vector mask gets a mask record that carries just those parameters, and no raster mask appears when it's read back. Before this, they were left out with a warning.
- 5a0abd9: Select and Mask's On Layers view now shows the visible layers below the active layer where nothing is selected, as Photoshop does, instead of a checkerboard. It falls back to the checkerboard where those layers are transparent, or when there are none.

## 0.210.0

### Minor Changes

- 3654142: The Content-Aware Fill workspace. React and Svelte add `<ContentAwareFillWorkspace>`, which opens from "Content-Aware Fill…" in the selection options bar when something is selected.

  - **Source view:** the selection's surroundings, with the sampling area (where the fill may copy from) in green.
  - **Sampling area:** painted with the Sampling Brush (Alt subtracts), or set with the Auto and Rectangular presets.
  - **Preview:** a live preview next to the source view.
  - **Fill settings:** Seed with Try Another, Output To (new or current layer), Live Preview, and Hand and Zoom.
  - **OK and Cancel:** OK fills as one undo step; Cancel and Escape change nothing.

  The core holds the logic in `ContentAwareFillSession`. The engine's `contentAwareFill` gains `exclude`, pixels no source patch may cover. Agents get the same choice through `content_aware_fill` with `sampleRects`, `excludeRects` and `samplingChannelId`, and the tool now runs in the selection worker when there is one. Also new on the controller: the `samplingArea` option, `prepareContentAwareFill`, `previewContentAwareFill` (no changes made) and `contentAwareFillAsync`, plus the `ContentAwareFillPlan` type.

## 0.209.0

### Minor Changes

- 51d0d6e: Select and Mask can output to a new document. `refine_selection` and `refineSelectionTo` gain two outputs:

  - `new-document`: the cut-out pixels on transparency.
  - `new-document-with-mask`: a copy of the layer masked by the selection.

  Both can be decontaminated. The editor builds a one-layer document the size of the image with the new `controller.documentFromSelection`, which also works on its own, and hands it to the host's document opener: the `openDocument` option or `setDocumentOpener`, a `DocumentOpener` taking `(document, { name, from })` that may return an id. The current document doesn't change and gets no undo step. The result carries `documentId`. Without an opener, these outputs are refused with the reason and hidden in the React and Svelte Refine Edge panel and the Select and Mask workspace; `canOpenDocuments` tells which applies. `REFINE_OUTPUTS` marks them with `needsDocuments`. The demo downloads the new document as a file.

## 0.208.0

### Minor Changes

- e3f1c08: The long selections can run in a Web Worker, and they report progress and can be cancelled. This covers Select Subject without a model, Object Selection, Focus Area, Select Sky, Quick Selection strokes and the Select and Mask preview.

  - **Using a worker:** pass a factory as the `selectionWorker` option or to `controller.setSelectionWorker`, e.g. with Vite `import SelectionWorker from '@pixerate/editor/image-editor/selection-worker?worker'` and `() => new SelectionWorker()`. The new `./image-editor/selection-worker` entry starts the worker side. Without a worker, the jobs run on the page as before.
  - **Images:** the image is sent to the worker once per pixel buffer and kept there.
  - **Progress:** the algorithms report their stages through `onProgress` (`SelectionProgress`). The controller methods accept `onProgress` and `signal`.
  - **Cancelling:** cancelling terminates the worker and rejects with an `AbortError`, leaving the selection unchanged; the next job starts a fresh worker. The agent tools pass the tool call's signal.
  - **UI:** React and Svelte show a progress bar with the current stage and a Cancel button for Select Subject, Select Sky and Focus Area. The Select and Mask workspace shows "Updating preview…" while the worker computes it.
  - **New exports:** `SelectionWorkerClient`, `startSelectionWorker`, `runSelectionJob`, `serializeMask`, `deserializeMask`, `controller.runSelectionJob` and `hasSelectionWorker`, and the types `SelectionJob`, `SelectionJobResult`, `SelectionWorkerLike`, `SelectionWorkerFactory`, `SerializedMask` and `SelectionProgress`.

## 0.207.0

### Minor Changes

- 68bee37: The Select and Mask workspace. React and Svelte add `<SelectAndMaskWorkspace>`, a full-window workspace that opens from a "Select and Mask…" button in the selection options bar.

  - **Tools:** Quick Selection, Refine Edge Brush, Brush, Object Selection, Lasso, Hand and Zoom.
  - **Views:** Onion Skin, Marching Ants, Overlay, On Black, On White, Black & White and On Layers, with Photoshop's keys (O, M, V, A, T, K, Y and F to cycle), opacity, Show Edge (J) and Show Original (P/X).
  - **Settings:** Real-Time Refinement, High Quality Preview, edge detection and refinement, Output To, Decontaminate Colors and Remember Settings.
  - **Preview:** a live preview on a copy reduced to 1024 px.

  OK runs the same `refineSelectionTo` call an agent makes, as one undo step. Cancel and Escape change nothing, and Ctrl/⌘+Z undoes a stroke inside the workspace. The core holds the logic in a framework-free `SelectAndMaskSession`, which manages settings, strokes, the preview, view rendering, keys and commit. `RefineEdit` gains `lasso` and `object` kinds, so every workspace tool has an agent equivalent in `refine_selection` `edits`. New exports: `SelectAndMaskSession`, `SELECT_AND_MASK_VIEWS`, `SELECT_AND_MASK_TOOLS`, `DEFAULT_SELECT_AND_MASK_SETTINGS`, `forgetSelectAndMaskSettings` and the `SelectAndMaskSettings`, `SelectAndMaskView` and `SelectAndMaskTool` types.

## 0.206.0

### Minor Changes

- 5de591a: The Select and Mask workspace's strokes as data, plus object-aware refinement. `refine_selection` and `refineSelectionTo` take `edits`, which are applied in order before refining:

  - `quick-select`: grows to the region's edges.
  - `brush`: paints the selection in or out with a round brush, with a `hardness` setting.
  - `refine-brush`: marks hair or fur so the edge is re-estimated there, even beyond the radius. This uses a new `band` input to `refineCoverage` and `refineSelection`.

  With edits, refining can start from an empty selection. `refineMode: 'object'` asks the host segmentation model for the object in the selection's bounds and refines from its outline, kept to near the selection. The result reports `refineMode`. React and Svelte add an Object aware option to the Refine Edge panel when a model is set; the brushes get their UI in the workspace. New exports: `applyRefineEdits`, `brushStrokeMask`, `REFINE_EDIT_KINDS` and the `RefineEdit` type.

## 0.205.0

### Minor Changes

- 82e4c37: Select and Mask outputs and Decontaminate Colors. `refine_selection` and `controller.refineSelectionTo(params, output, { layerId, decontaminate })` refine the selection and put the result in one of four places, as one undo step:

  - `selection`: the refined selection (the default).
  - `layer-mask`: a mask on the layer, then deselect.
  - `new-layer`: Layer via Copy, with the source layer hidden.
  - `new-layer-with-mask`: a masked copy of the layer, with the source layer hidden.

  Decontaminate Colors (`decontaminate` 0..100, new-layer outputs only) replaces the old background's colour in soft edges with the subject's own colour. Edge pixels that are mostly subject are unmixed using the local background colour; ones that are mostly background take the subject's local colour. The colours are read from the source layer. The Refine Edge panel in React and Svelte has Output to and Decontaminate colors controls. New exports: `decontaminateColors`, `REFINE_OUTPUTS` and the `RefineOutput` and `RefineOutputResult` types.

## 0.204.0

### Minor Changes

- a092150: Vector layers move into and out of groups: `VectorEditorController.moveNode(id, { parentId, index })` reparents a node, keeping it where it is on the canvas, in one undo step; `reorderNode` now uses it. Agents get it as the `vector.moveLayer` command.

## 0.203.0

### Minor Changes

- 8a96fa6: When the host has set a segmentation provider, Select Sky and Object Selection now ask it first.

  - **Select Sky** asks for "the sky".
  - **Object Selection** asks for the object with the box or point. `SegmentationRequest` gains optional `box` and `point` fields for providers that take prompts (SAM). Of the results, it keeps the pieces mostly inside the box (clipped to the box grown by a tenth) or the ones under the point. If none fit, it falls back to GrabCut.
  - **Results:** both report `method` (`'model'`, `'grabcut'` or `'classical'`). `useModel: false` forces the classical method. The `select_object` and `select_sky` tools take `useModel` and return `method`.
  - **Breaking:** `controller.selectObject` now resolves to `{ selection, method }` instead of the selection.

## 0.202.0

### Minor Changes

- 453eef5: Paint editor tools can drive a paint document hosted as a layer on a larger canvas. `createPaintEditorToolProvider` takes a controller getter (resolved when a tool first runs, so registering never creates the document) and new options: `origin` (where document (0, 0) sits in host coordinates; every position argument and result is mapped through it in one place, from tools' declared `coordinates`, and descriptions say canvas coordinates; directors still receive document pixels), `exclude` (bare tool names to leave out) and `onChange` (called after each successful write). `get_canvas_info` now also returns `bounds`.

  `canvas.drawFreehand` (`createDrawCommands`) now plays back: its new `plan` (also exported as `planFreehandPlayback`) traces the stroke on its surface in canvas coordinates, moving to the first point, pressing with `gesture: 'path'`, dragging through up to 32 points paced by length, then releasing and committing.

## 0.201.0

### Minor Changes

- 7bb43e3: Select › Sky for the image editor. Each pixel is scored on colour (blue, or bright and grey when overcast), smoothness and height in the frame. The sky is grown down from the top rows through high-scoring pixels without crossing an edge, patches of the same colour seen through gaps are added, and the edge is fitted with the colour guided filter. React and Svelte have a Select Sky button in the selection options bar. Agents use `select_sky` (`threshold`, `softness`, `mode`), which returns a note when no sky is found. New exports: `findSky`, `controller.selectSky` and `SkyCommandOptions`.

## 0.200.0

### Minor Changes

- baf2e9d: Select › Focus Area for the image editor: selects the parts of the image that are in focus. It measures the local energy of the Laplacian above the image's measured noise floor, splits it into in and out of focus (Otsu, moved by In-Focus Range), closes small gaps, and fits the edge to the image with the colour guided filter. The selection options bar in React and Svelte has a Focus Area section with In-focus range, Image noise level and Soften edge. Agents use `select_focus_area` (`range`, `noise`, `softness`, `mode`), which also returns the noise level it measured. New exports: `focusArea`, `workPlanes`, `workLuma`, `softMaskToSelection`, `controller.selectFocusArea` and `FocusAreaCommandOptions`. Reduced copies of an image are now cached per size.

## 0.199.0

### Minor Changes

- 30e01c6: Select Subject works without a segmentation model. `selectSubject()` then finds the subject that stands out most, classically: SLIC superpixels, saliency (how unlike the image's border each patch is, times its local contrast, with a mild centre preference), Otsu's threshold, then GrabCut along the edges. A description can't choose the subject this way, so the result says `method: 'saliency'` with a note. With a model, nothing changes except that the result now includes `method: 'model'`. The Select Subject button is always in the selection options bar in React and Svelte; the description field shows only when a model is set.

  The `select_subject` agent tool is now one of the selection tools in `createImageEditorToolProvider` and is always listed. `target` is required only when a model is set, and there's a new `enhanceEdge` option. `createImageSegmentationToolProvider` is deprecated and lists no tools, so a host that registers both providers doesn't get the tool twice. New exports: `findSubject`, `slicSuperpixels`, `superpixelSaliency`, `otsuThreshold`, `grabCutLabels` and `keepMainPieces`.

## 0.198.0

### Minor Changes

- 9d03dd6: Object Selection for the image editor: drag a box loosely around an object, or click on it, and the object is selected. GrabCut fits colour models (mixtures of five Gaussians) to the object and its background, then relabels pixels with a graph cut along edges, and repeats until the labels settle. It runs on the same reduced copy as Quick Selection and is scaled back up with an anti-aliased edge. Sample all layers and Auto-enhance are in the selection options bar in React and Svelte. Agents use `select_object` with `rect` or `point`. New exports: `selectObjectIn`, `ColorGmm`, `smoothnessWeights`, `controller.selectObject` and `SelectObjectCommandOptions`. The shared reduced-copy code moved to `selection/segment/work.ts`; its exports are unchanged.

## 0.197.0

### Minor Changes

- b9e2028: Quick Selection for the image editor. Each brush stroke grows into the region it is painted on, out to its edges: a graph cut (Boykov–Kolmogorov max-flow) on a copy reduced to 512 px, with colour models of the stroke and its surroundings, then scaled back up with the edge anti-aliased at full size. With New and a selection already there, strokes add; Alt subtracts. Size, Sample all layers and Auto-enhance are in the selection options bar in React and Svelte. Agents use `quick_select` (`strokes`, `size`, `mode`, `sampleAllLayers`, `enhanceEdge`), one undo step for all its strokes. New exports: `GridGraph`, `quickSelectStroke`, `workImage`, `controller.quickSelect` and `QuickSelectCommandOptions`.

## 0.196.0

### Minor Changes

- 8624806: Add a layers model for vector documents: `vectorLayerRows()` lists nodes top first as layers-panel rows (kind, name, depth, visibility, lock, child count, expanded groups), with `vectorLayerKind()`, `vectorLayerName()` and `vectorLayerChildren()` (a blend's generated steps are left out). Add `VectorEditorController.reorderNode(id, index)`, which moves a node among its siblings as one undo step, as dragging it in a layers panel does.

## 0.195.0

### Minor Changes

- bd36d56: Magnetic Lasso for the image editor. The outline follows the edges of the image (live-wire: gradient, Laplacian zero-crossings and edge direction, whichever side is darker) from the last anchor to the pointer, and places anchors as it goes. Width, Contrast and Frequency are in the selection options bar in React and Svelte. Agents get the same with `select_polygon` `snapToEdges: { width, contrast }`, which snaps a rough outline to the edges. New exports: `EdgeMap`, `snapToEdge`, `liveWire`, `snapPolygonToEdges`, `simplifyPixelPath`, `magneticAnchorSpacing` and `controller.snapToEdges`.

## 0.194.0

### Minor Changes

- d923ddc: Add image editor toolbar descriptors: `IMAGE_TOOL_GROUPS` and `imageToolGroup()` (Photoshop-style tool groups), `imageToolLabel()`, `IMAGE_TOOL_SHORTCUTS` and `imageToolForShortcut()`, and `imageToolCanvasMode()`, `imageToolPanel()` and `imagePanelTool()`, which link each tool to the canvas mode it draws in and the `layerPanels` panel holding its options. Hosts can build a toolbar where picking a tool opens its panel.

## 0.193.0

### Minor Changes

- d21fbe3: Vertical writing in the shared text layout. Type layers and vector text nodes take `orientation: 'vertical'`: lines become columns running top to bottom, stacked right to left; CJK stands upright, Latin and other horizontal scripts turn 90° clockwise unless styled `upright`. Layout uses the font's `vhea` / `vmtx` (and `VORG`) metrics and `vert` alternates when the outline shaper has them (the OpenType reader now parses them), falling back to the ascent and descent, turned brackets and corner punctuation nudged to the upper right. Caret, hit testing, selection and arrow keys run down the columns (`caretAt(...).from` / `to`, `textSelectionQuads`, `textArrowStep`, `textLineMove`). PSD type imports and exports `Ornt` `Vrtc` (and upright Latin through `BaselineDirection`) so vertical type round-trips, as do JSON and SVG. New agent tools `set_text_orientation` and `vector.setTextOrientation`, an `orientation` option on `add_text_layer`, `textOrientation` on `vector.addText`, and an `upright` style field. React and Svelte `TypeOptionsBar` and `VectorTextPanel` gain Horizontal / Vertical and Upright Latin controls.

  The Vertical Type Mask (`selectTextShape` with `orientation: 'vertical'`, `select_text_shape`) now uses this layout instead of stacking characters into one centred column: (x, y) is the top of the first column, line breaks start new columns, a box is allowed, and Latin turns sideways as it does in Photoshop.

## 0.192.0

### Minor Changes

- c3b9c8d: Type masks. `selectTextShape` (the Horizontal and Vertical Type Mask) selects the shape of text laid out as `addTextLayer` would place it (font, size, weight, tracking, box, rotation), combined by mode, with feather and anti-aliasing, without adding a layer, as one undo step. It works with any text shaper, because it uses the drawn glyphs' coverage rather than their outlines. Vertical type masks stack the characters in one column centred on the click; real vertical text layout is a follow-up in the shared text module. New agent tool `select_text_shape`. The selection tools gain `type` and `type-vertical` (a click places the text), with `typeText`, `typeSize` and `typeFamily` options, and the React and Svelte `SelectionOptionsBar` show Type Mask and Vertical Type Mask with text, size and font fields.

## 0.191.0

### Minor Changes

- 313b60f: Selections ⇄ paths. `selectionToPath` (Make Work Path) traces the selection's outline into closed Bézier subpaths in document pixels, holes included (fill even-odd), within `tolerance` px (default 0.5), with square corners kept square. It returns compact SVG path data. `pathToSelection` (Make Selection) fills a path into the selection by mode, with feather and anti-aliasing. `addVectorMask(id, 'selection')`, the agent tool `add_vector_mask` `from: "selection"`, and a new Layers panel menu item "Add Vector Mask from Selection" turn the selection into a sharp, editable vector mask. New agent tools: `selection_to_path` (read-only) and `path_to_selection`. Lower level: `selectionToSubpaths`, `subpathsToSvgPath`, and `traceField` (now exported) with `squareCorners`. `getVectorMask` bounds now measure the curves rather than their handles.

## 0.190.0

### Minor Changes

- e40e913: Vector masks (Layer › Vector Mask). Any layer except a shape layer can have a path that reveals it and stays sharp at any size: `vectorMask` on the layer holds shape components (live shapes or Bézier subpaths in document pixels) with `inverted`, `enabled`, `linked`, `density` and `feather`. The compositor multiplies it with the raster mask, so both apply. A linked vector mask moves with its layer and follows Free Transform, flips, 90° turns and warps. It is saved in the document JSON, and PSD files now keep vector masks on pixel, type, smart object, group and adjustment layers instead of dropping them. Density and feather are read from PSD but not written yet. Controller: `addVectorMask`, `setVectorMaskPath`, `setVectorMaskProps`, `removeVectorMask`, `rasterizeVectorMask`, `selectionFromVectorMask` and `getVectorMask`. Agent tools: `get_vector_mask`, `add_vector_mask`, `set_vector_mask_path`, `set_vector_mask_properties`, `rasterize_vector_mask` and `remove_vector_mask`, and `load_selection_from_mask` takes `source: "vector"`. `list_layers` summarises each layer's vector mask. The React and Svelte `LayersPanel` show a vector mask thumbnail (Ctrl/⌘-click loads the path as the selection, Shift-click turns it off) and menu items to add (Reveal All / Hide All), disable, rasterize and delete one.

## 0.189.0

### Minor Changes

- a3ca1b2: Mask views, as in Photoshop. Alt-click a layer's mask thumbnail to show the mask alone in grey, and Alt+Shift-click it (or press the backslash key) to show what it hides as a red overlay over the image; do the same again to go back. `setMaskView` / `getMaskView` on the controller (view state: no undo step, not saved), `handleMaskViewKey` for hosts, and the agent tool `set_mask_view`. `capture_view` draws the mask view when `includeOverlays` is true, so an agent can check a mask. The React and Svelte `LayersPanel` mark the shown mask in its thumbnail's label.

## 0.188.0

### Minor Changes

- 2760ba2: Selections and alpha channels are stored as 256 × 256 tiles. Empty and fully selected areas cost nothing, and masks share the tiles an operation did not change, so undo steps keep only what changed. `historyBytes` (and the `maxHistoryBytes` limit) now count selection and channel tiles too. At 12 MP, combining or inverting a selection drops from about 11 ms to under 1.5 ms, and a marquee from about 115 ms to under 10 ms, because shapes are rasterised in their bounding box only. Quick Mask paint, Free Transform of a selection and masks made from a selection share tiles instead of copying the whole image. `SelectionMask` gains `surface`; `data` is unchanged for readers (built on first read and cached). New: `selectionFromTiles`, `selectionFromRegion` and `polygonCoverageBox`.

## 0.187.0

### Minor Changes

- 3fb84ba: Save and load selections and masks as image files. `exportMaskImage` writes the selection, an alpha channel or a layer's painted mask as a full-size greyscale PNG (white = selected; `invert`, `maxSide`), encoded in code so it works without a canvas, and `loadChannelFromImage` reads a mask image of any size into a new alpha channel. New agent tools `export_mask_image` (read-only) and `load_channel_from_image`. The React and Svelte `ChannelsPanel` gain Import… (a file into a new channel named after it) and Export PNG (the active channel, else the selection), built on the framework-free `openMaskFile` and `downloadMaskImage`. The image editor skill's painting detail moved to `references/painting.md`.

## 0.186.0

### Minor Changes

- 20aa672: Image editor: alpha channels (saved selections) and an editable Quick Mask.

  - **Alpha channels:**
    - `state.channels` holds `AlphaChannel { id, name, mask, color, opacity, indicates, visible }`. Channels are part of undo history and are saved in `toJSON` (RLE, like the selection).
    - Controller: `saveSelection`, `loadSelectionFromChannel`, `setChannelProperties`, `duplicateChannel`, `deleteChannel`, `getChannels` and `describeChannels`.
    - Visible channels draw as their tint (`QuickMaskStyle.indicates` covers the selected or masked area).
    - Agent tools: `list_channels`, `save_selection`, `load_selection_from_channel`, `set_channel_properties`, `duplicate_channel` and `delete_channel`.
  - **PSD:** alpha channels are written and read as extra merged-image planes, with their names (resources 1006 and 1045) and colour, opacity and what the colour indicates (1077). `PsdImportResult.alphaChannels` and `PsdExportInput.alphaChannels` carry them.
  - **Quick Mask mode:**
    - `setQuickMaskMode(on)` / `quickMaskEditing`, and the tool `set_quick_mask`.
    - While it is on, `paint_stroke`, `fill_pixels`, `clear_pixels`, `stroke_selection` and the retouch tools, called without a layer, paint the selection itself through the new `quick-mask` paint target. White selects and black deselects, and each edit is one undo step.
    - An empty selection shows fully tinted.
    - Q toggles the mode on the canvas (`handleQuickMaskKey`, and in `handlePaintShortcut`).
  - **React and Svelte:** a new `ChannelsPanel` in the Select & Mask tab.
    - It has thumbnails and an eye to show each channel.
    - A click loads a channel (Shift adds, Alt subtracts); a double-click renames it.
    - Buttons: Save Selection, Add to Channel, Duplicate, Delete and Quick Mask.
  - **Skills:** both image skills cover channels and Quick Mask.

## 0.185.0

### Minor Changes

- 966e27e: Image editor: operations that respect the selection.

  - **Adjustment layers and filters follow the selection:**
    - `AdjustmentLayerInit.useSelection` masks a new adjustment layer by an active selection. It defaults to false in the API for compatibility. The `add_adjustment_layer` tool and the panels pass true, and the result says `masked`.
    - `applyEffectFilter` and `addSmartFilter` take `useSelection`, which sets the smart filter mask from the selection in the same undo step. `apply_effect` always does this; `add_smart_filter` does unless `useSelection: false`.
  - **Edit › Stroke:** `strokeSelection({ width, location })` and `selectionRing`, built from the exact distance transform. Tool `stroke_selection`.
  - **Crop to the selection:** `cropToSelection()` and the tool `crop_to_selection`.
  - **Content-Aware Fill of the selection:** `contentAwareFill({ output, sampleRadius, seed })`, which reuses the PatchMatch fill from Spot Healing. It is deterministic for a seed and works on 8-bit documents only. Tool `content_aware_fill`.
  - **Pixel clipboard:**
    - `copyPixels({ merged })`, `cutPixels`, and `pastePixels(mode)` with modes `new-layer`, `in-place`, `into` and `outside`.
    - `getClipboard` / `setClipboard`.
    - Tools `copy_pixels`, `cut_pixels` and `paste_pixels`. Paste Into and Cut are each one undo step.
  - **Select-mode shortcuts:** `handleSelectionShortcut` handles Ctrl/⌘ C (with Shift, Copy Merged), X, V (with Shift, in place; with Alt+Shift, into), D, Shift+D and Shift+I. The React and Svelte canvases route these keys.
  - **`SelectionOptionsBar`:** Stroke with a width and location, Crop to Selection, Content-Aware Fill, Copy, Copy Merged, Cut, Paste, Paste in Place, Paste Into and Paste Outside.
  - **Skills:** `pixerate-image-editor` documents the tools, and its Free Transform guidance moves to `references/free-transform.md`. `pixerate-image-selection-masking` gains recipes for removing an object, outlining a cutout, cropping to a subject and pasting into a shape.

## 0.184.0

### Minor Changes

- 6fde02b: Image editor selections: one agent tool per operation, Color Range presets and tool, and a selection-masking workflow skill.

  - New agent tools: `select_all`, `deselect`, `invert_selection`, `select_rect`, `select_ellipse`, `select_polygon`, `magic_wand` (with `distance`), `select_color_range` (samples or a preset, `fuzziness`, `localized`, `invert`), `load_selection_from_image`, `load_selection_from_mask` and `set_selection_display`. `select_region` and `select_by_color` still work but are deprecated and will be removed in the next minor release.
  - Core: `colorRangePreset` / `skinToneRange` and `COLOR_RANGE_PRESETS`, `controller.selectColorRangePreset`, `invert` on selection commands, `controller.setSelectionDisplay` / `getSelectionDisplay` (`'ants' | 'quickMask' | 'none'`), `invert` on `selectionFromLayerMask`, and `maskThumbnailClick`.
  - `SelectionGesture` and `SelectionToolOptions`: a `range` (Color Range) tool, where a click samples a colour, Shift-click adds one and Alt-click removes one; `feather`, `fuzziness`, `localized` and `rangeInvert` options.
  - React and Svelte: `SelectionOptionsBar` gains the wand's colour distance, a Feather field, Color Range options and presets, and an Ants / Quick Mask / Hidden display switch (new `selectionDisplay` prop). In `LayersPanel`, Ctrl/⌘-click on a mask thumbnail loads the mask as the selection (with Shift to add, Alt to subtract).
  - Skills: new workflow skill `pixerate-image-selection-masking`; `pixerate-image-editor` documents the new tools.

- cee9b4f: Image editor: the simple selection tools Photoshop has and we lacked.

  - **Polygonal lasso** (`polygon` tool in `SelectionGesture`):
    - Click to add corners. Shift snaps to 45°. Drag for a free-hand stretch.
    - Double-click, Enter or a click on the first corner closes it. Backspace removes a corner and Escape cancels (`gesture.key`).
    - The React and Svelte canvases route the keys and keep the outline showing between clicks.
  - **Single row and column marquees** (`row` / `column` tools), `controller.selectLine` and the agent tool `select_line`.
  - **Reselect:** `controller.reselect` / `canReselect` and the tool `reselect`.
  - **Grow and Similar, by colour:**
    - `growSelection` / `selectSimilar` in core, the same on the controller, and the tools `grow_selection` / `select_similar`.
    - The distance-based operation is now called Expand / Contract: `modify_selection` `op` takes `expand` / `contract`, and `grow` / `shrink` still work as aliases.
  - **Select a layer's pixels:**
    - `controller.selectLayerTransparency`, the tool `select_layer_transparency` and `layerThumbnailClick`.
    - Ctrl/⌘-click a layer thumbnail in `LayersPanel`, with Shift to add and Alt to subtract.
    - A "Select Layer Pixels" item in the layer menu.
  - **New mask sources:** `addLayerMask` and `add_layer_mask` take `from: 'hide-selection'` and `'transparency'`. The layer menu gets "Add Mask Hiding Selection" and "Add Mask from Transparency".
  - **Options bar:** Reselect, Grow and Similar buttons, Expand and Contract labels, and a hint for the polygonal lasso.
  - **Skills:** `pixerate-image-editor` and `pixerate-image-selection-masking` cover the new tools.

## 0.183.0

### Minor Changes

- 729335f: Add `VECTOR_TOOL_GROUPS` and `vectorToolGroup()`: every vector tool sorted into toolbar groups (Draw, Shapes, Type, Cut, …) so compact toolbars can show one button per group with a flyout for the rest.

## 0.182.0

### Minor Changes

- 99db240: Agent playback traces selections the way a person would. A lasso (`select_region` with a polygon, and any traced stroke) now presses with a `path` gesture, and in select mode the canvas draws the path traced so far, not a rectangle from the press. `select_subject` traces each outline the model found before the selection lands. That uses the new `ToolCallContext.perform(steps)`, which lets a handler act out cursor steps it only learns mid-call.

  - `PresenceActor.gesture` and `{ type: 'press', gesture: 'path' }` steps
  - `trackPresenceDrag` reports a `PresenceDrag` (the box plus `path` and `gesture`)
  - `planOutlineTrace(outlines)`
  - `selectSubject`'s `beforeApply(outlines)` option
  - `segmentationOutlines(result)`

## 0.181.0

### Minor Changes

- 44c2095: Add first-class zero-dependency streamgraph chart type (`streamgraph`) with pure SVG marks, symmetric silhouette baseline offset, monotone cubic area ribbons, crisp boundary splines, and interactive point & category tooltips.

## 0.180.0

### Minor Changes

- 900847a: Image editor selections:

  - Marching ants stay one screen pixel wide when a host shows the canvas zoomed by a CSS transform (`hostScale`); they were drawn one CSS pixel wide, so a scaled studio drew them several pixels thick. The draft lasso path gets the same fix.
  - The ants march: `startMarchingAnts(tick)` steps `RenderOptions.antsOffset` every `MARCHING_ANTS_STEP_MS` (standing still under `prefers-reduced-motion`), and the Svelte and React `ImageEditorCanvas` run it while a selection shows.
  - `select_region` takes `shape: 'polygon'` with `points` (the lasso), so agents can select a subject's contour instead of its bounding box; `layer_via_copy` says the new layer takes the selection's shape.
  - `layerPanels` offers the Selection panel with any layer active, not only with none.
  - Select › Subject: a pluggable `SegmentationProvider` (`segmentation` option / `setSegmentationProvider`) and `ImageEditorController.selectSubject(target, { mode, maxSegments })`. It sends the flattened image and a description, then selects the outlines the provider returns (polygons, or whole-image masks of any size) as one undo step. `createImageSegmentationToolProvider(controller)` adds the `select_subject` agent tool, which is listed only while a provider is set. `SelectionOptionsBar` (Svelte and React) shows a subject field and a Select Subject button when a provider is set. `segmentToSelection` / `segmentsToSelection` are exported.

## 0.179.0

### Minor Changes

- 9c65fc4: Image editor: the selected-layer frame and Free Transform now show a rotate handle on a stem above the top edge, like the vector editor's selection box. Dragging it rotates about the reference point (Shift snaps to 15°). The handle sits a fixed 24 screen pixels out (`TRANSFORM_ROTATE_HANDLE_OFFSET`), follows the frame as it turns, stays outside flipped frames, and is hidden in Warp mode. `TransformOverlay` gains `rotate`, `TransformHandle` gains `'rotate'`, and `quadFrameOverlay` takes an optional `rotateOffset`. Dragging outside the frame still rotates as before.

## 0.178.0

### Minor Changes

- 68204f0: Layer styles (drop shadow, stroke, glow…) are now part of Layer Properties, and Effects means provider effects only. `layerPanels()` no longer returns the `effects` (Layer Effects) or `smart-filters` panels, with or without an effects provider. The `properties` panel holds the layer's Layer Style, and Svelte's `<LayerPanel panelId="properties">` renders it for every layer except adjustment layers. `<ImageProviderEffectsPanel>` (React and Svelte) shows an effect layer's controls and the layer's filters, added with an "Add filter…" button. It no longer lists or adds layer styles. `<LayerEffectsPanel>` is titled "Layer Style", and its menu is labelled "Add style". `LayerPanel` still renders the `effects` and `smart-filters` ids for hosts that ask for them directly. Agent tools are unchanged.

## 0.177.1

### Patch Changes

- bdc2130: `effectFieldValue` now shows a colour field's value as hex when the value is saved as 0–1 channels (`[r, g, b]` or `[r, g, b, a]`), the way Flair's colour controls also accept them. For a value a colour well can't show (`"currentColor"`, `rgb(…)`), it shows the field's default instead of passing the string through.

## 0.177.0

### Minor Changes

- 17663ce: Web font services for typography. `createStylesheetFontProvider` loads fonts from any service that serves CSS: `loadFont` adds the face's stylesheet once (asking for the nearest weight and a style the family has, since services reject the others) and resolves when `document.fonts` has the face. `createGoogleFontsProvider({ catalog })` does this for Google Fonts or a css2-compatible mirror; the host supplies the metadata (fonts.google.com allows no cross-origin reads), and `googleFontsCatalog` and `googleFontsStylesheetUrl` are exported for hosts that fetch or build it themselves. The catalog lists the most popular families first and files a family classified as display, handwriting or monospace under that category (Anton is a sans serif classified as display).

  `FontSummary.tags` carries a provider's classes (`display`, `slab-serif`, `variable-wdth`…), `filterFonts` takes `tags`, and `list_fonts` takes `tags` and returns the tags of every font it matched with their counts, so an agent can narrow a large web catalog to faces with the character it wants.

## 0.176.0

### Minor Changes

- 9de2389: Effect layers: transparent backgrounds, still frames or animation, changing the effect, and one Effects panel.

  - Effects contract: `EffectSummary.backgroundOpacity` names a 0–1 control that fades the effect's own background (checked by `checkEffectProvider`). `addEffectLayer` sets it to 0 when the layer has others below it, unless `values` set it; the fake gradient has one (`opacity`).
  - `updateEffectLayer(id, { effect })` changes an effect layer's effect in one undo step (its defaults plus `values`; a name the user gave is kept).
  - Effect layers are a still frame (`time`) or play in an animation (`animate: { duration }`, saved with the document). `getAnimation()` reports the animating layers and the animation's length; `renderAnimationFrame(time)` renders the document at a time into it without changing it. `effectLayerTiming` gives the panels' view.
  - Agent tools: `add_effect_layer` takes `animate`; new `set_effect_layer` changes an effect layer's effect, frame or animation.
  - One Effects panel (`ImageProviderEffectsPanel`): an effect layer's effect (Change…, Rasterize), Still frame / Animate with a frame scrubber and length, and its controls; then the layer's filters and layer styles, added from one Add menu. `layerPanels(layer, { effects: true })` no longer lists Layer Effects or Smart Filters separately, and no longer shows Effects with no layer selected: new effect layers come from the layers panel. `LayerEffectsPanel` takes `heading={false}` to drop its own title and Add menu.
  - Fix: effect controls whose schema is an `anyOf` (Flair's colours: sRGB channels or a CSS string) were left out of `effectParameterFields`, so effect panels showed no colour controls; they are now edited as the shape of their default.

## 0.175.0

### Minor Changes

- e0fd35c: Effect parameter controls: commit typed values on Tab and native `change` as well as blur and Enter, and revert a refused edit every time it is retried. Theme the inputs, selects, buttons and sliders with `--pixerate-parameter-*` tokens (`input-bg`, `input-fg`, `select-bg`, `select-fg`, `button-fg`, `border`, `accent`), defined once in core as `parameterThemeStyles` / `parameterThemeStyleText`. Hosts can pass their own `input`, `slider` and `select` through a `components` prop or `ParameterComponentsProvider` / `setParameterComponents`. The image editor's host `Range` / `Select` are used for effect parameters, with values kept as their original types (`matchParameterOptionValue`).

## 0.174.1

### Patch Changes

- 01baa4c: `@pixerate/markdown-conformance` is no longer installed with the editor. Its format manifest is already built into the editor, so it is now only a development dependency.

## 0.174.0

### Minor Changes

- 767f494: Add shared `@pixerate/markdown-conformance` package containing Markdown editing fixtures and format-command manifest.
  Expose `createFormatCommands` and `formatCommandsFor` across `@pixerate/editor`, `@pixerate/editor-react`, and `@pixerate/editor-svelte` with full cross-framework parity and schema validation.

### Patch Changes

- Updated dependencies [767f494]
  - @pixerate/markdown-conformance@0.2.0

## 0.173.0

### Minor Changes

- f76d71c: Effect search by tag. `EffectSearchOptions.tags` keeps effects carrying every tag (any case, spaces as hyphens), applied by `searchEffectSummaries`; `normaliseEffectTag`, `hasEffectTags` and `countEffectTags` are exported. The `search_effects` tool takes `tags`, returns each effect's tags, and lists the tags of everything it matched with their counts, so an agent can browse a catalog's tags and narrow by them. A tag the catalog does not have comes back in `unknownTags` with the nearest ones.

## 0.172.0

### Minor Changes

- fb070dd: Chart tooltips. `<ChartCanvas tooltip>` shows the bar, point or slice under the pointer, and `tooltip="category"` shows every series anywhere in a bar, line or area chart's category band. Values are written with the series or axis format, with shares on 100% stacked and pie charts. Pass `renderTooltip` (React) or a `tooltipContent` snippet (Svelte) for custom content. The tooltip hides while a point is dragged. Core adds `chartTooltipAt`, `chartTooltipFor`, `sameChartTooltip`, `chartCategoryAtPoint` and `ChartScene.categoryScale`, and the chart tool provider adds a read-only `get_chart_tooltip` tool.
- fb070dd: **Breaking for rich-text users:** TipTap, ProseMirror and markdown-it are now optional peer dependencies instead of dependencies, so apps that only use charts, spreadsheets, canvases, images or the other subpath entries no longer install them. Apps that use rich text or prompts (the root entries, and core's `/extensions`, `/serializers`, `/agent` and `/compare`) must install them; each package README has the install line. `@tiptap/core`, `@tiptap/pm` and `@tiptap/react` are optional peers too.

## 0.171.0

### Minor Changes

- e9076b2: Effect layers and provider effects for hosts that build their own layer UI. `newLayerOptions` offers an "Effect Layer…" option (`pick: 'effect'`) when the editor has an effects provider, and `addLayerOfKind(controller, 'effect', { effect })` adds it. `layerPanels(layer, { effects: true })` includes a `provider-effects` panel, also with no layer active, which Svelte's `LayerPanel` renders as `ImageProviderEffectsPanel`. `EFFECT_LAYER_USES` names the effect uses an effect layer draws.

## 0.170.0

### Minor Changes

- eee1ff2: Image editor overlay chrome keeps its size on screen under a host's CSS zoom. `measureCanvasViewport()` returns `hostScale` (screen pixels per CSS pixel from transforms on the element), and the new `RenderOptions.hostScale` draws the crop and Free Transform frames and handles, the brush cursor, the clone source marker and the text caret that much smaller. `ImageEditorCanvas` (React and Svelte) passes it, so the handles of a canvas inside a zoomed canvas node no longer grow with the zoom. The crop and transform handles are also a little smaller (8px instead of 10px) and the transform frame thinner.

  Svelte `ImageEditorCanvas` takes `panMode`: a host's hand tool, where a primary drag pans the view in every mode (as holding Space does) and the canvas's own gestures pause, with a grab cursor.

## 0.169.0

### Minor Changes

- 852d68c: Agent playback: staged changes. A plan can put `stage` steps after its `commit`: the handler then starts at `commit` while the cursor keeps playing, and each `stage` step lets one `await context.stage?.()` in the handler through (`ToolCallContext.stage`, absent without playback). A tool that adds several things (swatches, a row of nodes) adds them one by one as the cursor reaches each.

  Image editor: the Free Transform overlay (and transform mode's layer frame) is drawn like the crop box, with a white frame, the crop's white handles edged in blue and a small reference point instead of the large crosshair.

  Image editor panels take the host's own form controls. `setImageEditorControls({ Checkbox, Range, Select })` (Svelte) and `<ImageEditorControlsProvider controls={...}>` (React) make the panels' checkboxes, range sliders and dropdowns (`ControlSlider`, canvas size, layer effects, brush, shape, selection and adjustment layer panels) render the host's components; any not given stay plain inputs. The wrappers `ImageCheckbox`, `ImageRange` and `ImageSelect` are exported.

  Svelte `LayerPanel`: the panels follow the controller (the active layer's name, opacity and kind update after each change, not only when the panel mounts), and the Properties opacity slider works in the control's 0–1 range (it set opacity to 1% or less before).

## 0.168.0

### Minor Changes

- 7dd63d6: Effect authoring previews no longer go stale or blank for some effects (#359).

  - `createEffectAuthoringSession` starts the playhead at half the effect's length, as catalog thumbnails do, so entrance-style effects and transitions open on a frame that shows them. Pass the new `startTime` option to start elsewhere.
  - When `createPreview` cannot make a pixel renderer (for example a vector effect the provider only draws as SVG), the session records why in the new `EffectAuthoringState.previewError`. `effect_authoring_describe` returns it with the playhead `time`, and `effect_authoring_view` refuses with that reason instead of capturing a blank frame.
  - `EffectAuthoringEditor` (React and Svelte) clears the canvas when the session changes, catches preview and frame failures instead of leaving an unhandled rejection, and shows the reason over the preview while parameters, keyframes and the timeline stay usable.

## 0.167.0

### Minor Changes

- a38ff4a: Chart editor: choropleth maps, for parity with Ursula's chart documents. The new `choropleth` type shades the regions of a registered map (`map`, default `europe`) by the first series, in `mapSteps` equal classes (breaks rounded for the legend) or at `mapThresholds`; categories name regions by ISO alpha-3 code or by name, unmatched ones are reported, regions without data are grey, microstates get markers, and the class legend and the map's credit run along the bottom. Without a registered map or any match the chart draws bars and says why. Maps are registered with `registerChartMap` (`getChartMap`, `listChartMaps`, `matchChartMapRegions`, `chartMapBreaks`, `chartMapClass`, `chartMapRamp`); the new `@pixerate/editor/chart-maps` entry point ships `EUROPE_CHART_MAP`, Europe from Natural Earth 1:50m countries (public domain, via world-atlas 2.0.2) in Lambert azimuthal equal-area, generated by `scripts/build-europe-chart-map.mjs`, so the main chart bundle stays free of map data. New agent tool `list_chart_map_regions` and command `chart.mapRegions`; `update_chart` takes `map`, `mapSteps` and `mapThresholds`. The React and Svelte inspectors add Map, Classes and Breaks. Highlight now also dims map regions.

## 0.166.0

### Minor Changes

- 8affb13: Chart editor: bar chart races, for parity with Ursula's chart documents. The new `barrace` type reads categories as time points and series as names and draws the top `raceTopN` names at one moment as ranked horizontal bars; values ease and places slide between time points, gaps carry the last value, and bar keys follow the series so scenes blend. The moment is controller view state (`ChartState.raceFrame`, `racePlaying`) set with `setRaceFrame`, `playRace` and `pauseRace` (the `raceTicker` option swaps the clock), and `layoutChart` takes `raceFrame` to draw any moment. New helpers `chartRaceRanking`, `chartRaceValueAt`, `chartRaceMoment`; agent tools `get_chart_race_ranking`, `set_chart_race_frame` and `play_chart_race`, `render_chart` takes `time`, and `chart.raceRanking`, `chart.setRaceFrame`, `chart.playRace` and `chart.pauseRace` commands. The recommender suggests a race for many series over time. The React and Svelte canvases draw the moment shown, and the inspectors add Play / Pause, a time scrubber and a Bars setting.

## 0.165.0

### Minor Changes

- 7c27b77: Chart editor: Mermaid `sankey-beta` and `treemap-beta`. `chartFromMermaid` reads Sankey diagrams into flows (`links`, node order kept) and treemaps into grouped data (`tree`) with the diagram module's parsers, following Ursula's rule for treemaps: one section round everything is the whole, items or one level of sections make a treemap, deeper nesting a sunburst. `chartToMermaid` writes Sankey diagrams with flows as `sankey-beta` CSV records (title in frontmatter) and treemaps and sunbursts as `treemap-beta` with their levels instead of a pie of the totals, still with the `%% @pixerate` comment for an exact round trip. `findMermaidCharts`, `import_chart_mermaid` and `export_chart_mermaid` handle both families, and `findMermaidCharts` now skips frontmatter when it looks for a chart's header.
- a446d15: Chart editor: Sankey diagrams, for parity with Ursula's chart documents. New `spec.links` (flows between named nodes) is the chart's data when set: the categories become the nodes (in `sankeyNodes` order) and the first series how much passes through each. `normalizeChartLinks` refuses self-flows, repeated pairs and loops with sentences. The new `sankey` type puts nodes in columns by the chains of flows into them, sizes nodes and flows on one scale, colours flows by `sankeyLinkColor` (`source`, `target`, `gray`), keeps a highlighted node's flows bright, and draws its table as bars until it has flows. New controller methods `setLinks`, `importLinksTable`, `addLink`, `updateLink`, `removeLink`, helpers `chartSankeyNodes`, `chartSankeyNodeValues`, `chartLinksFromTable`, `setChartLinkField`, `addChartLink`, and agent tools `set_chart_links`, `import_chart_links_csv`, `add_chart_link`, `update_chart_link`, `remove_chart_link` with matching `chart.*` commands. Cell edits are refused while the data is flows. The React and Svelte data grids show flows as a Source / Target / Value table (`ChartLinksGrid`), and the inspectors a flow colour option.
- 480aa51: Garbage-collect unreferenced editor assets in storage (#348). `collectEditorAssetGarbage(storage, { keep, dryRun, only })` deletes the stored `pixerate.assets:` entries that no stored document, index or autosave snapshot refers to, keeping registries, documents and references passed in `keep`, and never racing a write in flight (leases in this realm, Web Locks across tabs). `StorageAdapter` gains an optional `keys(prefix)`, implemented by the memory, localStorage, IndexedDB and OPFS adapters and passed through `withStorageFailures` and `withEditorAssets`; `EditorAssetRegistry` gains an optional `refs()`. `createEditorDocumentStore` collects after `remove` and exposes `collectAssetGarbage()`; `createEditorAutosave` (core and Svelte) and React `useEditorAutosave` collect after `markClean` and `discard`, keeping the assets the open document uses (option `collectAssetGarbage`, default on). Image and paint document tools add `find_unreferenced_<kind>_assets` and `delete_unreferenced_<kind>_assets` when the store's storage can list keys.
- 567ebc0: Add house-style skills: preferences and rules a host hands agents at runtime, per editor domain. `createStyleResolver` merges layers of style skills (org, workspace, user, ...; locked and required layers, per-field profile merge with sources, `$token` references resolved against design tokens), `memoryStyleStore` holds them, and `createStyleToolProvider` adds `list_styles`, `get_style`, `get_style_file` and `get_style_schema`. Charts (`chartStyleDomain`, `check_chart_style`: palette-only, distinguishable, min-contrast, allowed-type) and design tokens (`tokensStyleDomain`, `createTokenStyleSource`, `check_tokens_style`: required-variables, name-pattern, required-modes, contrast-pairs) are the first domains. Discovery views (`discovery.styles`) mark toolsets that have a house style. React and Svelte add `useStyle`, `useStyleFindings` and `<StyleFindings>`.

## 0.164.0

### Minor Changes

- cc1ea14: Canvas node explosion, declarative-first. `calculateDirectionalDisplacement` now enforces `minY` and the new `maxY` (rows pushed into the band stack `rowSpacing` apart and never move backwards), keeps X locked for vertical moves and Y for horizontal ones, and has `layoutMode: 'row-lane'` (lanes `rowSpacing` apart, vertical deltas rounded up to whole lanes). It throws a `RangeError` for bad options. New: `computeCanvasExplosionLayout` (pure displacement, child copies, parent edges, original positions, total delta), `calculateReflowDisplacement` (dagre reflow for an explosion, ranking children by their parent edges), `nodeSizeOf`, the framework-free `createCanvasExplosionStateController` (active / collapsing node, collapse timer, subscribe), and agent tools `createCanvasExplosionToolProvider` (`list_explodable_nodes`, `explode_node`, `collapse_node`) with `canvasExplosionToolTarget`. Breaking: `ExplodeNodeOptions.connectChildrenToDownstream` (never implemented) is removed, and `left` / `up` displacement no longer moves nodes level with the origin.

## 0.163.0

### Minor Changes

- 4fb0033: Chart editor: annotations from Ursula's chart documents. New spec fields `referenceLines` and `referenceBands` (targets and ranges on the value, secondary or numeric x axis), `series.callouts` (a boxed label with a leader line pinned to a bar or point), `highlight` (named categories and series stay bright, the rest are muted), `note` (a source line under the chart) and `varyColors` (one palette colour per category on a one-series chart, read from and written to Office `c:varyColors`). Bar, line, area, scatter and bubble charts draw the references and callouts; highlight and the note work on every type. New controller methods (`addReferenceLine`, `updateReferenceLine`, `removeReferenceLine`, the same for bands, `setCallout`, `setHighlight`, `setNote`) and `suggestChartReferences`; new agent tools `add_chart_reference_line`, `update_chart_reference_line`, `remove_chart_reference_line`, the same for bands, `set_chart_callout` and `highlight_chart`, with matching `chart.*` commands; `update_chart` takes the new fields. The React and Svelte inspectors gain a Note field, a Colour by category toggle, an Annotations section and a Callout field for the selected point. Fix: point colours, x values, bubble sizes and custom error amounts now move with their category when categories are added, removed or reordered.
- 2530bc6: Chart editor: slope, Likert and parliament charts, for parity with Ursula's chart documents. `slope` joins each category from the first series (before) to the second (after), labelled at both ends and draggable. `likert` draws each category as a diverging bar of its answers (most negative first) as shares of its total, coloured with the colour-blind-safe PuOr scheme (`chartLikertColor`), with `likertNeutral` (`split` or `separate`) and `likertSort` (`none`, `positive`, `negative`). `parliament` draws the first series as seats in a hemicycle with the majority line and the total, with `parliamentArc`, `parliamentMajority` and `parliamentLabel`. All are set through `update_chart` / `chart.update`, recommended by `recommendChartTypes` when the data suits them, described by `describeChart`, kept through Mermaid, and written to Office as the closest classic chart with an issue. The React and Svelte inspectors show the new options.
- 415dbde: Chart editor: grouped data, nested treemaps and sunburst charts, for parity with Ursula's chart documents. New `spec.tree` (groups and items up to six levels, sibling names unique) is the chart's data when set: the categories become its top-level names and the first series their totals. A treemap with a tree nests each group's rectangles under a header; the new `sunburst` type draws a ring per level (or the first series as one ring) with `sunburstLabel` under the total. New controller methods `setTree`, `setTreeRows`, `importTreeTable`, `addTreeNode`, `updateTreeNode`, `removeTreeNode`, helpers in `@pixerate/editor/chart` (`normalizeChartTree`, `chartTreeToRows`, `chartTreeFromRows`, `chartTreeFromTable`, `chartTreeFromSeries` and the row-editing helpers), and agent tools `set_chart_tree`, `import_chart_tree_csv`, `add_chart_tree_node`, `update_chart_tree_node`, `remove_chart_tree_node` with matching `chart.*` commands; `get_chart` returns `treeTable`. Cell edits are refused while the data is grouped; `setData` and imports replace it. The React and Svelte data grids show grouped data as a Group / Level / Item / Value table (`ChartTreeGrid`, with `+ Level`, Ungroup, and Group items for treemaps and sunbursts). Office chartex treemaps and sunbursts now import with their levels (sunbursts were drawn as flat treemaps); exports write group totals. `addCategory` now returns `{ ok: false, message }` when it is refused.
- 8146df0: Remove the paint editor's deprecated `save_document` and `open_document` agent tools from `createPaintEditorToolProvider`. They were kept as aliases for one minor version after the shared document tools arrived. Use `get_paint_document` (the painting with images as asset references) or `save_paint_document` instead of `save_document`, and `load_paint_document` or `open_saved_paint_document` instead of `open_document` (register them with `createDocumentToolProvider(createPaintEditorDocument(controller))`).

## 0.162.1

### Patch Changes

- 53d9906: Fix wet paint color mixing on overlapping strokes by sampling settled pigment alongside suspended pigment and tuning gouache moisture retention and pickup parameters.

## 0.162.0

### Minor Changes

- b514d51: New `@pixerate/editor/typography` subpath: a DOM-free typography module. Font specs and weight matching (`normalizeFontWeight`, `nearestFontWeight`); modular type scales and a caption-to-display hierarchy (`computeTypeScale`, `generateTypeHierarchy`, `typeHierarchyToCss`) with recommended line-height and tracking; fluid `clamp()` sizes (`computeFluidSize`); readability audits for measure, line spacing and capitals (`auditTextReadability`); WCAG contrast that decides large text from size and weight (`checkTypographyAccessibility`); `font-family` parsing, quoting and cross-platform fallback stacks (`parseFontFamily`, `resolveFontFallback`, `FONT_STACKS`); text segmentation into graphemes, words, sentences or lines with UTF-16 offsets (`segmentText`); pluggable font providers (`FontProvider`, `combineFontProviders`, `ensureFontsLoaded`) with a system font metadata catalog (`createSystemFontProvider`, Local Font Access only when the host opts in), a web font provider over the CSS Font Loading API with injectable `FontFace` (`createWebFontProvider`, `fontFaceCss`); a headless `FontPickerModel`; and agent tools: `createTypographyToolProvider` (`list_fonts`, `resolve_font_stack`, `suggest_type_scale`, `generate_type_hierarchy`, `compute_fluid_type_size`, `audit_text_readability`, `check_typography_accessibility`, `segment_text`, `load_font`) and `createFontPickerToolProvider` (`get_font_selection`, `list_picker_fonts`, `set_font_selection`), documented in the new `pixerate-typography` skill.

  Effects: string controls with `format: "font"` or `"x-pixerate-control": "font"` become a font choice in `effectParameterFields` (families from `options.fonts`, default the system catalog), and `effectFontFamilies` lists the families to load before rendering a title preview.

  Colour: new `suggestAccessibleForeground`, shared by `check_color_contrast`, `check_dual_color_contrast` and the typography check. Suggestions are now measured after rounding to hex, so a suggested colour no longer lands just below the AA threshold.

## 0.161.0

### Minor Changes

- 36dcd23: Video editor: adjustment clips, masks, skin-tone protected LUTs, plan-first edits, transcript cleanup, ducking, loudness and beats.

  - **Adjustment clips** (`type: 'adjustment'`, `scope`: `underneath` / `all` / `track` with `targetTrack`): their grade, provider effects and mask apply to the composite of the pictures in scope while they play, in the preview, SVG frames and the ffmpeg export (a full-opacity grade or LUT over what is underneath or the whole frame; anything else needs rendered frames). Their effects open in the effect authoring editor (`openVideoClipEffectAuthoring`, `videoClipEffectDocument`, `videoEffectValuesFromDocument`), with video keys and animation easings converted both ways.
  - **Clip masks** (`mask`: rectangle with corner radius, ellipse, linear split, polygon; position, size, rotation, feather, invert) in the preview and SVG (`videoMaskPolygon`, `videoLayerMask`, `videoMaskContains`).
  - **Skin-tone protection** for LUTs (`preserveSkinTones`, `videoSkinToneWeight`) in the preview and frame renders; the ffmpeg export notes it.
  - **Edit plans**: `planVideoEdits`, `diffVideoProjects`, and `controller.proposePlan` / `applyPlan` / `discardPlan` with `state.plans`, re-checked when the project changed since.
  - **Transcript cleanup**: `findVideoRepetitions`, `detectVideoDisfluencies`, `videoCutsWithMargin` and `TranscriptVideoController` (playhead word, selection, text offsets to times, delete or plan words, one-click disfluency cuts, cleanup plans).
  - **Mix**: BS.1770 loudness in peaks (`VideoAudioPeaks.loudness`, `measureVideoLoudness`, `videoAudioLoudness`, `videoLoudnessGain`), ducking keys (`videoSpeechRanges`, `videoDuckingKeys`) and beats (`findVideoAudioBeats`, `nearestVideoBeat`).
  - **Agent tools**: `add_video_adjustment_clip`, `set_video_clip_mask`, `remove_video_clip_mask`, `set_video_skin_protection`, `plan_video_edits`, `list_video_edit_plans`, `apply_video_edit_plan`, `discard_video_edit_plan` (and `preserve_skin_tones` on `set_video_lut`); `createVideoDialogueToolProvider` (`find_video_disfluencies`, `plan_video_dialogue_cleanup`; skill `pixerate-talking-head-edit`); `createVideoMusicToolProvider` (`find_video_beats`, `plan_video_beat_snap`, `duck_video_music`, `measure_video_loudness`, `normalize_video_loudness`; skill `pixerate-bgm-alignment`).
  - **React and Svelte**: `TranscriptEditor` (in `VideoEditor` with `transcriptMode="editor"`; the default stays `TranscriptPanel`), `EditPlanPreview`, an "Adjustment" button in `VideoTransport`, adjustment scope, mask and skin protection rows in `ClipInspector`, "author" in `VideoEffectsPanel`, `useVideoDialogueTools`, `useVideoMusicTools`, `useTranscriptVideoController` / `transcriptVideoOf`.

## 0.160.0

### Minor Changes

- ab63ed6: Image editor transform mode frames shape, type and smart object layers too (`ImageEditorController.getLayerFrame`, `quadFrameOverlay`), and a press anywhere inside a frame moves the layer, its centre included (`FreeTransformTool.down` option `reference: false`).

## 0.159.0

### Minor Changes

- cec991d: Image editor transform mode: the canvas draws the active layer's frame and opens a Free Transform only for the length of a drag (one undo step when something changed), so other edits never meet an open transform. Pressing away from the frame picks the layer there, or none. Adds `boxFrameOverlay`, `boxFrameHit` and `FreeTransformTool.modified`.

## 0.158.0

### Minor Changes

- a0085ab: Support hit testing, canvas resize, dynamic layer panel descriptors, and transform mode gestures in image editor

## 0.157.0

### Minor Changes

- 475ff71: Chart editor: radar charts keep Mermaid's `ticks` and `graticule`. New `radarTicks` (an even ring count, or `null` for round-number rings) and `radarGraticule` (`polygon` or `circle`) spec fields are drawn by the radar layout, read and written by `chartFromMermaid` / `chartToMermaid`, settable through `update_chart` / `chart.update`, and shown as Rings and Grid in the React and Svelte inspectors. A `radar-beta` block without `graticule` now imports as `circle` (Mermaid's default), and polygon rings are written as `graticule polygon`.

## 0.156.0

### Minor Changes

- 9adede5: Paint editor: grow the canvas on any side without losing paint. `PaintEditorController.extendCanvas({ left, top, right, bottom })` adds pixels on each side and moves everything by (left, top) together: layer offsets (masks and relief follow), sticker positions, the paper grain (new `PaperSettings.offset`), the effect paper, guides, stencils, the tracing image, and the recorded strokes and wet / paint events, so replays still match. Wet paint dries first (per-layer wet settings are kept). It is one undo step that also restores the guides. It returns the new canvas, its rect in the previous coordinates, and the new `document.origin`. The origin is saved by `toJSON` / `loadJSON` and lets a host keep its own offset in step, even through undo. New agent tool `extend_canvas`; `get_canvas_info` now returns `origin`. Fix: undoing or redoing across a canvas size change no longer leaves a wet simulation at the wrong size.

## 0.155.0

### Minor Changes

- 6a2d38e: Bring the save / load / undo contract to the image and paint editors, with pixels kept as assets.

  - `createEditorAssetRegistry()` (`/persistence`): a synchronous, content-addressed store for inline images. With `defineEditorDocument({ assets })`, documents hold `pixerate-asset:` references instead of PNG data URLs and base64, and loads swap them back (refusing references that are not loaded). `withEditorAssets(storage, registry)`, `persistEditorAssets` and `preloadEditorAssets` move the bytes to and from storage; autosave and `createEditorDocumentStore` use them automatically.
  - `createImageEditorDocument(controller)` (kind `image`; agent loads are one undo step) and `createPaintEditorDocument(controller)` (kind `paint`; opening clears history; read-only mid-stroke or mid wet step). `get_image_document` / `get_paint_document` never return pixel data.
  - `ImageEditorController`: `documentRevision` and `clearHistory()`. `PaintEditorController`: `documentRevision` and `busyReason()`.
  - Paint's `save_document` and `open_document` tools are deprecated in favour of the shared `*_paint_document` tools and will be removed in a later minor version.
  - React: `useImageEditor()` and `usePaintEditor()` return `editorDocument`. Svelte: `createReactiveImageEditor()` and `createReactivePaintEditor()` return `editorDocument`.

## 0.154.0

### Minor Changes

- 2fc90ff: Bring the save / load / undo contract to the canvas.

  - `createCanvasEditorDocument({ getNodes, setNodes, getEdges, setEdges, history, scenes? })` (kind `canvas`): the nodes and edges held by the host (without selection or measurement) plus saved scenes, loads checked for duplicate ids, dangling edges and missing parents, one undo step in the shared history. Agents get `get_canvas_document`, `load_canvas_document`, `undo_canvas`, `redo_canvas` and the save / open tools.
  - `createCanvasGestureRecorder(...)`: `begin()` / `end("Move")` around a gesture the flow library applies itself (a node drag), recorded as one undo step.
  - React: `useCanvasEditorDocument({ nodes, edges, setNodes, setEdges, history, scenes })`. Svelte: `createCanvasDocument({ getNodes, setNodes, getEdges, setEdges, history, scenes })`. Both also count changes the history does not see, but not selection or drag frames.

## 0.153.0

### Minor Changes

- a7ba1eb: Bring the save / load / undo contract to the rich text, spreadsheet and design-token editors.

  - `createRichTextEditorDocument(editor)` (root entry, kind `rich_text`: ProseMirror JSON checked against the schema; opening starts a fresh undo history), `createSpreadsheetEditorDocument(controller)` (kind `spreadsheet`: the whole workbook) and `createTokensEditorDocument(store)` (kind `tokens`: agent loads also refuse broken and cyclic aliases). Each gets `undo_<kind>` / `redo_<kind>` with the shared document tools.
  - `SpreadsheetController`: `subscribe(listener)`, `loadWorkbook(workbook, { undoable: true })` (one undo step), and `undo()` / `redo()` now return whether anything happened.
  - New `pixerate-tokens` agent skill.
  - React: `useSpreadsheetEditor()` and `useTokens()` return `editorDocument`; new `useRichTextEditorDocument(editor)`.
  - Svelte: `createReactiveSpreadsheet()` and `createTokens()` return `editorDocument`.

## 0.152.0

### Minor Changes

- 0ae2073: Paint editor: `compositeTiles` and `pickColor` take `paper: false` to leave the paper out, so a host can draw the paint over its own surface and sample only what was painted.

## 0.151.0

### Minor Changes

- 4b4fd44: Bring the save / load / undo contract to the chart, animation, video, parameters and vector editors.

  - `createChartEditorDocument`, `createAnimationEditorDocument`, `createVideoEditorDocument`, `createParametersEditorDocument` and `createVectorEditorDocument` (kinds `chart`, `animation`, `video`, `parameters`, `vector`), for `createEditorAutosave`, `createEditorDocumentStore` and `createDocumentToolProvider`. The vector editor's document tools add `undo_vector` / `redo_vector`.
  - `ChartController.replace(spec)` and `ParametersController.replace(snapshot)`: replace the whole chart or parameter set as one undo step, all-or-nothing.
  - `defineEditorDocument`: an editor's `load` can return `problems` (parts repaired with defaults); they land in the `LoadReport`.
  - React: `useChartEditor`, `useAnimationEditor`, `useVideoEditor`, `useParameters` and `useVectorEditor` return `editorDocument`.
  - Svelte: `createChartEditor`, `createAnimationEditor`, `createVideoEditor`, `createParameters` and `createVectorEditor` return `editorDocument`.

## 0.150.1

### Patch Changes

- c67147c: Image editor: a newly loaded image (and a document saved without an active layer) opens with its topmost paintable pixel layer active, which is the Background for a new image, so the first brush stroke, fill or `paint_stroke` works without picking a layer. Deleting the active layer moves to the nearest paintable layer below it, and `remove_layer` returns the new `activeLayerId`. Paint refusals now carry a person-facing message (`LayerOperationError.userMessage`, `userErrorMessage()`), which `ImageEditorCanvas`'s `onError` / `onerror` and the brush bar's Fill show (e.g. "Pick a layer to paint on in the Layers panel."). Agent tools keep the message that names tools. `ImageEditorCanvas` (React and Svelte) now stays sharp on high-DPI screens and when a host scales it with a CSS transform. The new `measureCanvasViewport` sizes the backing store from `getBoundingClientRect()` × `devicePixelRatio`. `RenderOptions.pixelRatio` draws through that scale, and layout and pointer mapping stay in CSS pixels. `watchCanvasViewport` measures again on resize and after transitions.

## 0.150.0

### Minor Changes

- bf2cd2d: `ImageEditorCanvas` draws the crop box (crop mode) and the marquee (select mode) while an agent drags them out, as it does for a user's drag. New in `@pixerate/editor/tools`: `trackPresenceDrag`, which follows a presence store for an agent's drag. New in `@pixerate/editor/image-editor`: `agentDragDraft`, which turns that drag into the canvas's draft crop or selection path.

## 0.149.0

### Minor Changes

- 2a49499: An explicit agent playback surface now wins over a provider's own. `createImageEditorToolProvider`, `createImageEffectsToolProvider`, `createVideoEditorToolProvider`, `createVideoEffectsToolProvider`, `createAnimationEditorToolProvider`, `createAnimationEffectsToolProvider`, `createChartToolProvider`, `createPaintEditorToolProvider` and `createPaintEffectsToolProvider` take a `playbackSurface` option, so several editors of one kind on one registry can each play on their own surface (default unchanged: `image`, `video`, `animation`, `chart`, `paint`). `withImagePlayback`, `withVideoPlayback`, `withAnimationPlayback`, `withChartPlayback` and `withPaintPlayback` prefer an explicit `surface` argument over the provider's `playbackSurface`, and fall back to the default only when neither is given. The React hooks that register these providers (`useImageEffectsTools`, `useVideoEditorTools`, `useVideoEffectsTools`, `useAnimationEditorTools`, `useAnimationEffectsTools`, `usePaintEffectsTools`, `useChartToolProvider`) forward `playbackSurface`; the Svelte hooks already pass their options through.
- b10b6ab: App chrome on canvas and element playback surfaces. `useCanvasPlaybackSurface` / `createCanvasPlaybackSurface` and `useElementPlaybackSurface` / `createElementPlaybackSurface` take `locate(ref)` (a rectangle in surface coordinates), `locateElement(ref)` (an element anywhere on the page, whose client box is mapped into surface coordinates through the surface's `fromViewport`) and `open(ref)`, so a host's HUD, toolbar or panels can answer `{ kind: 'panel' | 'control', id }` refs and open steps. The surface's own locator runs first; the element surface's `selectors` are now optional. `usePlaybackSurface` / `createPlaybackSurface` define `open` on the attached surface only when the options give one, so `AgentPlayback` skips `open` steps on surfaces that can't open anything instead of clicking nothing and waiting 220 ms. Core adds `PlaybackChromeOptions`, `PlaybackClientRect`, `playbackRectFromClient` and `locatePlaybackChrome` to `@pixerate/editor/tools`.

## 0.148.0

### Minor Changes

- 6a70d44: Add general-purpose effect authoring support across core, React, and Svelte:
  - Contract types `supportsAuthoring` and `openAuthoring` in `@pixerate/editor/effects`.
  - `createEffectAuthoringSession`, a generic session over any provider: observable state, control values, keyframe tracks with easing, playback, undo/redo, presets, and saved documents that are validated when reopened. Source editing (`setSource`, compile issues) is part of the session contract for providers that support it; the generic session has none.
  - `effectSampleInputs` for previews of filters and transitions.
  - 15 MCP-annotated agent tools and the `pixerate-effect-authoring` skill.
  - React bindings: `useEffectAuthoring` hook and `<EffectAuthoringEditor />`.
  - Svelte bindings: `effectAuthoringOf` store and `<EffectAuthoringEditor />`.

## 0.147.0

### Minor Changes

- eac0ca4: Add colour agent tools provider (`createColorToolProvider`) and `pixerate-color` agent skill covering colour inspection, contrast checking with WCAG 2.1 compliance and OKLCH lightness suggestions, colour-vision deficiency simulation, palette distinctness audits, harmonies, and perceptual blends.
- f81828c: Add dual colour support (`DualColor`, `light-dark()`, `deriveDualColor`, `checkDualColorContrast`, `dualColorsToCss`), agent tools (`derive_dual_color`, `check_dual_color_contrast`, `export_dual_colors_css`), `DualColorPicker`, and theme scheme observation (`useColorScheme`, `createColorScheme`).
- 8646b9a: Add gradient model, controller, and agent tools (`@pixerate/editor/gradient`). Includes support for linear, radial, and conic geometries, OKLab interpolation, dual `light-dark()` color stops, WCAG contrast checks, and 11 agent tools. `GradientController` validates geometry (`setGeometry` applies several fields as one undo step), `load()` syncs a host value without an undo step, and selecting a stop does not call `onChange`.
- c784c86: feat(core): add shared colour module (@pixerate/editor/color)

  - Zero-dependency colour parsing for CSS Color 4 syntax (`#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `hsl()`, `oklab()`, `oklch()`, `color(srgb)`, `color(srgb-linear)`, `color(display-p3)` and 148 standard CSS names)
  - Conversions between sRGB, linear sRGB, HSL, HSV, OKLab, OKLCH, and Display P3
  - CSS Color 4 OKLCH chroma binary-search gamut mapping (`toSrgbGamut`, `inSrgbGamut`)
  - WCAG 2 contrast ratios, APCA contrast, and readable text colour determination
  - Machado-Oliveira-Fernandes (2009) colour-vision deficiency simulation and palette harmony checks
  - Colour harmonies on RGB and artistic RYB wheels (`colorHarmony`)
  - Perceptual colour mixing in OKLab, OKLCH, sRGB, and sRGB-linear spaces

- 991d283: Add headless colour picker model (`ColorPickerState`, `pickerStateFromColor`, `pickerStateToHex`, `pickerStateFromArea`, `pickerStateFromHue`, `pickerStateFromAlpha`, `pickerKeyStep`, `pickerAreaBackground`, `pickerAlphaBackground`, `PICKER_HUE_BACKGROUND`) in `@pixerate/editor/color`.
- 0fc89a6: add headless gradient editor helpers (`gradientKeyStep`, `stopFromTrackPosition`, `trackPositionFromStop`, `angleFromPointer`, `gradientTrackBackground`)

### Patch Changes

- 2c08d7b: Add accessible `ColorPicker` component with 2D area, hue & alpha sliders, hex/CSS text inputs, swatch grid, recent colours, contrast badge against `contrastAgainst`, and EyeDropper support.

## 0.146.0

### Minor Changes

- d95bd25: Add one save / load / undo contract for editors, starting with the diagram editor.

  - `@pixerate/editor/persistence`: `EditorDocument` and `defineEditorDocument` (whole-document JSON, loads that are checked and migrated first and change nothing on failure, a revision per document change, undo / redo), editor files that name their editor (`serializeEditorDocument`, `parseEditorDocument`), `createEditorAutosave` (crash recovery for any editor document), `createEditorDocumentStore` (named saves on any storage adapter) and `createDocumentToolProvider`, the same agent tools for every editor: `get_<kind>_document`, `load_<kind>_document` (one undo step), `undo_<kind>`, `redo_<kind>` and, with a store, `save_<kind>_document`, `list_saved_<kind>_documents` and `open_saved_<kind>_document`.
  - `@pixerate/editor/diagram`: `createDiagramEditorDocument(controller)` (kind `diagram`, document `{ source }`).
  - React: `useEditorAutosave(doc, options)` in `/persistence`; `useMermaidDiagram()` returns `editorDocument`.
  - Svelte: `createEditorAutosave(doc, options)` in `/persistence`; `createMermaidDiagram()` returns `editorDocument`.

## 0.145.0

### Minor Changes

- 2075d2b: Record animation takes live. Press Record and perform on the stage: drag elements to move them, scale them about their centre or turn them, and change the picked element's fill, stroke and opacity. Stop keeps the performance as one new shot, one undo step, made of ordinary commands. A path becomes one `move` through `via` waypoints reached at the recorded times (the new `times` field). Scales, turns, fades and stroke widths become a few eased commands. Paints change when they were picked.

  - Core: `AnimationEditorController.startRecording`, `recordSample`, `beginRecordGesture` / `updateRecordGesture` / `endRecordGesture`, `stopRecording`, `cancelRecording`, `recordTake`, `pose`, `clientToDocument` and `state.recording`; `motionTakeShot`, `motionNodePose`, `simplifyTimedSamples`, `motionClientToDocument`; `AnimationPlayer.liveTime`; the `record_animation_take` agent tool.
  - React and Svelte: `<AnimationRecordPanel>` and `<AnimationStage recordMode>`, built into `<AnimationEditor>`.

## 0.144.0

### Minor Changes

- 9fb0b8b: Agent playback now shows only changes by default: `createAgentPlayback()` defaults `reads` to `'skip'`, so read-only tools return at once without moving the cursor. Pass `reads: 'glance'` (or `'play'`) to keep the previous behaviour, e.g. for demos and tours.

  New, optional `createPlaybackToolProvider(playback)` adds a `playback__say` tool that lets an agent show a short note beside its cursor. It is UI-agnostic (it only writes to the presence store), returns `{ shown, surface }`, and shows nothing without an error when no cursor is on screen. `playback.say()` now returns the surface id it showed the note on, or `null`.

## 0.143.0

### Minor Changes

- 23a822a: `canvas_add_node` places new nodes by their own size (not the 200×60 default) and accepts a `visibleRect` planner option (a rect or a getter, passed through `createEditorMcpToolProvider`'s `plannerOptions`): unanchored nodes then land in free space at the centre of the user's view instead of beside the last node. New `placeInView` layout helper. The cursor plan uses the same placement, so playback still lands where the node does.

## 0.142.1

### Patch Changes

- 398692c: Republish the agent playback release (#317), whose publish to npm failed with a registry outage (E503). No code changes beyond 0.142.0 / 0.93.0 / 0.103.0.

## 0.142.0

### Minor Changes

- 12bcbb1: Agent playback for the chart and paint editors, sharing one cursor with their directors, and `runToolScript` in core.

  - **Chart:**
    - `createChartToolProvider` plans its calls (`withChartPlayback`, `planChartToolPlayback`). Inspector options, the data grid and the toolbar are clicked.
    - With a director, `set_chart_values` and `select_chart_element` play through it (`playback: 'self'`).
    - `chartPointRef` and `locateChartPoint` find points.
  - **Paint:**
    - Both paint tool providers plan their writes (`withPaintPlayback`, `planPaintToolPlayback`, `paintPlaybackPanel`). Each write opens its side panel and points at the control.
    - With a director, strokes, fills and replays play through it.
  - **React and Svelte:**
    - `ChartEditor` and `PaintEditor` take `playback`, `playbackId` and a reveal callback.
    - Given the director's presence, they share it with playback (one cursor) and draw it over their panels.
    - `usePlaybackSurface` / `createPlaybackSurface` accept a shared presence store.
    - Paint panels carry `data-paint-tab` and `data-paint-panel`.
  - **Rich text:** `insert_chart` shows the agent's caret where the chart goes in.
  - **Scripts:** `runToolScript` (with `toolResultValue` and `toolResultError`) plays scripted agent turns (notes and tool calls) through any `ToolSource`. With `playback`, notes show on the cursor.

- c3277af: Agent playback for the spreadsheet, video, animation and parameters editors.

  - **Spreadsheet:**
    - `createSpreadsheetToolProvider` plans its writes (`planSpreadsheetToolPlayback`). `set_cell` is clicked and typed, `set_range` dragged across its block, and row or column edits mark their rows or columns.
    - It plays on the `spreadsheet` surface (option `playbackSurface`). `parseSpreadsheetPlaybackRef` reads cell, row and column refs.
  - **Video:**
    - Both video tool providers plan every write (`withVideoPlayback`, `planVideoToolPlayback`). The cursor drags clips to new times or tracks, pulls trims, clicks tracks where clips go in, and clicks the ruler for splits, seeks and markers.
    - Times are `videoTimeRef` / `parseVideoTimeRef` refs.
  - **Animation:**
    - Both animation tool providers (`withAnimationPlayback`, `planAnimationToolPlayback`) play on the `animation` surface.
    - The cursor clicks the shot a call names and visits the stage elements its commands target.
  - **Parameters:**
    - `parameters.set` visits each control it changes and types the value (`planParameterSetPlayback`, `withParameterPlayback`).
    - Every parameter command plays on the `parameters` surface.
  - **Robustness:** a surface rectangle or plan point with a non-finite number is treated as not found, so a bad lookup can no longer hang a tool call.
  - **React and Svelte:**
    - `SpreadsheetEditor`, `VideoTimeline` / `VideoEditor`, `AnimationEditor` and `ParametersPanel` take `playback` (default: the playback context), `playbackId`, and a reveal callback (`onPlaybackReveal` / `onplaybackreveal`).
    - New `useElementPlaybackSurface` (React) and `createElementPlaybackSurface` (Svelte) for plain DOM components.
    - The Svelte timeline's lanes also carry `data-track-lane`, as in React.

## 0.141.0

### Minor Changes

- 329748a: Agent playback: every tool call can be acted out by the agent's cursor, from any caller (scripted agents, `callTool`, MCP clients), with no per-tool code.

  - `@pixerate/editor/tools`:
    - `createAgentPlayback({ speed, reads, linger, clock, actor })`. Install it with `playback.install(registry)` or `registry.use(playback.middleware)`.
    - `ToolRegistry.use(middleware)` and `ToolCallContext.actor` (`callTool(name, args, { actor })`). `createMcpServer` names the actor after the client's `clientInfo`.
    - Tools may declare a pure `plan(args, state)` returning cursor steps, or `playback: 'self' | false`. Without a plan, playback visits the ids named in the arguments and rings what the result created.
    - With no surface attached, calls run instantly with identical results. `createInstantPresenceClock` and `playback.record()` support tests.
    - The presence primitives (`PresenceStore`, `PerformanceQueue`, …) now live in `tools`. `animation` re-exports them.
  - Commands: `CommandSpec.plan` and `playbackSurface`. `run_command` and `run_commands` play on the command's surface (its scope, or its id prefix).
  - Canvas:
    - `createEditorMcpToolProvider` plans its edits from the planner's model steps (`planCanvasToolPlayback`): the cursor clicks where a new node lands, drags edges and rings moved nodes.
    - `createCanvasPlaybackLocator` finds nodes and edges.
    - The provider takes new `playbackSurface` and `rectOptions` options.
  - React:
    - `PresenceLayer`, `AgentPlaybackProvider` / `useAgentPlayback`, `usePlaybackSurface` and `useCanvasPlaybackSurface`.
    - `useAgentToolProvider(registry, provider, { playback })` installs the playback.
  - Svelte: `PresenceLayer`, `setAgentPlayback` / `getAgentPlayback`, `createPlaybackSurface`, `createCanvasPlaybackSurface`, and the `useAgentToolProvider` `playback` option.
  - Deprecated: `AgentPresence` and `AgentPresenceLayer`. Use `PresenceLayer` with a playback surface.

- 8836a51: Agent playback for the image editor: every image tool call can be acted out by the agent's cursor.

  - Core:
    - `createImageEditorToolProvider` and `createImageEffectsToolProvider` plan each write with `planImageToolPlayback` and play on the `image` surface.
    - Before each write the cursor opens the tool's panel. Then it traces `points`, drags out boxes, clicks positions, visits the sliders `set_adjustments` moves, or visits the layers a call names.
    - New `withImagePlayback`, `createImagePlaybackLocator` and `imagePlaybackPanel`.
    - A generic `open` playback step and `PlaybackSurface.open` let a plan open part of the editor.
    - Results that return `layerId` or `layer.id` are ringed after the call.
  - React and Svelte:
    - `ImageEditor` takes `playback` (default: the playback context), `playbackId` (default `image`) and a reveal callback (`onPlaybackReveal` / `onplaybackreveal`).
    - It draws the cursor over the canvas and its panels, and its tabs carry `data-image-tab`.

- d84c258: Agent playback for the vector editor: every `vector.*` command can be acted out by the agent's cursor.

  - Core:
    - `createVectorCommands` plans the commands that make something at a place. `addShape` is dragged out corner to corner, `addPath` is traced, `addText` is clicked in (or dragged as a box) and typed, `placeSymbol` and the image stylizers are placed, `setTextStyle` drags across its range and `setMeshPoint` drags the point.
    - Every vector command plays on the `vector` surface; commands that take `ids` visit those nodes.
    - New `createVectorPlaybackLocator` and `withVectorPlayback`.
  - React and Svelte: `VectorCanvas` takes `playback` (default: the playback context), `playbackId` (default `vector`) and a reveal callback (`onPlaybackReveal` / `onplaybackreveal`), and draws the cursor over the canvas.

## 0.140.4

### Patch Changes

- 97693e8: Support CSS stylesheet `<style>` rules and classes in `parseVectorSvg`.

## 0.140.3

### Patch Changes

- 45f9e6d: Allow `postScriptName` in `patchTextStyle` so PSD type layers with PostScript font names round-trip without validation errors.

## 0.140.2

### Patch Changes

- 726d60c: The video transition tools say which to use: `set_video_transition` names its built-in types (crossfade, dip, wipe, push, slide, iris), and `set_video_effect_transition` points to it for those. In a model eval, an agent asked for a cross dissolve picked the provider-effect tool.

## 0.140.1

### Patch Changes

- 4f18536: Mitigate GHSA-cp6q-959q-f8rh (TipTap `mergeAttributes()` prototype pollution) within TipTap 2. The TipTap peer dependency floor rises from `^2.11.5` to `^2.27.3`, the 2.x release that carries TipTap's fix. Our nodes and marks now render through the new `safeMergeAttributes`, and untrusted JSON loses own `__proto__`, `constructor` and `prototype` keys (via the new `stripPrototypeKeys`) at `EditorController` content, the rich clipboard (`application/x.pixerate.document+json`), `compareDocuments`, `CommentStore.parse`, the persistence loaders, the style registry, and every agent tool call through `ToolRegistry.callTool`. So an own `__proto__` key from document JSON can no longer become rendered DOM attributes (such as `onerror`), even with an older TipTap.

## 0.140.0

### Minor Changes

- eba5cc6: Make agent tools easier to find in large catalogues.

  - **Breaking: tool names are namespaced by default.** `ToolRegistry` now exposes every tool as `<namespace>__<name>`, using the provider's `namespace` or else its `id` (`chart__get_chart`, `image-editor__add_layer`), so names no longer change when another editor mounts. Calls by bare name still work when only one tool has that name; an ambiguous bare name fails with the full names to choose from. Pass `new ToolRegistry({ namespaces: 'on-collision' })` for the old behaviour, or `namespace: ''` on a provider to keep its bare names.
  - **Toolsets.** Providers carry a `title`, `description` and `skill`, and every built-in provider sets them. `registry.toolsets()` groups tools by namespace.
  - **Scoped views.** `registry.view({ toolsets, readOnly })` shows an agent only some toolsets or only read tools, refusing the rest with the reason; `setToolsets` follows the focused editor. Views are tool sources, so `createMcpServer`, `connectToolBridge` and `useToolBridge` accept them.
  - **Discovery.** `registry.view({ discovery: { skills } })` lists only `list_toolsets`, `search_tools`, `enable_tools`, `disable_tools` and `get_skill` until the agent enables what it needs. `searchTools` ranks tools for a plain-words task.
  - **Skills over MCP.** `createMcpServer(source, { skills, instructions: toolsetInstructions })` serves the agent skills as MCP prompts and `skill://` resources and describes the toolsets on `initialize`. The MCP bridge serves the packaged skills by default (`loadSkillFiles()` in `@pixerate/editor/bridge`).
  - **React and Svelte:** `useToolRegistryView` in both; `useToolBridge` accepts a view.

- 752aad5: Animation agent tools are about 7× smaller to list: the write tools (`edit_animation`, `write_animation`, `insert_shots`, `update_shot`, `add_commands`, `set_animation_clip`) no longer inline the full per-type command schema at every use. Each tool carries one compact, strict command shape (every field of every type listed once, prefixed with the types that take it), plus shots, cameras and easing, in its `$defs`. The `animation` toolset drops from about 827k to 123k characters of definitions, and `edit_animation` from about 303k to 24k. The per-type rules are still checked when an edit is applied, with errors naming the shot, command and field. The new read tool `describe_animation_command` returns the full JSON Schema of the command types you ask for. `MOTION_COMMAND_TYPE_SCHEMAS` (one strict schema per type) and `MOTION_COMMAND_FIELDS` (the fields each type takes) are now exported, and `MOTION_COMMAND_SCHEMA` stays the full, self-contained `oneOf`.
- 2459a49: Agents can now format rich text. The rich text tool provider adds `format_text` (set or clear bold, italic, underline, strike, inline code, links, highlight, text colour and font size on a range or the selection), `set_block_type` (paragraph, heading with a level, bulleted, numbered and task lists, quote, code block; one call switches between kinds) and `set_text_align`. Each is listed only for what the editor's schema supports and only while it is editable, applies as one undo step even when calls follow each other quickly, keeps the user's selection, and returns the range with the formatting or blocks it now has.

  Fix: `insert_text`, `replace_text`, `replace_range`, `replace_selection` and typed-out agent text are now one undo step per call. Calls that came within half a second of each other used to undo together.

## 0.139.1

### Patch Changes

- c691641: Smaller packages with type declarations that resolve for every consumer. Declarations are now written by `tsc`, one file per module, instead of tsup's bundler, which ran out of memory. Every `exports` entry gives `require` its own `.d.cts` types, so CommonJS projects on `moduleResolution: "node16"` no longer get TS1479 when they import a subpath. Source maps are no longer published, which shrinks `@pixerate/editor` from 52 MB to 22 MB unpacked. `@pixerate/editor-svelte/chart` exports `ChartInspectorSection` from a `.ts` module, so `node16` consumers can import it. The exported names and types are unchanged.

## 0.139.0

### Minor Changes

- 242f8f7: Vector brushstrokes can now have their brush's character: seeded size, angle, opacity and scatter jitter, and a procedural paper grain.

  - `VectorBrushstroke` gains an optional `seed` (an integer) and `paper` (`{ pattern, seed, scale, depth }`, or `null` for no grain). Only a layer with a seed renders with character, through `renderBrushstroke`'s `character` option with the grain in the path's own space. Layers without a seed render exactly as before, so existing documents keep their look.
  - `sanitizeVectorBrushstroke` keeps the new fields, and they round-trip through SVG. New exports: `sanitizeVectorBrushstrokePaper`, `vectorBrushstrokeCharacterError`, `randomVectorBrushstrokeSeed` and `VECTOR_BRUSHSTROKE_MAX_SEED`.
  - `addBrushstroke` and `setBrushstroke` take `seed` and `paper`. In a `setBrushstroke` patch, `seed: null` removes the seed and `paper: {}` restores the default paper. `getVectorAppearancePanel` reports each brushstroke's `seed` and `grain`.
  - React and Svelte: brushstrokes added from `VectorAppearancePanel` get a random seed, and each brushstroke row has a grain toggle.
  - Agents: `vector.addBrushstroke` and `vector.setBrushstroke` take described `seed` and `paper` arguments.

## 0.138.0

### Minor Changes

- 4e82172: Brushed strokes now look like their brush. Before, charcoal, pastel and pencil on the canvas all drew a plain round line.

  - `renderBrushstroke(…, { character })` renders a brush's character: its size, angle, opacity and scatter jitter, seeded so a stroke always gives the same bytes, and a procedural paper grain. The grain is sampled where the stroke lies on the paper (`origin`, `unit`), so neighbouring strokes share one sheet. It is applied once to the finished stroke and keeps texture at full pressure, which is what a mouse reports. Without `character`, output is unchanged. `paintPathStroke` and `pathStrokeDabs` gain the matching `jitter` and `grain` options.
  - The paper grain (`PaperGrain`, `grainHeights`, `grainCatch`) and the seeded noise (`TileableNoise`, `randSigned`, `seedFromString`) now live in `@pixerate/editor/paint`. The paint editor re-exports them unchanged.
  - Canvas: new brushed strokes store a `brush.seed` and render with character. They use the preset's own size unless a size is chosen (`FreehandStrokeStyle.brushSize`, stored as `brush.size`). Strokes saved before have no seed, so they render exactly as before, at the stroke width. `renderShapeBrushstroke` takes the node's `origin` and `unit` for the grain. The React and Svelte `ShapeNode` pass the node's position. `renderCanvasBrushSwatch` draws a brush-menu preview, and `useCanvasBrushes` / `createCanvasBrushes` accept `{ swatches }`.
  - Agents: `canvas.drawFreehand` with a `brush` uses the preset's size unless `width` is given.

## 0.137.0

### Minor Changes

- 685fce3: Brushstrokes on vector paths: a `brushstroke` stroke layer paints a path with a natural-media brush from the paint editor's library through the shared brushstroke renderer, with a size and a pressure profile; drawn on both canvases and exported to SVG (images, data round-trips) and PDF (image objects). New `addBrushstroke`, `setBrushstroke`, `vector.listBrushes` / `addBrushstroke` / `setBrushstroke`, and brushstroke rows in the appearance panels.

## 0.136.0

### Minor Changes

- 6971e80: Distortion brushes in the vector editor: a Distort Brush tool (D) that smudges, twirls, attracts, repels or roughens the outlines under a soft round brush, like CorelDRAW's distortion tools, with `vector.smudgeBrush` / `twirlBrush` / `attractBrush` / `repelBrush` / `roughenBrush` for agents and the brush options and circle in both bindings.
- e48d6ad: Generative prompts in the vector editor through `@pixerate/editor/generation`: `generateVectorArt` / `regenerateVectorArt` plan a prompt against a model, call the host's generator, and add the SVG (or the traced or stylised picture) as one editable group with its provenance; agent tools `list_vector_art_models`, `generate_vector_art` and `regenerate_vector_art` (idempotency keys required); `<VectorGeneratePanel>` and `useVectorGenerationTools` in React and Svelte.
- 45d710e: Bitmap-to-vector stylise in the vector editor: turn a PNG into mosaic tiles, halftone dots, low-poly triangles or engraving lines (`stylizeImage`, `stylizeVectorImage` and `vector.mosaicImage` / `halftoneImage` / `lowPolyImage` / `hatchImage`); the trace panels offer the styles.

## 0.135.0

### Minor Changes

- 3922096: Image editor: Clone Source transforms. The Clone Stamp and Healing Brush can lay the source scaled (width and height, negative to mirror) and rotated about the stroke start, sampled bilinearly. New in core: `controller.setCloneTransform`, `paint.cloneTransform`, `TransformedPixelSource` and `cloneSamplePoint`. Agents get the `set_clone_transform` tool, and `get_retouch_options` now returns the transform. The React and Svelte options bars have Source W, Source H and Source angle sliders, Flip H / Flip V and Reset transform. The clone source marker follows the transform.

## 0.134.0

### Minor Changes

- c0d64fd: Multipage vector documents with master pages: the top-level frames are pages, and master pages draw their art (laid out by resizing constraints, with `{page}` / `{pages}` in text) on every page that uses them, in the canvas and every export. New `addPage`, `addMasterPage`, `setPageMaster`, `movePage`, `goToPage`, the `vector.*Page*` commands, `parentId` on `vector.addText`, and `<VectorPagesPanel>` in React and Svelte. The skill's pitfalls moved to `references/pitfalls.md`.

## 0.133.0

### Minor Changes

- 4f8039d: Image editor: Blur, Sharpen and History Brush tools.
  - Blur and Sharpen lay a soft blur or an unsharp mask of the layer through the brush, at `strength`.
  - The History Brush paints the layer (or its mask) back from `historySteps` undo steps ago, or from the oldest state history keeps.
  - They work on pixels and masks at any bit depth, and each stroke is one undo step.
  - New agent tools: `blur_stroke`, `sharpen_stroke` and `history_brush`. The tools are in the palette (History on `Y`), with Strength and Steps back controls in the React and Svelte options bars.
  - New in `/paint`: `retouchFilter` and `boxBlurPixels`.
- dccb717: Image editor: Content-Aware spot healing. The Spot Healing Brush has a new `content-aware` type that synthesises texture and continues lines and patterns across the spot from patches all around it. It runs PatchMatch nearest-neighbour fields with patch voting, coarse to fine, and then blends seamlessly. It's available through `spot_heal` `type: "content-aware"` and the Content-Aware choice in the React and Svelte options bars. New `contentAwareFill` in `/paint`.
- b7ec850: Drawing in perspective in the vector editor: 1-, 2- and 3-point perspective grids whose floor and wall planes shapes are drawn on and flat art is attached to, like CorelDRAW's Perspective Drawing. New `setPerspective`, `setPerspectivePlane`, `attachToPerspective`, the `vector.*Perspective*` commands, the grid on the canvas and `<VectorPerspectivePanel>` in React and Svelte.

### Patch Changes

- 090b87f: Image editor at 16 and 32 bits: groups with layer effects and develop filters on the legacy process now composite in float in merges, `compositeDeepPixels` and the PSD merged image. New `applyLegacyFloat`.

## 0.132.0

### Minor Changes

- 6fab591: Image editor: the Clone Stamp and Healing Brush show their source on the canvas as a crosshair. It sits on the source point, and once an aligned stroke has fixed the offset, it follows the brush. The new `controller.cloneSourceMarker(cursor)` gives the position, and the renderer's new `cloneSourceMarker` render option draws it (filled from the brush cursor automatically, so the React and Svelte editors both show it).
- e1a6801: Image editor: 16-bit CMYK and Lab PSDs. A 16- or 32-bit document in CMYK or Lab mode now saves a 16-bit CMYK or Lab file (Photoshop has no 32-bit CMYK or Lab), separated through the profile at 16 bits (`colorModePlanes16`, `colorPlanes16` in `exportPsd`). 16-bit CMYK files now open at 16 bits, layers and masks included, through their profile.

### Patch Changes

- 7f213f2: PDF import keeps same-width ruled tables apart. Horizontal rules with the same extent were joined as one booktabs-style table even when they belonged to separate grids, so every ruled table of that width on a page, and the text between them, came out as a single table. Rules that meet a vertical rule now join only through their grid.

## 0.131.0

### Minor Changes

- fceeaca: Lens objects in the vector editor: a closed path that shows what is drawn below it magnified, fish-eyed, recoloured (brighten, invert, tinted grayscale, colour add, colour limit, heat map), as wireframe or through a see-through fill, like CorelDRAW's Lens. The lens follows edits below it and exports to SVG, PDF and Lottie. New `setLens`, `vector.setLens` / `vector.removeLens` and `<VectorLensPanel>` in React and Svelte.

## 0.130.0

### Minor Changes

- 8e1700d: A live Bevel path effect (`bevel`): a shaded chiselled edge inside each shape with the middle kept flat in its own paint, like CorelDRAW's Bevel. `vectorBevelFaces` is exported.
- 218817c: A live Extrude path effect (`extrude`): shapes drawn as solids with shaded side faces going back along an angle or toward a vanishing point, like CorelDRAW's Extrude. `vectorExtrudeFaces` and `shadeVectorColor` are exported.

## 0.129.0

### Minor Changes

- aaa0bcd: Image editor: Convert to Profile now also converts shape fills and strokes, text colours, layer-effect colours (gradient stops included) and annotation colours, and re-renders shape and type layers. Only smart objects are reported in `unconvertedLayerIds` now. New `convertColorFields` helper.

## 0.128.0

### Minor Changes

- 90caea3: Gradient paint for brushed freehand strokes on the canvas. A brushed stroke's `brush.paint` (and `FreehandStrokeStyle.paint`) takes a `PaintSource`-shaped value: one colour, or a gradient sampled dab by dab along the path by distance (in canvas units, the same at every zoom), pressure, tilt, direction, across the tip or at random. The stroke colour still gives the alpha and fills `paint` stops. `canvas.drawFreehand` takes an optional, strictly validated `paint` and returns it normalised; `velocity` and `time` mappings are refused because canvas strokes record no timing. New `validateCanvasBrushPaint` and the `CanvasBrushPaint` types, re-exported from the React and Svelte packages; `useCanvasDraw` / `createCanvasDraw` carry `style.paint`.

## 0.127.0

### Minor Changes

- ea85c96: Canvas provider effects: with an optional `EffectProvider`, shape nodes take an effect fill (clipped to the shape) or an overlay, with live play / hold, opacity and one undo step per change, and canvas scenes take a provider transition played over captured views when stepping into them. Adds `createCanvasEffectsController`, `createCanvasEffectsToolProvider` (`set_canvas_effect_mode`, `list_scene_transitions`, `set_scene_transition` plus the shared effect tools), `runCanvasNodeEffect` and `transitionCanvasView` in core; `useCanvasEffects`, `<CanvasEffectsProvider>`, `<CanvasEffectsPanel>` and a `transitions` option on `useCanvasScenes` in React; `createCanvasEffects`, `setCanvasEffectsProvider`, `<CanvasEffectsPanel>` and a `transitions` option on `createCanvasScenes` in Svelte.

## 0.126.0

### Minor Changes

- 480c798: Paint provider effects: with an optional `EffectProvider`, the paint editor takes effect paper (a generator drawn over the sheet and under the paint, multiplied by default so the paper's grain shows), effect layers (`addEffectLayer`, redrawn with `updateEffectLayer`, `rasterizeEffectLayer`), effect fills (`fillLayerWithEffect`) and light baked onto dried paint (`applyLightEffect`, any filter effect; thick paint keeps its relief). Each change is one undo step (a slider drag is one) and effect paper and effect layers are saved with the document. Adds `createPaintEffectsToolProvider` (`set_paper_effect`, `add_effect_layer`, `fill_layer_with_effect` and the shared effect tools) in core, and `<PaintEffectsPanel>`, `usePaintEffectsTools` and an Effects tab in `<PaintEditor>` (shown when a provider is registered) in React and Svelte.

## 0.125.0

### Minor Changes

- 64ae3fb: Provider effects in the animation and vector editors.

  - **Animation editor.** `applyMotionEffect` animates nodes with a provider motion effect. Its changes become ordinary commands tagged with `source`, so they preview, export to Flair and import like any command. `addVectorEffect` adds a vector effect's own picture as an artwork group with its shots. `updateMotionEffect` makes an effect again in place, and `removeMotionEffect` takes it out.
  - **Vector editor.** `addVectorEffect`, `updateVectorEffect` and `detachVectorEffect` work with groups tagged `providerEffect`.
  - **Agent tools.** New providers are `createAnimationEffectsToolProvider` (which adds `add_vector_effect`) and `createVectorEffectsToolProvider`.
  - **UI.** React and Svelte add `<AnimationEffectsPanel>`, `<VectorProviderEffectsPanel>`, an `effects` prop on `<AnimationEditor>` and `<VectorEditor>`, `useAnimationEffectsTools` and `useVectorEffectsTools`. `<EffectsBrowser>` gains a `kinds` filter.
  - **Fake provider.** It gains `fake.badge`, a vector effect with its own picture.

## 0.124.1

### Patch Changes

- e501ee0: Keep GPU effect providers within the browser's WebGL context limit. `EffectRendererPool` keeps at most four live renderers (`maxRenderers`) and disposes the least recently used one once its renders finish; the video and image effects engines render through it. `renderEffectThumbnail` renders one thumbnail at a time and caches the results per provider. Before this, browsing Flair's catalog lost contexts and left thumbnails and clip effects blank. `<EffectsBrowser>` now scrolls its grid within a fixed height.

## 0.124.0

### Minor Changes

- 244ccba: Gradient paint for brushstrokes along paths. `renderBrushstroke(…, { paint })` and `paintPathStroke(…, { paint: { paint, seed } })` take a `PaintSource`: one colour, or a gradient sampled dab by dab by distance along the path, pressure, tilt, speed, direction, time, across the tip or at random, through the same `gradientDabColor` the paint editor uses. Distance gradients scale with `renderBrushstroke`'s `scale`, so a stroke looks the same at every zoom. `pathStrokeDabs` now records each dab's `params` (travel, index, pressure, lean, speed, direction, time), and `PathSample` takes an optional time `t`.
- bd1ff5f: Add `@pixerate/editor/effects`, a dependency-free contract for optional effects providers. `EffectProvider` lists, searches and describes effects (strict JSON Schema controls, defaults, presets and named inputs) and creates frame-exact renderers at 8, 16 or 32 bits with masks, plus `applyVectorEffect` for vector motion. Typed errors (`UnknownEffectError`, `EffectControlError`, `EffectUnsupportedError`, `EffectDisposedError`, `NoEffectsProviderError`), capability flags, `resolveEffectValues`, `searchEffectSummaries`, `applyEffectMask`, `EffectsSlot`, a `checkEffectProvider` conformance check for provider test suites, and `createFakeEffectProvider`, a deterministic CPU provider for tests and demos.

  `FlairSvgAnimation` gains Flair's `tag`, `format`, `decimals` and `caret` fields. `checkEffectProvider` accepts `unsupported` from a vector effect's renderer and from the vector probe.

- d995e9d: Optional provider effects in the image editor. With an `EffectProvider` (`effects` option, `setEffectsProvider` / `useEffects`), filter effects become `effect` smart filters (`applyEffectFilter`; a pixel, shape or type layer converts to a smart object in the same undo step) with blend, opacity, order and the filter mask. Generator, overlay and title effects become effect layers (`addEffectLayer` / `updateEffectLayer` / `rasterizeEffectLayer`): pixel layers with a `generator`, rendered at the document's size and bit depth. Effect filters render in the background (`ImageEffectsEngine`). Without a provider they pass pixels through, and effect layers keep their pixels; both round-trip through JSON. New agent tools via `createImageEffectsToolProvider`: the shared effect tools plus `add_effect_layer`. React and Svelte add `<ImageProviderEffectsPanel>`, `<ImageEditor effects>` and `useImageEffectsTools`.
- 27b6502: Optional provider effects in the video editor. With an `EffectProvider` (`effects` option, `setEffectsProvider` / `useEffects`), clips get an ordered effect stack (`effects`, with enabled, opacity and keyframable values), transitions can use a provider effect (`type: 'effect'`), and effect clips (`type: 'effect'`) draw generators, titles and overlays. Effects render frame-exact through the provider, cached per frame (`VideoEffectsEngine`), in the preview and in `renderVideoFrameExact`. `toVideoFfmpeg` refuses projects with enabled provider effects unless it gets the rendered `frames`. Without a provider, projects keep their effects and show them as placeholders. New agent tools: `search_effects`, `describe_effect`, `list_applied_effects`, `apply_effect`, `update_effect`, `remove_effect`, `add_video_effect_clip`, `set_video_effect_transition` and `set_video_effect_keyframes` (`createVideoEffectsToolProvider`; the shared `createEffectToolProvider` is in `@pixerate/editor/effects`). React and Svelte add a new `effects` subpath with `<EffectsBrowser>`, `<EffectParameters>`, `<EffectThumbnail>` and `useEffects`, plus `<VideoEffectsPanel>`, `<VideoEditor effects>` and `useVideoEffectsTools`.

## 0.123.0

### Minor Changes

- 09befd1: Brushed freehand strokes on the canvas, opt-in. `FreehandStrokeStyle.brush` takes a dry paint preset id (`ink-pen`, `pencil-hb`, …) or tip settings. The stroke stays a path shape node and gains `data.shape.brush`, with pressure and tilt profiles along its length taken from the pen, so selecting, erasing, grouping and export work as before. It is drawn with the paint engine's `renderBrushstroke` and re-rendered when the path, the brush or the zoom bucket changes. The paint engine loads only when the first brushed stroke is drawn. Strokes without a brush are unchanged.

  - Core: `renderShapeBrushstroke`, `getBrushedShapeSvg` (SVG with the image embedded), `listCanvasBrushes`, `pointerPenSample`. The draw controller takes pen samples in `startStroke` / `continueStroke`, and its `drawStroke` draws a whole stroke in one undo step.
  - Agents: `createDrawCommands` adds `canvas.drawFreehand` (points, tool, colour, width, opacity, `brush`, and `pressure` / `tiltX` / `tiltY` profiles; wet brushes are refused) and `canvas.listBrushes`.
  - React: `<ShapeNode>` draws brushed shapes, `<ShapeNodeZoomProvider>` keeps them sharp, `useCanvasBrushes` lists the brushes, and `<CanvasDrawLayer>` passes pen pressure and tilt (coalesced events for brushed strokes).
  - Svelte: the same, with `setShapeNodeZoom` and `createCanvasBrushes`.

- 280b767: Helpers for building a paint layer on an infinite canvas yourself (the demo has a recipe):

  - `@pixerate/editor/raster`:
    - World ↔ surface mapping: `worldToSurface`, `surfaceToWorld`, `worldRectToSurface`, `screenToWorld`, `visibleSurfaceRect`.
    - A resolution policy: `surfaceResolutionForZoom` and `surfaceMipLevel`.
    - `drawSurfaceToViewport` / `SurfaceViewportRenderer`, which draws the visible tiles of a surface onto a 2D context at the right mip level with seam-free placement. Tile images are cached by tile and the canvas factory is injected.
  - `@pixerate/editor/paint`:
    - `pointerStrokeSamples` / `pointerStrokeSample` / `pointerPressure` turn Pointer Events into stroke samples in your coordinates, with pen pressure, tilt and coalesced events. The paint and image editors now share `pointerPressure`.
    - `WetWorld.stepRegion` / `stepRegionSync` simulate only the live wet tiles that touch a region (the viewport), holding the rest still.

- aea6c2c: Gradient paint: a colour slot can hold a gradient (`PaintSource`) that brushes sample dab by dab, by distance dragged out (the default: 300 px, mirrored), pressure, tilt, speed, direction, time, across the tip or at random, mixed as pigment, Oklab or sRGB, with opacity stops, midpoints and softness. Every colour engine paints it (dab, Mixer Brush, watercolour and gouache, oil and impasto, particles, bristles, stickers), in the paint editor (`setPaint`, `paint` on strokes, `brush.paint`, gradient swatches) and the image editor's brush (`PaintOptions.paint`, also on masks and at 16 / 32 bits). Strokes record the resolved gradient, so replays and re-renders are exact.

  The multi-colour brush is now a brush's own gradient (`brush.paint`): `behavior.multicolor` is still accepted on input and in old documents and presets, converted to the gradient that paints the same pixels, and reported back as a read-only view when the gradient has a multi-colour equivalent. New agent tools: `set_paint` (both editors), `get_paint` (image editor); `paint_stroke` takes `paint`, `set_brush` takes `paint`, `get_brush` returns `paint` and `strokePaint`, `add_swatch` takes `paint`. React and Svelte add `PaintGradientEditor` to the colour panel, the brush panel (replacing the multi-colour controls) and the image editor's brush options.

- b89d301: Wet media: Engine B, a WebGPU accelerator for large wet areas. With `navigator.gpu` and at least 16 wet tiles (256 px), the wet step and the display shading also run in WebGPU compute shaders on the CPU engine's tile layout, and every stale tile is shaded at once instead of in main-thread JavaScript. Between strokes the GPU runs up to 16 steps ahead within the batch the CPU is computing, so large washes keep moving on screen. The CPU engine stays the authority: drying, saving, export and replay are byte-identical with the GPU on or off, and the display stays within 1/255. New in `/paint`: `createWetGpuEngine`, `wetGpuSupport`, `WetGpuEngine`, `WetWorld.attachGpu` and `displayGpu`. New in the paint editor: the `gpu` and `gpuMinTiles` wet options, `setWetEngine`, `wetEngine`, `engine` in `wetState`, `wetEngineSummary`, and the `set_wet_engine` agent tool. React and Svelte `WetPanel` get an engine select (GPU for large washes, or CPU only) and a status line.

## 0.122.0

### Minor Changes

- ef69e0c: Image editor at 16 and 32 bits: layer filters (develop, blur) and layer effects now composite in float in merges, `compositeDeepPixels` and the PSD merged image, instead of being drawn at 8 bits. `compositeLayerEffects` accepts float buffers, and new float filters are `applyProcess2Float`, `applyBoxBlurFloat` and `runLayerFiltersFloat`. Groups with effects and legacy-process develop filters still render at 8 bits.

## 0.121.0

### Minor Changes

- 65b098b: `renderBrushstroke(samples, brush, { scale, color })` in `@pixerate/editor/paint` renders a dry brushstroke on its own, to RGBA bytes and its bounds in path units. Samples are a polyline with pressure, tilt and time, or points plus pressure and tilt profiles along the length. Brushes are tip settings or dry paint-editor presets; wet, mixer, blender, smudge and eraser brushes are refused with an error saying why. `brushstrokeScaleBucket` snaps a zoom to a power of √2, `BrushstrokeCache` keeps recent renders by path, brush, colour and scale, and `brushstrokeDataUrl` / `brushstrokeToCanvas` (with an injected canvas factory) turn the result into a PNG or a canvas. Built on `paintPathStroke`; deterministic and DOM-free.

## 0.120.0

### Minor Changes

- ee7b0c3: A live Block Shadow path effect (`blockShadow`): each shape swept along an angle and drawn under the art as one solid shadow, fading into a long shadow with `endOpacity`, like CorelDRAW's Block Shadow. `sweepPath` exposes the sweep.

## 0.119.0

### Minor Changes

- 3e194c8: Image editor: 16- and 32-bit layer masks. Deep PSD masks open and save at depth, the compositor blends with their full precision, `set_bit_depth` converts masks with their layers, v3 JSON stores their samples (`deep` on a stored mask), and the brush, eraser, Fill and Clear paint masks at depth.
- 9dcd2eb: Image editor at 16 and 32 bits: the Mixer Brush, Smudge, Sponge, Clone Stamp, Healing Brush and Spot Healing now keep a deep layer's precision. They run on float working tiles, and Clone and healing sample the layer's deep samples or the float composite. The paint engine's `TileMedium` and `TilePixelSource` accept float tiles (`PaintPixels`, `put255`); 8-bit behaviour is unchanged.
- 2de12be: A live Contour path effect: concentric offset steps (inside, outside or to the centre) whose colours blend toward end colours, like CorelDRAW's Contour. Effect parameters gain a `color` kind, and the effects panels edit it.
- 023d27d: Live vector symmetry groups.

  - **Modes:** mirror (vertical, horizontal, four quarters or diagonal) or radial, with an optional kaleidoscope mirror. Copies follow every edit.
  - **Draw inside:** new pen, pencil, shape and text art goes into the group and is mirrored as it is drawn.
  - **Release or Expand:** stop repeating, or keep the copies as real objects.
  - **New agent commands:** `vector.makeSymmetry`, `vector.setSymmetry`, `vector.releaseSymmetry`, `vector.enterSymmetry` and `vector.exitSymmetry`.
  - `vector.addShape` and `vector.addPath` take a `parentId`.
  - **New components:** `VectorSymmetryPanel` for React and Svelte.

## 0.118.0

### Minor Changes

- 7f8d2f4: Faster vector rendering.

  - **Reuse:** `getVectorSceneRenderData` reuses render data for nodes an edit did not touch.
  - **Culling:** with `viewportSize`, nodes off screen are left out.
  - **Level of detail:** groups, text and instances under 2 screen pixels draw as one rectangle. The `lod` option sets the threshold.
  - **Canvases:** both canvases pass their size and skip unchanged nodes.

## 0.117.0

### Minor Changes

- f5971d7: Image editor at 16 and 32 bits: Free Transform, warps, flips and moves resample a deep layer's samples (16-bit sRGB, 32-bit linear light; whole-pixel moves are exact), and Dodge and Burn tone them. The tools that still compute in 8 bits (Mixer Brush, Smudge, Sponge, Clone Stamp, healing, filters, mask painting) now keep the deep samples of every pixel they leave alone instead of dropping whole tiles to 8 bits. New `keepDeepSamples` in `/raster`.
- 416c888: Image editor: brush and eraser strokes, Edit › Fill and Clear now keep a 16- or 32-bit document's precision on the tiles they touch (16-bit in sRGB-encoded samples, 32-bit in linear light) instead of dropping them to 8 bits.
- 9eeae92: Lottie export and import for vector documents.

  - `toLottie` / `vectorDocumentToLottie` export, keeping path effects live as Lottie modifiers and gradients as gradient fills.
  - `importLottie` / `parseVectorLottie` read one frame. Modifiers become live effects, and layers, parenting, precomps and additive masks are supported.
  - Each direction returns notes on what was approximated.
  - New agent commands: `vector.exportLottie` and `vector.importLottie`.

- 0048753: Vector PDF export, as real paths rather than a picture.

  - Gradients become PDF shadings; opacity and blend modes become graphics states.
  - Clip masks and stroke alignment are kept.
  - Writes one page, or one page per artboard.
  - New API: `toPdf` and `vectorDocumentToPdf`.
  - New agent command: `vector.exportPdf`.

## 0.116.0

### Minor Changes

- 116de0e: Oils and thick paint in the paint editor. Wet oil runs on the wet simulation as a thick, slow-drying medium that blends into the wet paint it meets (`wet.medium`: watercolour, gouache or oil, with paint loading and thinner). Thick paint (`engine: 'impasto'`) gives a layer height and material channels (gloss, metallic) lit at render time by a movable light: impasto brush, paint tube, palette knife, roller, gloop pen and metallic paint, with paint loading and thinners. Instant dry, metallic paper, and relief and lighting saved with the document. New agent tools `set_lighting`, `get_relief`, `flatten_relief` and `set_instant_dry`; React and Svelte add impasto and medium menus in `<BrushPanel>`, a light section in `<PaperPanel>` and Instant dry in `<WetPanel>`.
- 3344fab: Procedural brushes, bristles, stickers and stencils in the paint editor. Particle brushes (`engine: 'particle'`: spring-and-mass strings, springs, orbits and flow particles, drawn as dots, lines or bead sequences), bristle brushes that splay, flatten, bend and run dry bristle by bristle, and sticker spray of procedural stamps that stay editable objects on a sticker layer (`list_stickers`, `update_sticker`, `arrange_stickers`, `remove_stickers`). Stencils: ruler and arc guides that strokes follow, and line and shape masks (`add_stencil`, `update_stencil`, `remove_stencils`), recorded with strokes so replays keep them. `@pixerate/editor/paint` adds `paintPathStroke` / `pathStrokeDabs` for brushstrokes along polyline paths with pressure and tilt profiles. React and Svelte add particle, bristle and stamp controls, stencil buttons and outlines, and `<StickerPanel>`.
- 116de0e: Time-lapse and high-resolution replay in the paint editor. `timeLapse()` repaints the painting from its recorded strokes and events (fills, clears, flattened relief and wet-media events at their simulation clock; wet strokes point by point, so wet paint flows as it did) and returns PNG frames, a video project of the frames and the ffmpeg command from the video editor's export path (`timeLapseZip` packs them); `renderHighRes({ scale })` repaints at 2–8× instead of upscaling. Fills, clears and relief flattening are now recorded for replays (`paintEvents`), and wet events record where they fall between strokes. New agent tools `export_time_lapse` and `export_high_res`; React and Svelte toolbars add Time-lapse and PNG 2×.
- 66ab4c4: Wet media in the paint editor (watercolour first). A lattice Boltzmann water and pigment simulation (`WetWorld` in `@pixerate/editor/paint`) runs on sparse 256 px tiles in WebAssembly SIMD, in Web Workers on shared memory when the page is cross-origin isolated and on one thread otherwise, with a TypeScript kernel that gives the same bits; the ~8 KB kernels load lazily as a separate chunk. Results are deterministic across browsers, kernels and thread counts. The paint editor gets wet brushes (Watercolour round, Wash brush, Watercolour rigger, Gouache) and wet tools (Add water, Dry, Blow, Wet blend, Wet smudge, Blot) with wet-in-wet, edge darkening, granulation, blooms, colour bleed, glazing, re-wetting, canvas tilt with drips and flow maps; dry now, pause, speed and a water overlay; wet paint dries deterministically on save and export, and undo restores the wet state. New agent tools: `get_wet_paint`, `advance_wet_paint`, `dry_paint`, `wet_paper`, `set_wet_settings`, `set_flow_map`, `set_canvas_tilt`, `pause_wet_paint`, `set_water_overlay`. React and Svelte add `<WetPanel>`, a wet tool menu in `<BrushPanel>`, and the wet clock and water overlay in `<PaintCanvas>`.
- 78e6f18: Gradient meshes and freeform gradients for vector paths.

  - Meshes are smooth Coons patches over a lattice of coloured points. Freeform gradients are colour points with spreads and lines.
  - Both render as SVG pattern tiles, move with their paths and round-trip through SVG.
  - In the Gradient tool, drag points to move them, click to add a freeform point and Alt-click to remove one.
  - New controller methods: `setMeshGradient`, `setMeshPoint`, `setFreeformGradient`, `addFreeformPoint`, `setFreeformPoint`, `removeFreeformPoint`, `setFreeformLines` and `getShading`.
  - New agent commands, one per controller method.
  - New `VectorShadingPanel` components for React and Svelte.

- 2a89b60: Vector Image Trace turns raster pixels into paths.

  - **Black and white:** traces by darkness or by alpha.
  - **Colour:** stacked paths, one per colour, after median-cut quantising.
  - **Options:** tolerance, minimum area and corner roundness.
  - **New API and agent command:** `traceImage`, `traceVectorImage` and `vector.traceImage`, which takes a PNG data URL.
  - **New components:** `VectorTracePanel` for React and Svelte.

## 0.115.0

### Minor Changes

- 051ea82: Add CMYK and Lab document modes. CMYK PSDs now open through their embedded CMYK profile (or the default coated CMYK) instead of a plain ink approximation, and keep CMYK mode; Lab PSDs keep Lab mode. `setColorMode('cmyk' | 'lab' | 'rgb', { profile, intent })` (and the `set_color_mode` agent tool) keeps editing in RGB, soft-proofs a CMYK document through its profile, and makes `toPsd` write CMYK (with the profile in resource 1039) or Lab channels. `<ColorProfilePanel>` gets a Mode menu in React and Svelte.

## 0.114.0

### Minor Changes

- 08884db: Add colour management. New `@pixerate/editor/cms`: a TypeScript ICC engine (ICC v2 / v4 profiles with matrix/TRC, grey and LUT tags, ICC v4.3 writing, transforms with all four rendering intents and black point compensation, soft-proof chains, gamut checks, built-in sRGB, Display P3, Adobe RGB- and ProPhoto-compatible, Rec. 2020, grey, Lab and a synthetic coated CMYK, and embedded profiles in PNG / JPEG / PSD). The image editor gets a document colour profile (working space) in history and JSON, `assignProfile` / `convertToProfile` with intents and BPC, a colour-managed viewport, `setProofSetup` soft proofing with a gamut warning, profiles read from and written to PSD and embedded in PNG / JPEG exports, `convertColors`, and the `get_color_profile`, `assign_profile`, `convert_to_profile`, `set_proof_setup` and `convert_colors` agent tools. React and Svelte get `<ColorProfilePanel>` in the Layers tab.
- aade46b: Composite at 16 and 32 bits: `DeepCompositor` in `@pixerate/editor/raster` runs the layer model (blend modes, masks, clipping, groups, filter layers) in float over the layers' deep samples, in sRGB at 16 bits and linear light at 32. The image editor uses it for merges, the PSD merged image and the new `compositeDeepPixels()`, and runs adjustment layers in float there (`applyAdjustmentLayersFloat`; Levels without 8-bit quantisation).
- 3a2fc3d: Add 16-bit and 32-bit float layers, additively. `@pixerate/editor/raster` tiles may carry deep samples (`Uint16Array` sRGB or `Float32Array` linear light) next to their 8-bit rendering, so every 8-bit consumer, the paint editor included, works unchanged; new `deepTile`, `readDeepRegion`, `writeDeepRegion`, `convertSurfaceDepth`, `surfaceFromDeepPixels` and sample conversions. The image editor gets a document bit depth (`setBitDepth`, `bitDepth`, Image › Mode as one undo step), opens and saves 16- and 32-bit PSDs at their depth (layers in Lr16 / Lr32), keeps deep samples in v3 JSON, and exposes `set_bit_depth` plus `bitDepth` in `get_image_info` to agents. React and Svelte `<LayersPanel>` show a Bits per channel menu.
- e0f9a18: Vector connectors: open paths whose ends are glued to other objects' sides or centres.

  - Connectors follow those objects through every edit.
  - Routes can be straight, elbow (with an optional bend radius) or curved. `auto` sides pick the side facing the other end.
  - A Connector tool (X) shows connection sites as you draw. Settings round-trip through SVG.
  - New controller methods: `addConnector`, `setConnector`, `getConnectors` and `getConnectionSites`.
  - New agent commands: `vector.connect`, `vector.setConnector`, `vector.listConnectors` and `vector.listConnectionSites`.
  - New `VectorConnectorPanel` components for React and Svelte.

- 8438ea7: Vector constraints: CAD-style geometric constraints and dimensions between anchors, segments and round paths (coincident, collinear, concentric, fix, parallel, perpendicular, horizontal, vertical, tangent, smooth G2, symmetric, equal, distance, angle, radius, diameter) with named parameters and expressions, solved after every edit (edited geometry moving least), conflicts and redundancy refused, degrees of freedom, Auto Constrain, stable anchor ids, canvas glyphs and `vector.*Constraint` agent commands. React and Svelte add `VectorConstraintsPanel`.
- 056722d: Vector live corners: squircle corner smoothing (`corner.smoothing`, `setCornerSmoothing`, `smoothing` on `vector.setCorners`), Figma / iOS style continuous corners at any angle, with a Smoothing slider in the React and Svelte style panels.
- 48ba7ca: Vector frames and artboards with resizing constraints.

  - A group with `frame` set draws a background and clips its children, and selects and snaps by its rectangle. Top-level frames are artboards, and their names show on the canvas.
  - New ways to make and edit frames: the Frame tool (F), `addFrame`, `frameSelection` and `setFrame`.
  - When a frame is resized, its children follow their `resizing` constraints: left, right, left & right, centre or scale, and the vertical equivalents.
  - `frameToSvg` exports a single artboard. SVG export and import round-trip frames.
  - New agent commands: `vector.listFrames`, `vector.addFrame`, `vector.frameSelection`, `vector.setFrame`, `vector.setResizing` and `vector.exportFrameSvg`.
  - New `VectorFramePanel` components for React and Svelte.

- fa91d30: Vector symbols and instances: `VectorDocument.symbols` and `instance` nodes that draw a symbol through a transform that may scale and skew, Make Symbol, Place, Replace, Detach, per-instance tints and hidden parts, Edit Symbol in isolation mode (the document dimmed behind, undo stepping in and out), SVG `<symbol>` / `<use>` export and import (foreign `<use>` included) and `vector.*Symbol` agent commands. React and Svelte add `VectorSymbolsPanel` and draw isolation mode in the canvas.
- 1747793: Vector text: point, area and path text nodes in `@pixerate/editor/vector`, with styled runs, paragraph styles, the Type and Type on a Path tools, on-canvas editing, Create Outlines, SVG text export / import and `vector.*Text` agent commands. Text lays out with the engine of the image editor's type layers, now shared in `src/text` (the image editor re-exports it unchanged), and a built-in OpenType reader (`parseOpenTypeFont`, `loadOpenTypeFont`) gives the outline shaper glyphs from TrueType, CFF and WOFF files. React and Svelte add `VectorTextPanel` and `VectorTextElement`, and the canvases take typing through a hidden textarea.
- 6224007: CAD-style drawing aids in the vector editor: object snap tracking, polar increments and typed dimensions.

  - **Object snap tracking:** rest on an anchor to acquire it. It then sends alignment paths, plus an open path's extension, and points snap where those paths cross.
  - **Polar tracking:** pick an increment (`vectorPolarAngles`), optionally measured from the last segment.
  - **Typed entry while the pen draws:** a distance, `length<angle`, an `@offset` or a position. `placePenPoint` does the same from code, and `addPathByDimensions` draws a whole path from dimensions.
  - **New agent commands:** `vector.getSnapOptions`, `vector.setSnapOptions` and `vector.addPathByDimensions`.
  - **Bindings:** the canvases draw tracking markers and the typed entry, and the toolbars gain a polar increment picker.

### Patch Changes

- dbed701: Vector editor: an R-tree spatial index (`VectorRTree`, `vectorSpatialIndex`, `vectorNodesNear`) makes hit-testing, marquee selection and snapping to segments fast in documents with hundreds of objects, with results identical to a scan.

## 0.113.0

### Minor Changes

- 320bfb0: Add the image editor's retouching tools on the shared brush engine: Clone Stamp (aligned or non-aligned source point, sampling the layer, the layers up to it or all layers), Healing Brush and Spot Healing Brush (Poisson seamless cloning, proximity match or a smooth fill), Smudge, Dodge and Burn (shadows / midtones / highlights, exposure, Protect Tones) and Sponge (saturate / desaturate, vibrance). They respect pressure, the selection, locks and mask targeting, and each stroke is one undo step. `@pixerate/editor/paint` exports the kernels (`applyRetouchToTile`, `RetouchDabStroke`, `healPixels`, `spotHealPixels`, `seamlessClone`, `dodgeBurn`, `sponge`). The image editor gains `setCloneSource`, `setPaintOptions({ retouch })`, Alt-click to set the source, shortcuts S / J / Shift+J / O / Shift+O, and ten agent tools (`clone_stamp`, `heal_brush`, `spot_heal`, `smudge`, `dodge`, `burn`, `sponge`, `get_retouch_options`, `set_retouch_options`, `set_clone_source`). `<BrushOptionsBar>` shows each tool's options in React and Svelte.

## 0.112.0

### Minor Changes

- 84adf61: Open and save Photoshop shape and type layers as live layers. PSD import reads shape layers' paths (`vsms` / `vmsk`, with Photoshop's path operations and inverted shapes), fills (`vscg` or `SoCo` / `GdFl` / `PtFl`), strokes (`vstk`) and live rectangles, rounded rectangles, ellipses and lines (`vogk`), and type layers' `TySh` (text, character and paragraph runs from the EngineData, point or box frame, transform); type keeps Photoshop's pixels until it is edited, and `loadPsd` warns about fonts the text shaper lacks. PSD export writes shape and type layers as Photoshop shape and type layers, writing the blocks read from a file back byte for byte while a layer is unchanged and patching the file's EngineData when text changes.
- 1069f21: Shape and type tools in the React and Svelte image editors. `<ImageEditor>` gains a Shape tool (drag to draw live rectangles, ellipses, polygons, stars and lines; Shift for squares, circles and 45° lines, Alt from the centre) and a Type tool (click for point text, drag for a paragraph box, click existing text to edit it on the canvas with a caret, selection, arrow keys, Backspace / Delete, Enter, Cmd/Ctrl+A and IME input; Esc finishes). New `<ShapeOptionsBar>` (kind, fill, stroke, width, radius, sides, points, line weight and arrowhead; edits the active shape too) and `<TypeOptionsBar>` (font from the editor's fonts, size, bold, italic, colour, alignment; styles the selection while editing). `<LayersPanel>` shows thumbnails with a badge for shape and type layers and warns about missing fonts. Core adds the shared logic (`ShapeDrawGesture`, `applyShapeOptions`, `TypeToolGesture`, `TextEditSession`, `typeLayerAt`, `layerHasThumbnail`, `layerWarning`), the `shape` and `type` tools and the renderer's `textEdit` overlay. The demo's Image tab adds a poster agent script.

## 0.111.0

### Minor Changes

- 890d424: Add live type layers to the image editor. A `TypeLayer` holds text with character runs (font family, weight, italic, size, colour, opacity, tracking, leading, baseline shift, underline, strike-through) and paragraph runs (alignment including justify, auto leading, indents, spacing), set as point text or wrapped paragraph text and placed by an affine transform. Layout is built in; fonts come through a pluggable `TextShaper`: `createCanvasTextShaper` (the browser's fonts through Canvas 2D, the default) or `createOutlineTextShaper` (glyph outlines from opentype.js-style font objects, pure, and what Convert to Shape needs). Missing fonts fall back with a warning (`missingFonts`); without a shaper, type layers keep their stored pixels. New controller methods: `addTextLayer`, `getTextLayer`, `setText`, `setTextStyle`, `setParagraphStyle`, `setTextFrame`, `convertTextToShape`, `getTextLayout`, `textIndexAt`, `textCaret`, `listFonts`, `setTextShaper` (and the `textShaper` option); new agent tools: `list_fonts`, `get_text_layer`, `add_text_layer`, `set_text`, `set_text_style`, `set_paragraph_style`, `set_text_frame`, `convert_text_to_shape`. Text annotations now load as type layers that draw the same and keep the annotation API working. Free Transform, moves, masks, effects, blend modes and `rasterizeLayer` work on type layers.

## 0.110.0

### Minor Changes

- b15241c: Paint editor phase 2 blending and painterly mixing. `@pixerate/editor/paint` gains the shared pick-up / mix exchange (`PaintExchange`, `PaintMedium`, `TileMedium`, `exchangeRates`), which the Mixer Brush now runs on with identical output and which the wet layer will plug into as another medium; a blender (`blenderDab`) that mixes the colours under and near the tip through the pigment model, with strength and blend distance; and a patch-carrying smudge (`SmudgeTip`) with strength, length and an RGB or pigment mixing option. The paint editor adds `blender` and `smudge` brush engines and drives them, the Mixer Brush and wet-capable dab brushes through a new dab-by-dab engine (`PaintDabStroke`) with full pen input, paper grain and symmetry. Brushes gain `behavior`: pick-up and mix ratios, a dirty brush that carries the last colour it touched into the next stroke, and a multi-coloured brush (colours across the tip, or per dab in sequence or at random). New presets: Pigment smudge, Dirty round, Multi-colour flat and Palette dabber; Blender and Smudge use the new engines. Recorded strokes keep their starting load so pick-up strokes replay exactly. The mixing pad mixes measured parts (`mixOnPad`), and pads can be kept by name and are saved with the document. New agent tools `mix_on_pad`, `save_mixing_pad`, `list_mixing_pads`, `load_mixing_pad` and `remove_mixing_pad`; `set_brush` takes `behavior`, `blender` and `smudge`; `mix_colors` takes `model` (`pigment` or `rgb`).

### Patch Changes

- a48e5ce: Paint editor blending UI, in parity for React and Svelte. `BrushPanel` gains an engine section from the shared `brushEngineControls`: blender strength and blend distance, smudge strength and length, pick-up and mix ratios, Mixer Brush load, Pigment / RGB mixing, a dirty-brush toggle, multi-colour mode, colours, order, softness and dabs per colour, and a swatch of what the brush carries with Load / Clean. It also has a brush blend menu grouped into Standard and Paint modes. The `ColorPanel` mixing pad gains a pick sample size, a Mix button for the paint and second colours in parts, and Keep pad with a list of kept pads. Core adds the shared helpers `brushEngineControls`, `multiColorSliders`, `patchBrushValue`, `brushLoadColor`, `PAD_SAMPLE_SIZES` and `padSampleRadius`, and the palette knife becomes a pigment smudge that drags streaks of both paints.

## 0.109.0

### Minor Changes

- 401f685: Add vector shape layers to the image editor. A `ShapeLayer` holds components (live rectangles with corner radii, ellipses, polygons, stars and lines with arrowheads, or free paths) combined with Photoshop's path operations (combine, subtract, intersect, exclude), a fill and a stroke (colour, gradient or pattern; width, alignment, caps, joins, miter limit, dashes). Shapes render without a canvas into the layer's tiles and re-render on every change, so moving and Free Transform map the paths and never degrade them; masks, clipping, blend modes, fill opacity and layer effects work as on pixel layers, and `rasterizeLayer` turns a shape into pixels. New controller methods: `addShapeLayer`, `getShapeLayer`, `setShapeStyle`, `setShapeComponent`, `addShapeComponent`, `removeShapeComponent`, `mergeShapeComponents`; new agent tools: `get_shape_layer`, `add_shape_layer`, `update_shape`, `set_shape_component`, `add_shape_component`, `remove_shape_component`, `merge_shape_components`. Pen, rectangle, ellipse, line and arrow annotations now load as shape layers that render as before; the `annotations` state, the annotation methods and `selectedAnnotationId` keep working on them, and v1 / v2 documents still save back unchanged. PSD export writes shape layers as pixel layers for now.

## 0.108.0

### Minor Changes

- 079cf0b: Paint editor agents now work directly on the canvas. `PaintDirector` acts out `paint_stroke` live with the agent's cursor (paced by the points' times, still one undo step), rubs `fill_layer` across the sheet and starts `replay_strokes` from the strokes it copies. Pass `director` to `createPaintEditorToolProvider`, and `presence` to `<PaintEditor>` / `<PaintCanvas>` (React `usePaintDirector`, Svelte `createPaintDirector`). `PaintEditorController.checkPoints` is now public.
- 4a4809e: Masks and clipping in the vector editor (`@pixerate/editor/vector`). A group with `mask: { type: 'clip' | 'alpha' | 'luminance', invert? }` uses its first (bottom) child as the mask: a clipping mask shows the other children inside the mask's outline, an opacity mask by its alpha or brightness, and `invert` swaps them. Hiding the mask turns it off. Hit-testing, bounds, snapping, outlines, booleans and the Pathfinder use the masked result, and open paths are cut where they cross the clip. The group's filters, opacity and blend mode apply to the masked result, and its path effects to the contents. SVG export writes `<clipPath>` / `<mask>` (with a lossless round-trip), and import now reads `clip-path` and `mask` references instead of skipping them. The controller adds `makeMask`, `releaseMask`, `setMaskOptions`, `editMask` and `editMaskContents` (Mod+7 and Mod+Alt+7), and agents get `vector.makeClippingMask`, `vector.makeOpacityMask`, `vector.setMaskOptions` and `vector.releaseMask`; `vector.list` reports each mask group's `mask`. Scene render data gives masked groups a `mask` (`VectorRenderMask`), and the overlay gives mask indicators (`masks`). React and Svelte draw masks in `VectorCanvas` (`VectorMaskedNodes`), add `VectorMaskPanel` to the style panel (make, release, type, invert, on / off, Edit Mask, Edit Contents), and add mask actions to `VectorToolbar`. `eraseFromOutline` takes `keep: 'inside'` to keep the parts inside a region.

## 0.107.0

### Minor Changes

- ccb32d4: Add four painterly blend modes to the shared blend set: `watercolor` (transparent washes that multiply per wavelength through the pigment model's spectra, so blue over yellow glazes green), `tint` (the source's colour on the backdrop's Oklab lightness, gently near white and black), `highlight` (coloured light added with a soft shoulder that never clips) and `shadow` (light taken away with ambient fill, so shading never crushes to black). They are ordinary `B(Cb, Cs)` modes, so the compositor, adjustment layers, effects and brushes all support them. `BlendModeInfo` gains `painterly`, `standard` and `description`; new `PAINTERLY_BLEND_MODES`, `isPainterlyBlendMode` and `standardBlendMode`. The paint editor's PSD export writes pigment and painterly layers as their nearest standard mode (watercolor and shadow as Multiply, tint as Color, highlight as Screen) with a warning, and a new `list_blend_modes` agent tool describes every mode. The React and Svelte layer panels group the blend menu into Standard and Paint modes (`BLEND_MENU_GROUPS`).

## 0.106.0

### Minor Changes

- 251520e: Add UI-agnostic image editor filter/crop presets (`IMAGE_FILTER_PRESETS`, `IMAGE_CROP_PRESETS`), depth mask controls (`DEPTH_MASK_CONTROLS`), normalized layer extraction (`extractNormalizedLayerItems`), and Svelte 5 safe canvas graph snapshotting (`snapshotCanvasGraph`).

## 0.105.0

### Minor Changes

- d4d4b6b: Add `getLayerDataURL` and `getLayerThumbnailDataURL` to `ImageEditorController`. `getLayerDataURL(id)` returns a tight base64 PNG data URL of the non-transparent content of a pixel or smart layer, ideal for deconstructing compositions, extracting layers, and sticker generation. `getLayerThumbnailDataURL(id, options)` returns a scaled PNG data URL preview of a pixel/smart layer or its mask directly, without requiring callers to manually create or draw onto canvas elements.
- a747f70: Paint editor components for React (`@pixerate/editor-react/paint-editor`) and Svelte (`@pixerate/editor-svelte/paint-editor`), in parity. Both include `PaintEditor`, `usePaintEditor` / `createReactivePaintEditor`, `PaintCanvas`, `PaintToolbar`, `BrushPanel`, `PaperPanel`, `ColorPanel` and `PaintLayersPanel`. `PaintCanvas` is a document-sized canvas that uploads only the tiles that changed, shown through the view's zoom, rotation and mirroring. It reads pen pressure, tilt and twist, uses coalesced events and draws a predicted tail, with palm rejection, middle-button pan, wheel zoom and Shift+wheel rotation. It draws guide overlays and floating reference images. `PaintToolbar` covers tools, history, view, symmetry, perspective, tracing and reference images, hand, save / open and PNG / JPEG / PSD. `BrushPanel` has the library with thumbnails, settings, save, import and export. `PaperPanel` has the library and grain settings, which commit once on release. `ColorPanel` has an RYB / RGB wheel with harmonies, swatches and the mixing pad. Core adds the framework-free logic they share: `PaintGesture`, `PaintCanvasPresenter`, `handlePaintShortcut`, `guideOverlay`, the slider tables, `renderColorWheel`, `decodeImageBlob` and `downloadBytes`.
- 205cba0: PSD / PSB read and write for smart objects. Placed layers (`SoLd`, `SoLE`, `PlLd`) now open as smart objects with their embedded contents from `lnk2` / `lnk3` / `lnkD` (an embedded PSD / PSB becomes a nested layer document, a PNG raster contents; JPEG, TIFF and SVG contents are kept and decoded in a browser with `prepareSmartObjects()`), their placement (affine or perspective quad, preset and single-patch custom warps), their smart filters (Box Blur maps to the `blur` filter; every other Photoshop filter, Camera Raw included, is kept, listed and written back but not drawn) and the filter mask from `FEid` / `FXid`. The layer shows Photoshop's stored pixels until it is changed. Linked (external-file) contents come in as their stored pixels, with a warning. Export writes smart objects back as Photoshop smart objects: contents embedded once per linked set, `PlLd` and `SoLd` blocks (an unchanged one byte for byte, keeping descriptor keys we do not model), `filterFX` and the filter mask. `inspect_psd` reports `smart` for placed layers.

## 0.104.0

### Minor Changes

- d7c732e: Paint editor painting guides and colour tools. Mirror and kaleidoscope painting (vertical, horizontal, diagonal and dual mirrors, kaleidoscopes of 2 to 32 segments) paints every copy as one stroke and one undo step. Perspective guides with one to three vanishing points snap pen strokes to their lines. A tracing image sits under the paint in the view only and can supply stroke colours, and floating reference images let you pick colours. Colour harmonies work on the painter's red-yellow-blue wheel or the RGB wheel, swatches are saved with the document, and a mixing pad is painted with a pigment Mixer Brush and smeared with a palette knife. Adds 19 agent tools (`set_symmetry`, `set_perspective_guide`, `set_tracing_image`, `add_reference_image`, `color_harmony`, `mixing_pad_stroke`, …) and `snapToPerspective` on `paint_stroke`.

## 0.103.0

### Minor Changes

- cc1964d: Add `@pixerate/editor/paint-editor`, a natural-media paint editor domain built on the shared raster stack and brush engine. `PaintEditorController` holds a canvas (size, dpi), a paper and the shared layer stack, with one undo step per stroke. Papers are generated grain height maps in a library of families (cold and hot pressed, rough, cartridge, laid, charcoal, sanded pastel, canvas, linen, gesso, smooth) with grain depth, scale, tiling and the absorption / permeability / roughness that wet media will use. Built-in dry media (pencils, pastels, charcoal, airbrush, marker, ink and brush pens, erasers, blender, smudge, Mixer Brush) catch the paper's peaks at light pressure and respond to pressure, tilt, barrel rotation and velocity, with separate position and pressure smoothing and fixed / follow-stroke / barrel rotation. The brush library has JSON import / export and thumbnails. Every stroke is recorded as data and can be replayed exactly or varied. Documents save as JSON with PNG assets; exports are PNG, JPEG, WebP and PSD. `createPaintEditorToolProvider` exposes 42 agent tools, and the new `pixerate-paint-editor` skill documents them.

## 0.102.0

### Minor Changes

- 8e64a1d: Smart objects and smart filters in the image editor. A new `smart` layer type places contents (raster pixels, or a nested layer document) through a non-destructive placement (the Free Transform geometry: corners plus an optional warp mesh) and re-renders from the contents on every change, so repeated transforms never degrade. Convert to Smart Object (one or more layers), Rasterize, Edit Contents (open the contents as a document of their own, with their own undo, then save back), Replace Contents, Export Contents, and linked instances that share one contents (or New Smart Object via Copy for independent ones). Smart filters are an ordered stack of the existing `develop` and `blur` filters, each with enabled, blend mode and opacity, plus one shared filter mask (paintable through the new `filter-mask` paint channel). Pixel layers keep their own filters unchanged, so existing documents render identically; converting a pixel layer turns its filters into smart filters and renders byte for byte the same. Free Transform, `transform_layer`, `flip_layer`, `rotate_layer_90` and `offset_layer` work on smart objects by editing the placement. Smart objects round-trip through `toJSON` / `loadJSON` (contents stored once in `smartContents`). New agent tools: `get_smart_object`, `convert_to_smart_object`, `rasterize_smart_object`, `set_smart_object_transform`, `replace_smart_object_contents`, `export_smart_object_contents`, `copy_smart_object`, `edit_smart_object_contents`, `close_smart_object_contents`, `add_smart_filter`, `update_smart_filter`, `remove_smart_filter`, `move_smart_filter`, `set_smart_filters_enabled` and `set_smart_filter_mask`. The raster compositor gains an `isPixelLike` profile hook for layer kinds that draw a rendered surface like a pixel layer.

## 0.101.0

### Minor Changes

- 6893ce8: Vector appearance stack: paths can stack several fills and strokes (`fills` / `strokes`, bottom to top, fills under strokes), each with its own paint, opacity, blend mode and visibility, and each stroke with its own width, alignment, dashes, caps, joins, arrowheads and profile. `fill` / `stroke` stay as shorthands for the top layer, so existing documents and commands keep working. Nodes get a `blendMode` (the CSS `mix-blend-mode` set, named as in the image editor) and `filters`: drop shadow, inner shadow, outer and inner glow, layer blur and feather, drawn as one SVG filter per node in both canvases and in SVG export (with lossless round-trip; `fill-opacity`, `mix-blend-mode`, `feDropShadow` and blur filters are read from other SVGs, and `mergeStackedShapes` merges same-outline shapes into a stack). Hit-testing uses the topmost visible paint; Outline Stroke outlines each stroke layer; the gradient editor and tool can work on any layer. New controller methods (`addPaintLayer`, `updatePaintLayer`, `removePaintLayer`, `movePaintLayer`, `setPaintLayers`, `setBlendMode`, `addFilter`, `updateFilter`, `removeFilter`, `moveFilter`), agent commands (`vector.getAppearance`, `vector.addFill` / `updateFill` / `removeFill` / `moveFill`, the same for strokes, `vector.setBlendMode`, `vector.addFilter` / `updateFilter` / `removeFilter` / `moveFilter`, and `fills` / `strokes` on `setStyle`, `addShape` and `addPath`), and a `VectorAppearancePanel` in the React and Svelte style panels.

## 0.100.0

### Minor Changes

- 2283b91: Warp in the Free Transform UI: a Warp mode in `FreeTransformTool` and both `<FreeTransformOptionsBar>`s draws the Bézier mesh (grid lines, anchors, handles) through the transform's corners. Drag an anchor or handle (the grid stays smooth across its lines) or pull anywhere inside the mesh. The bar offers Photoshop's fifteen presets with bend, horizontal and vertical distortion and orientation, and a Default / 3 × 3 / 5 × 5 grid. The warp and the corner transform commit together as one undo step. New exports: `WARP_STYLE_OPTIONS`, `WARP_GRID_OPTIONS`, `WarpBar`.

## 0.99.0

### Minor Changes

- 0768e49: Free Transform UI in React and Svelte: `<ImageEditor>` opens a Free Transform with Ctrl/Cmd+T or the Free Transform / Transform Selection buttons, draws the frame, eight handles and a movable reference point on the canvas, and shows `<FreeTransformOptionsBar>` (mode switch: Free, Rotate, Skew, Distort, Perspective; reference-point locator; X / Y, W / H % with a proportional chain, angle, H / V skew; interpolation; Commit / Cancel). Drags follow Photoshop: corners scale proportionally (Shift frees them, Alt scales from the reference point), sides scale one axis, Ctrl/Cmd distorts a corner or skews a side, Ctrl/Cmd+Alt+Shift makes perspective, outside rotates (Shift in 15° steps), inside moves; Enter commits, Esc cancels, arrows nudge. The shared model is `FreeTransformTool` in `@pixerate/editor/image-editor`, and the renderer draws it through the new `freeTransform` render option. `<LayersPanel>` gains a mask link (chain) button and a Link / Unlink Layer Mask menu item.

## 0.98.0

### Minor Changes

- a0e5115: Free Transform for the image editor: scale, rotate, skew, distort, perspective and warp (preset or Bézier mesh) of a pixel layer with its linked mask, an unlinked mask alone, the selected pixels (committed back into the layer), a Layer via Copy, or just the selection outline (Transform Selection). `beginFreeTransform` opens a session with a live, block-sampled preview and commits one undo step resampled tile by tile (`transformSurface` / `warpSurface` in `@pixerate/editor/raster`: nearest, bilinear or Photoshop's Bicubic, premultiplied, pre-filtered when shrinking). Layer masks gain a `linked` flag (PSD mask flag bit 0). New agent tools: `get_transform_frame`, `transform_layer`, `warp_layer`, `transform_selection`, `flip_layer`, `rotate_layer_90`. The homography and warp-mesh maths moved to a shared `src/geom` module; the vector editor re-exports it under its existing names.

## 0.97.0

### Minor Changes

- 4aff6d9: Paint faster on layers with effects. When only part of a layer changes, `RasterCompositor` now rebuilds its effect maps (shadows, glows, bevels, strokes, satin) only around the change and patches them into the cached maps. Before, it rebuilt them over the whole layer. The result is byte-identical to a full rebuild. On a 2000 × 2000 layer, a 64 px dab now takes about 4 ms per update with a drop shadow (was about 200 ms), and about 9 ms with a drop shadow, a stroke and a bevel (was about 700 ms). When a call passes `dirty` rectangles, tiles that only read the change through an effect's reach keep their pixels instead of being recomposited.

  Effects laid out over the layer's bounds (aligned gradients, linked patterns, noise) still rebuild in full. The effect blur now sums in fixed point (to 2⁻³²), so a blurred value no longer depends on where its row starts. New: `patchEffectMaps` updates `EffectMaps` for a shape that changed within given rectangles. `CompositeStats` gains `effectsBuilt` and `effectsPatched`.

- 348bdfe: Layer effects in the layers panel, in React and Svelte alike. `<LayersPanel>` shows an fx badge on every layer with effects (click it to switch them on or off) and an effects section for the active layer. A new `<LayerEffectsPanel>` holds that section and can also be used on its own. It has the master switch, Scale Effects, an "Add effect" menu, and each effect with its own toggle, remove button and every setting (sliders, colours, toggles, choices; a slider drag is one undo step). Core gains the shared view model: `layerEffectsPanel`, `layerEffectsBadge`, `LAYER_EFFECT_MENU`, `layerEffectControls` and `effectControlChange`.

## 0.96.0

### Minor Changes

- 282d096: Add live, non-destructive layer effects to the image editor's layer stack: drop and inner shadow, outer and inner glow, bevel & emboss (five styles, three techniques, gloss contour, Contour and Texture elements), satin, colour / gradient / pattern overlay and stroke (outside, inside, centre; colour, gradient or pattern). Each effect has its own enabled flag, blend mode, opacity and settings; layers get a master switch, Scale Effects and a document global light, and fill opacity leaves effects alone. Effects render in the per-tile compositor of `@pixerate/editor/raster` between a layer's content and its blend, from maps built once per layer region, so tiled renders equal a whole-image render; tile signatures and dirty rectangles grow by each effect's reach. Effects are saved in the v3 document, baked by Merge Down, and reachable by agents through `list_layer_effects`, `add_layer_effect`, `update_layer_effect`, `remove_layer_effect`, `set_layer_effects_enabled` and `set_global_light`. `curveLut` moved to `@pixerate/editor/raster` (still exported from the image editor).
- 282d096: PSD files keep their layer effects. Import maps `lfx2` / `lfxs` / `lmfx` (and legacy `lrFX`) to live effects. It also reads the embedded patterns (`Patt` / `Pat2` / `Pat3`) and the global light (resources 1037 and 1049), and warns only for what it draws approximately: gradient midpoints and smoothness, noise gradients, glow jitter, Dissolve, legacy bevels, and patterns the file lacks. Export writes effects as `lfx2` (`lfxs` on groups). A block opened from a PSD is written back byte for byte while its effects are unchanged, and the patterns the effects use are embedded. Document patterns are saved in the v3 document and listed by `list_layer_effects`. The image editor entry re-exports the effects model.

## 0.95.0

### Minor Changes

- 48866a3: Add a Mixer Brush. `@pixerate/editor/paint` gains `MixerStroke`: a reservoir loaded with paint plus a pickup well that takes up the canvas colour under each dab, with `wet`, `load`, `mix`, `loadEachStroke`, `cleanEachStroke` and `mixing: 'rgb' | 'pigment'` (Kubelka-Munk, so blue dragged through yellow goes green). The image editor adds the `mixer` paint tool (Shift+B) to `beginStroke` / `paintStroke` and `PaintGesture`, with `setPaintOptions({ mixer })`, `loadMixerBrush`, `cleanMixerBrush` and `emptyMixerBrush`; strokes respect the selection and locks and are one undo step. Agents get `tool: "mixer"` and `mixer` settings on `paint_stroke`, plus `get_mixer_brush`, `load_mixer_brush` and `clean_mixer_brush`. React and Svelte `<BrushOptionsBar>` show the Mixer tool with Wet / Load / Mix sliders, Load / Clean buttons, load and clean each stroke toggles and an RGB / Pigment toggle.
- dd3d255: Add a `pigment` blend mode to the shared raster blend set: the layer's colour mixes into what is below like paint (Kubelka-Munk, so blue over yellow at 50 % gives green), with opacity as the share of new paint. Unlike the other modes it is not a `B(Cb, Cs)` function; it replaces the alpha interpolation, `Co = lerpPigment(Cb, Cs, αs / αo)`, and alpha composites as normal. It works on pixel, group, adjustment and annotation layers, in `paint_stroke` (brush `blend`) and `fill_pixels`, and in the canvas fallback (`blendImageData`); the compositor caches each 8-bit colour's spectrum. New helpers `mixPigmentRgb` and `mixPigment8`. PSD export writes pigment layers as Normal and adds a warning naming them. `BLEND_MODES` now has 27 entries, so the React and Svelte layer blend menus list Pigment.

## 0.94.0

### Minor Changes

- 755657f: Add live, non-destructive layer effects to the image editor's layer stack: drop and inner shadow, outer and inner glow, bevel & emboss (five styles, three techniques, gloss contour, Contour and Texture elements), satin, colour / gradient / pattern overlay and stroke (outside, inside, centre; colour, gradient or pattern). Each effect has its own enabled flag, blend mode, opacity and settings; layers get a master switch, Scale Effects and a document global light, and fill opacity leaves effects alone. Effects render in the per-tile compositor of `@pixerate/editor/raster` between a layer's content and its blend, from maps built once per layer region, so tiled renders equal a whole-image render; tile signatures and dirty rectangles grow by each effect's reach. Effects are saved in the v3 document, baked by Merge Down, and reachable by agents through `list_layer_effects`, `add_layer_effect`, `update_layer_effect`, `remove_layer_effect`, `set_layer_effects_enabled` and `set_global_light`. `curveLut` moved to `@pixerate/editor/raster` (still exported from the image editor).

## 0.93.0

### Minor Changes

- b4fb1bf: Add pigment-like colour mixing to `@pixerate/editor/paint`: blue and yellow mix to green and white makes tints, as with paint. sRGB colours are lifted to smooth 36-band reflectance spectra (a sigmoid-polynomial uplift, solved lazily on a 17³ lattice and interpolated so every colour round-trips), mixed with two-constant Kubelka-Munk (scattering from luminance, optional tinting strength) and integrated back to sRGB with analytic CIE 1931 colour-matching functions. New API: `mixPigments`, `lerpPigment`, `createPigment`, `setPigmentColor` and `lerpPigmentInto` (an allocation-free per-dab path), `rgbToReflectance` and `reflectanceToRgb`. A read-only `mix_colors` agent tool (also in the image editor's tool provider) returns the mixed colour and the plain RGB average for comparison.

## 0.92.0

### Minor Changes

- 2111e79: Video editor: nested sequences (compound clips), phase 1. A project can hold `sequences` of `{ id, name, tracks }`, and a compound clip (`type: 'sequence'`, `sequence`, `in`) plays a stretch of one as a single picture and a single sound. `parseVideoProject` reads them (clip ids are unique across the project and its sequences; `speed` and `timeRemap` on a compound are refused for now), and `checkVideoProject` checks sequences' tracks like the project's own and reports `missing-sequence`, `sequence-cycle`, `unused-sequence` and a compound that plays past its sequence's end (`source-overrun`); transitions into a compound need sequence time either side of the cut. `videoFrameAt` makes a compound one layer (`type: 'sequence'`, `sequence`, `sourceTime`, `layers`) to which its opacity, transform, blend, grade, LUT, fades, transitions and animations apply, and mixes its sequence's sound in through its volume and fades; nested layers and sounds are named by clip path (`comp/inner`). The canvas preview draws a compound's layers on an offscreen canvas (`VideoDrawOptions.scratch` now takes a slot per nesting level), SVG frames as an isolated `<g>` with the group filter, and `toVideoFfmpeg` builds each compound's sequence as a sub-graph on a transparent frame placed with the usual per-clip chain, checked against the preview's evaluation on a real ffmpeg. Trims, splits and slips of a compound move its `in`; clips inside sequences are read-only until phase 2, and EDLs mark compounds with a comment. New: `VideoSequence`, `VideoSequenceClip`, `videoSequenceDuration`, `videoSequenceMap`, `findVideoSequenceCycle`, `allVideoTracks`, `findVideoSequenceClip`, `videoFrameLeafLayers`, `describeVideoSequence`, and the agent tool `list_video_sequences`; `get_video_project` summarises sequences. The React and Svelte `VideoTimeline` label compound clips with their sequence, and `ClipInspector` shows the sequence and a mute switch for them.

## 0.91.0

### Minor Changes

- 951daf7: Video editor: an optional frame cache with prefetch for the preview, after Blender's sequencer cache. `VideoFrameCache` holds decoded source frames keyed by the file the preview plays (asset or proxy) and the source frame, so clips of one asset share them and edits never invalidate them. It prefetches the window ahead of the playhead (behind when scrubbing back), nearest first, a few at a time, within a memory budget. Eviction drops the frames furthest from the playhead, counting frames behind it as further, and never touches the prefetch window. Pass it as the controller's `frameCache` (or the engine's). `VideoPreviewEngine` then draws cached frames while paused, scrubbing or mid-seek, and keeps the frames it shows. Also new: `createVideoElementDecoder` (a browser decoder on hidden `<video>` elements), and `planVideoPrefetch`, `videoCacheEvictions` and `videoFrameRequestsAt` as pure helpers. New agent tool `get_video_preview_cache` reports the cache and which stretches play without waiting. The React and Svelte `VideoTimeline` draw the cached stretches under the ruler.
- 951daf7: Video editor: proxies. Video assets take `proxies` (`[{ scale, src, width?, height? }]`), smaller copies the preview plays instead of the original. The export, EDL and source times always use the original. The controller has a preview scale (`previewScale` option, `setPreviewScale`, `state.previewScale`): `auto` (by the canvas's shown size, the default), `full`, or a fraction that picks the smallest proxy at least that large. `VideoPreviewEngine` follows it and switches elements as it changes. `videoProxyFfmpeg` and `videoProxyPlan` build ffmpeg commands that make proxies: scaled to even sizes, H.264 with a short keyframe interval and no B-frames so seeks are cheap, sound kept, `faststart`. New agent tools `plan_video_proxies`, `set_video_proxies` and `set_video_preview_scale`; `get_video_project` reports the preview scale. The React and Svelte `VideoTransport` add a preview-size control when any asset has proxies, and `MediaBin` marks assets that have them. `videoShellQuote` is now exported.

## 0.90.0

### Minor Changes

- 4f981e2: Image editor layer integrations. In documents with more than one pixel layer or group (`isMultiLayer`), `applyInpaintedImage` adds the result as a new layer above the active layer (limited to the selection) and `applyBackgroundRemovedImage` masks the active pixel layer with the result's alpha; single-layer documents keep replacing the Background, and both take `{ target: 'new-layer' | 'replace' }`. `toAIInputDataURL` gives hooks the matching input (the composite in new-layer mode). New `rasterizeLayer` (annotation layers to pixels, layer filters baked) with the `rasterize_layer` agent tool and a Rasterize Layer menu item; selection tools take `sample: 'composite' | 'active-layer'` (also on `select_by_color`); `toJSON({ assets: 'external', store })` and `loadJSONAsync(data, { store })` keep v3 layer pixels in an `ImageEditorAssetStore`. React and Svelte: an AI result target selector and a sample selector in `<SelectionOptionsBar>`.
- 4f981e2: Image editor: open and export Photoshop PSD / PSB files on top of the layer stack (a TypeScript port of a photocraft-psd subset). `loadPsd(bytes)` opens a file as the document (one undo step): pixel, group and adjustment layers (our ten kinds), user masks with density and feather, 26 blend modes, opacity, fill, clipping, visibility and locks map directly; type, smart-object, fill and shape layers come in as their stored pixels, and CMYK, Lab, grayscale, indexed, bitmap, 16- and 32-bit files are converted to 8-bit RGB, each loss reported as a warning naming the layers. `toPsd()` writes an 8-bit RGB PSD (PSB above 30 000 px) with real layers, groups, adjustment layers and masks, baking filters and depth masks. Documents without a source image (an opened PSD, a v3 document) now render. New agent tools `inspect_psd`, `import_psd` and `export_psd`; Open PSD… / Export PSD buttons in `<LayersPanel>` (React and Svelte, `psd` and `psdFileName` props); `readPsd`, `writePsd`, `importPsd`, `exportPsd`, `openPsdFile` and `downloadPsd` exports. `pnpm test:corpus` runs the reader and writer over 490 public PSDs.

## 0.89.0

### Minor Changes

- 97fa696: Image editor layers: operations, agent tools and a layers panel. The controller gains `addPixelLayer` (empty, colour or image), `addGroup`, `duplicateLayer`, `removeLayer`, `moveLayer`, `setLayerProperties` (name, visibility, opacity, fill, blend, clipping, locks), `groupLayers` / `ungroupLayer`, `mergeDown`, `mergeVisible`, `flattenImage`, `offsetLayer`, `addLayerMask` / `applyLayerMask` / `removeLayerMask` / `setLayerMaskProps`, `layerViaCopy` (copy or cut), layer filters (`addLayerFilter`, `updateLayerFilter`, `removeLayerFilter`) and `getLayerThumbnail`; each validates first, throws a `LayerOperationError` with the reason, and is one undo step. New agent tools: `set_active_layer`, `add_pixel_layer`, `duplicate_layer`, `remove_layer`, `move_layer`, `set_layer_properties`, `group_layers`, `add_group`, `ungroup_layer`, `merge_down`, `merge_visible`, `flatten_image`, `offset_layer`, `add_layer_mask`, `apply_layer_mask`, `remove_layer_mask`, `set_layer_mask_properties`, `layer_via_copy`, `add_layer_filter`, `update_layer_filter` and `remove_layer_filter`; `add_adjustment_layer` takes `aboveId` / `parentId` and `render_preview` takes `layerId`. React and Svelte get `<LayersPanel>` (thumbnails, drag to reorder and nest, visibility, locks, opacity, fill, blend, clipping, mask thumbnails, layer menu), also as a Layers tab in `<ImageEditor>`.
- 97fa696: Image editor painting: a brush engine ported from photocraft, in the new shared `@pixerate/editor/paint` subpath (round computed tip with size, hardness, angle, roundness and spacing; opacity versus flow build-up; smoothing; pen pressure to size and opacity), Brush and Eraser strokes on pixel layers and layer masks (black hides, white reveals) limited by the selection and by transparency locks, Edit › Fill and Clear, and the Move tool. `beginStroke` returns a live stroke session (one undo step per stroke); `paintStroke`, `fillPixels`, `clearPixels`, `setPaintOptions`, `swapPaintColors` and `resetPaintColors` drive it, and `PaintGesture` / `handlePaintShortcut` give hosts the pointer handling and Photoshop shortcuts (B, E, V, [ ], Shift+[ ], 0–9, D, X). New agent tools `paint_stroke`, `fill_pixels` and `clear_pixels`. React and Svelte get `<BrushOptionsBar>` and a Paint tab in `<ImageEditor>` with pointer capture, coalesced events and a brush cursor.
- 97fa696: Image editor: a real layer stack under the hood. Documents are now pixel, adjustment, group and annotation layers on tiled, copy-on-write surfaces (256 px tiles, uniform tiles shared), composited per tile with prefix caches and dirty rectangles. The base sliders become a `develop` filter on the Background layer, blur a `blur` filter, the depth mask a parametric layer mask, and each annotation its own layer; `adjustments`, `depthMask` and `annotations` on the state stay as views, and every existing method keeps working. Undo history stores immutable states that share tiles, bounded by the new `maxHistoryBytes` option. `toJSON()` writes schema v3 (layers, PNG assets) only when a document no longer has the old shape; v1 / v2 documents load, render and save exactly as before (proven by randomised equivalence tests). New: `getLayers`, `getLayer`, `setActiveLayer`, `getLayerPixels`, `getLayerBounds`, `compositePixels`, `migrateToLayeredState`, the `list_layers` agent tool, and a synchronous PNG / zlib codec. `SerializedImageEditorState` is now a union of the v1 / v2 shape (`LegacySerializedImageEditorState`) and v3 (`SerializedLayeredImageEditorState`).
- 97fa696: New `@pixerate/editor/raster` subpath: the tiled copy-on-write surfaces, the PNG / zlib codec, blend modes, the generic layer stack (pixel layers, groups, raster masks, clipping, locks and tree helpers) and the per-tile compositor engine (`RasterCompositor` with a `CompositorProfile` for editor-specific layer kinds), free of DOM and framework imports. The image editor's compositor is this engine with the photo profile; `@pixerate/editor/image-editor` keeps exporting the same names.

### Patch Changes

- 504ac33: Add ImageEditorFit mode ('contain' | 'margin') to image editor geometry and renderer to allow edge-to-edge canvas fill without artificial letterboxing margins

## 0.88.0

### Minor Changes

- c78c7cc: Video editor: 3D LUTs on grades. `VideoGrade.lut` (`{ src, strength, name }`) applies a `.cube` file after the grade's other steps, mixed in at its strength. New `parseVideoCubeLut` (title, domain, input range; errors give the line), tetrahedral `applyVideoLut` and `applyVideoLutToPixels`, `videoLutFromFunction`, `videoLutToCube`, `videoLutSvgApproximation`, `videoGradeLook` (a preset that keeps the LUT), `videoLutEdits`, and `VideoLutCache` (`controller.luts`, with a `luts` loader option). The canvas preview draws LUT layers on a scratch canvas and runs them through the table (frames count as incomplete until the LUT loads). SVG frames approximate a LUT with curves and a colour matrix. The ffmpeg export uses `lut3d` (with `split` + `blend` at part strength, and `resolveLut` for file paths), checked against a real ffmpeg. New agent tools `set_video_lut` (reads the file first) and `remove_video_lut`; `apply_video_grade_preset` keeps a clip's LUT, and `render_video_frame` draws LUTs and says when one is approximate or missing. The React and Svelte `ClipInspector` add a LUT row (path or file, strength, remove).

## 0.87.0

### Minor Changes

- ed6d944: Video editor: colour scopes. Pure functions on RGBA pixels give a histogram (`videoHistogram`), a Rec. 709 luma waveform (`videoLumaWaveform`) and a vectorscope (`videoVectorscope`), sampled to a fixed cost, plus exposure figures (`videoExposureStats`: luma mean, median and percentiles, the share crushed or blown and per channel, saturation, average colour) with notes on what to fix (`videoExposureNotes`, `summarizeVideoScopes`), and drawn scope images (`videoScopeImage`). `VideoPreviewEngine` publishes the pixels it draws to `controller.previewPixels` (`VideoPreviewPixels`), marking frames whose media is still loading or seeking as incomplete. New agent tool `get_video_scopes` measures the rendered frame at any time, waiting for every picture to load; hosts without a preview pass `framePixels` (e.g. a frame decoded by ffmpeg). React and Svelte add `<VideoScopes>` and `<VideoEditor showScopes>`.

## 0.86.0

### Minor Changes

- 68d6ff1: Video editor: speed ramps and freeze frames. Media clips take `timeRemap`: keys mapping clip time to source time after the in point. The slope is the speed, a flat stretch is a freeze, and eased keys glide between speeds (`videoSpeedRampKeys` builds them from `[{ duration, speed, toSpeed }]`, with ramps eased exactly). Ramps stay on the same frames of source through trims, splits and slips. `videoClipSourceTime` and `videoClipSpeedAt` read them, and the preview pauses and seeks through speeds browsers refuse. The ffmpeg export re-times the picture with `setpts` + `fps` + `tpad` and steps the sound with `atempo` pieces (checked frame by frame against a real render). New `set_time_remap` edit op, agent tools `set_video_speed_ramp`, `add_video_freeze_frame` and `remove_video_speed_ramp`, helpers `videoSpeedRampEdit`, `videoFreezeFrameEdit` and `videoSlowMotionRamp`. The React and Svelte `ClipInspector` add "Freeze 1 s here", "Slow-mo ramp" and "Remove ramp".

## 0.85.0

### Minor Changes

- a1474b8: Video editor: text-based editing. Assets take a `transcript` of words timed in the source, so it stays right however clips are cut; `parseVideoTranscript` reads Whisper-style JSON (word timings), SubRip and WebVTT (words spread across each cue). `videoTimelineTranscript` maps the words through clips, in points and speed onto the timeline, and `findVideoTranscriptText`, `findVideoFillers` (longest phrase first) and `findVideoTranscriptPauses` return timeline ranges that `videoRemoveRangesEdits` cuts out last first as one undo step. New agent tools `set_video_transcript`, `get_video_transcript`, `find_video_transcript_text`, `find_video_fillers`, `find_video_pauses` and `remove_video_ranges` (`get_video_project` lists a transcript as its word count). New `<TranscriptPanel>` in React and Svelte, also shown in `<VideoEditor>` (`showTranscript`): click a word to go to it, Shift-click to select a run and delete it, remove fillers, tighten pauses, and load transcript files per asset.

## 0.84.0

### Minor Changes

- 9aea92b: Video editor: blend modes. Clips take `blend` (`normal`, `multiply`, `screen`, `overlay`, `darken`, `lighten`, `color-dodge`, `color-burn`, `hard-light`, `soft-light`, `difference`, `exclusion`, `add`), the modes CSS `mix-blend-mode`, the canvas and ffmpeg's `blend` filter share. `videoFrameAt` layers carry it, SVG frames and `drawVideoFrame` apply it, and the ffmpeg export blends each layer with the composite in RGB and lays the result back through the layer's alpha, so opacity, fades and partial coverage still apply (checked pixel by pixel against the CSS formulas; soft-light differs slightly in ffmpeg and says so in the notes). `update_video_clip` sets it, and the React and Svelte `ClipInspector` have a Blend menu. `VIDEO_BLEND_MODES` and `VIDEO_BLEND_MODE_LABELS` are exported.
- 9aea92b: Video editor: entrance and exit animations. Clips take `animateIn` / `animateOut: { effect, duration }` with effects `fade`, `rise`, `drop`, `slide-left`, `slide-right`, `zoom` and `pop` (which overshoots and settles). They are written out as keyframes on opacity, x, y and scale (`videoClipAnimated`), so previews, SVG frames and the ffmpeg export, drawtext titles included, play them the same way (checked against a real ffmpeg render). A property the clip keys itself is left alone and noted (`animation-keyed`); entrance plus exit longer than the clip are shortened and warned about (`animations-too-long`). Splits keep the entrance on the left part and the exit on the right. `update_video_clip` sets them, and the React and Svelte `ClipInspector` have Animate in / Animate out menus.
- 9aea92b: Video editor: colour grades. Clips take `grade: { exposure, contrast, saturation, hue, temperature, tint }`, applied as a fixed series of clamped colour-matrix steps that the canvas (CSS filters, with white balance as an SVG `feColorMatrix` the preview engine adds to the page), SVG frames and the ffmpeg export (`lutrgb`, `colorchannelmixer`) all share, so they agree (checked against a real ffmpeg render). `VIDEO_GRADE_CONTROLS` drives the schema, inspectors and clamping; `VIDEO_GRADE_PRESETS` (warm, cool, punchy, faded, black-and-white, bleach-bypass, day-for-night) apply at a strength with `videoGradePreset`; `applyVideoGrade`, `videoGradeCssFilter`, `videoGradeSvgFilter` and `videoGradeFfmpegFilters` are exported. New agent tools `apply_video_grade_preset` and `copy_video_grade`; `update_video_clip` sets `grade`. The React and Svelte `ClipInspector` add a look menu and a slider per setting. `drawVideoFrame` takes a `defineSvgFilter` option and `VideoPreviewEngine` a matching one.
- 9aea92b: Video editor: transitions take an `audioCurve` for the sound's fades through them, and crossfades and wipes now default to `equal-power`, so loudness holds steady across the cut instead of dipping by 3 dB halfway (dips stay linear). The preview, `videoFrameAt` and the ffmpeg export (`afade` curves) agree. `videoTransitionAudioCurve` is exported, `set_video_transition` takes `audioCurve`, and the React and Svelte `ClipInspector` show a "Transition sound" menu.
- 9aea92b: Video editor: push, slide and iris transitions. `push` slides the incoming clip in and the outgoing one out, `slide` brings the incoming clip in over the outgoing one, both eased and in any `direction`; `iris` opens a circle from the frame's centre. `videoFrameAt` moves the layers' rects (or gives them an `iris`), SVG frames and the canvas clip to the circle, and the ffmpeg export moves overlays with eased expressions and masks the iris with `geq` (checked against a real ffmpeg render); EDLs mark them as wipes. `VIDEO_TRANSITION_LABELS`, `videoTransitionHasDirection`, `videoTransitionEase` and `videoIrisRadius` are exported. The React and Svelte `ClipInspector` list the new types and show a direction menu for wipe, push and slide.

### Patch Changes

- 9aea92b: Video editor: fix keyframed scale and rotation in the ffmpeg export. A keyframed scale stayed at its first size when the clip also had keyframed opacity, a wipe or a rotation (`geq` and `rotate` keep the size they first see), and a keyframed rotation drew an opaque box around the picture (`rotate`'s `c=none` with a moving angle). The animated scale now comes last in the chain, scaling by the input size, and `rotate` fills with transparent black.

## 0.83.0

### Minor Changes

- 658832b: Video editor: drop-frame timecode at 29.97 and 59.94 fps. `formatVideoTimecode` now writes `HH:MM:SS;FF` drop-frame at those rates by default (pass `false` for non-drop), and new helpers `isVideoDropFrameRate`, `formatVideoTimecodeFrames`, `videoTimecodeFrames` and `videoHourFrames` are exported. EDLs at NTSC rates now declare `FCM: DROP FRAME`, with a `dropFrame` option on `toVideoEdl` and the `export_video_edl` tool to force non-drop. EDL record timecode now starts at timecode 01:00:00:00 counted in frames, so non-drop EDLs at 29.97 no longer start at 00:59:56:12.
- 658832b: Video editor: shaped sound fades. Media clips take `fadeInCurve` / `fadeOutCurve` (`linear`, `equal-power`, `s-curve`, `exponential`, `logarithmic`), the same curves ffmpeg's `afade` draws, so `videoFrameAt`, playback and the ffmpeg export agree (checked against a real ffmpeg render). Pictures still fade linearly. `videoFadeCurveGain`, `VIDEO_FADE_CURVES` and `VIDEO_FADE_CURVE_LABELS` are exported; `update_video_clip` sets and removes the curves; splits keep the fade-in curve on the left part and the fade-out curve on the right. The React and Svelte `ClipInspector` show a curve menu for each fade a media clip has.
- 658832b: Video editor: loudness normalisation on export. `toVideoFfmpeg` takes `loudness: { integrated, truePeak, range, measured }` and adds EBU R128 `loudnorm` to the mix (back to 48 kHz after it). Without `measured` it normalises in one pass; `toVideoLoudnessMeasure` builds a sound-only measuring pass whose stderr `parseVideoLoudnessMeasurement` reads, for an exact linear second pass (checked against a real ffmpeg: within 1 LU of the target). New agent tool `export_video_loudness_measure`, and `export_video_ffmpeg` takes `loudness`.
- 658832b: Video editor: waveforms, sound levels and silence detection. `buildVideoAudioPeaks` turns decoded audio into a min / max peak pyramid that answers any stretch exactly at any zoom (`videoAudioPeakRange`, `videoAudioPeakSpans`); `videoClipWaveform` / `videoClipWaveformPath` draw what a clip plays through its in point, speed, volume and fades; `videoAudioLevels` and `findVideoAudioSilences` measure it. `VideoEditorController` gets an `audioPeaks` cache (`VideoAudioPeaksCache`, decoding each asset once with Web Audio by default, or with the `audioPeaks` loader you pass). New agent tools `get_video_audio_levels` and `find_video_silences` read a clip (timeline times, ready for `extract_video_range`) or an asset. The React and Svelte `VideoTimeline` draw waveforms in audio clips, with a `waveforms` prop (`audio`, `all` or `none`). `videoAssetHasSound` and `videoClipShowsWaveform` are exported.

## 0.82.0

### Minor Changes

- d7e9278: Agents can take screenshots with a new `capture_view` tool. It captures the viewport, all content, the selection, items by id or a rect, as PNG or JPEG. The result has the image plus the captured rect and pixel scale, so a point in the image maps back to surface coordinates. Selection boxes, resize handles and agent cursors are left out unless `includeOverlays` is set.

  - Core (`/tools`): `createCaptureTool` / `createCaptureToolProvider` over any `CaptureSurface`, `rasterizeElement` (a DOM element drawn through an SVG `foreignObject`, no dependencies) and `createElementCaptureSurface` for any DOM view.
  - Canvas (`/canvas`): `createCanvasCaptureToolProvider` for React Flow / Svelte Flow canvases, in canvas units, framing nodes by id wherever the view is scrolled.
  - Image editor: `capture_view` is part of `createImageEditorToolProvider`. It works in natural image pixels, the same space as the selection tools, zooms up to 8× with hard pixel edges and can shade unselected pixels. `ImageEditorController.renderSourceView` renders the edited image without crop or rotation.
  - React: `useCanvasCapture`. Svelte: `createCanvasCapture`.

## 0.81.0

### Minor Changes

- ed897da: Close agent-path gaps found while writing the agent skills:

  - Spreadsheet: `merge_cells`, `unmerge_cells` and `transpose_range` tools take an A1 range instead of depending on the user's selection, check merges and read-only cells first, and return what changed. `get_range` now lists the merged ranges it touches. The `spreadsheet.mergeCells` / `unmergeCells` / `transposeRange` commands fail with a reason instead of returning `false` when nothing changes.
  - Image editor: `get_image_info`, `get_histogram` (clipping, mean and percentiles), `update_adjustment_layer` (enabled, blend, opacity, name), `move_adjustment_layer`, `remove_adjustment_layer`, `set_crop`, `reset_crop`, `set_rotation`, `flip_image`, `undo_image` and `redo_image` (`createImageEditTools`, included in `createImageEditorToolProvider`).
  - Generation: `createGenerationHistoryToolProvider` exposes a `GenerationRecordStore` to agents with `list_generations`, `get_generation`, `recreate_generation` and `vary_generation`; the last two return a request and drift report for `generate` instead of spending.

- ed897da: Ship an Agent Skill per editor domain in `skills/` (rich text, spreadsheet, canvas, vector, chart, diagram, image editor, animation editor, video editor, generation, parameters, plus `pixerate-agent-tools` for what they share). Each `SKILL.md` tells a model when and how to use every tool and command of its domain, with the domain's best practice. A test keeps each skill's tool list in step with the providers.

## 0.80.0

### Minor Changes

- 2e5b361: feat(core): professional edits for the video editor. New ops `slip_clip`, `roll_edit` and `slide_clip` (clamped to the media and neighbours, returning the delta applied), `lift_range`, `extract_range` and `split_at` (across tracks), each with its own agent tool (`slip_video_clip`, `roll_video_edit`, `slide_video_clip`, `lift_video_range`, `extract_video_range`, `split_video_at`). `add_clip` and `move_clip` take `mode: 'refuse' | 'overwrite' | 'insert'` (`ripple: true` on `add_clip` is now the same as `insert`, which cuts clips across the insert point instead of refusing). Tracks have `syncLocked` (default true): ripple inserts, trims, deletes and extracts now move every unlocked sync-locked track together (cutting clips across an opened edit point), and a ripple that would close time where another sync-locked track still has a clip is refused with the fix — turn `syncLocked` off on a music bed to keep the old per-track behaviour. Edit outcomes report `created`, `trimmed`, `removed`, `rippled` and `delta`. The React and Svelte timelines insert with Alt and overwrite with Shift while dragging a clip (`planVideoClipDrag` `placement`, `videoDragLabel`).

## 0.79.0

### Minor Changes

- 6b082fd: feat(core,react,svelte): keyframes for video clips. A clip's `opacity`, `volume` and `transform` `x` / `y` / `scale` / `rotation` may now be `{ keys: [{ t, v, ease }] }` in clip time (ms from the clip's start), with `linear`, `hold`, `ease-in`, `ease-out`, `ease-in-out` or CSS cubic-bezier `[x1, y1, x2, y2]` easing. `videoValueAt` evaluates them for `videoFrameAt`, the canvas / SVG renderers and agents; the ffmpeg export bakes them to piecewise-linear expressions (alpha via `geq`, overlay x/y, `rotate` angle, `scale` with `eval=frame`, `volume` with `eval=frame`). Split partitions keys and inserts boundary keys (subdividing eased segments exactly), trimming the head and rate stretches keep keys on their frames, and `checkVideoProject` warns about `keyframes-outside-clip`. New `set_keyframes` edit op, `set_video_keyframes` / `remove_video_keyframes` agent tools, and keyframe toggles (add / remove at the playhead, type to set the key there) in the React and Svelte `<ClipInspector>`.

## 0.78.0

### Minor Changes

- 3b6da42: feat(canvas,image-editor,vector): add `PIXERATE_BRAND_GRADIENT`, `isolateCanvasGestures`, UI-agnostic agent presence trajectory/rotation math and `AgentCursorPresence`, region mosaic/blur image filters (`applyRegionMosaic`, `applyRegionBlur`), and CSS transform scale compensation in `VectorCanvas`

### Patch Changes

- b15c054: Add computeDragBounds and computeDragBoundsFromPoints with modifier key options (Shift to constrain 1:1, Alt/Option to draw from center)

## 0.77.0

### Minor Changes

- ac38891: The video editor's ffmpeg export is now checked against a real ffmpeg (an integration test renders every transition, speed changes, transforms, colour clips, fades and mixed sound, and checks pixels). New `titleImage` option for `toVideoFfmpeg`: titles go in as transparent full-frame images instead of `drawtext`, which needs an ffmpeg built with libfreetype (Homebrew's is not). `videoTitleFrame` gives the frame to draw for one title with `drawVideoFrame`. When titles do use `drawtext`, the export's notes say so.

## 0.76.0

### Minor Changes

- 9e22068: Add a UI-agnostic video editor (`@pixerate/editor/video-editor`). Projects are plain JSON: video, audio and image assets on video and audio tracks, with media clips (in point, speed, volume, fades, opacity, fit, transform), titles, colour clips and markers. `applyVideoEdits` adds, moves, trims (with ripple), splits, deletes (with ripple) and closes gaps all or nothing, and never adds an error; crossfade, dip and wipe transitions play over the cut, with handle checks that say the longest transition that fits. `videoFrameAt` gives the layers and sounds at any moment, `VideoPreviewEngine` plays a project on a canvas in the browser, `VideoEditorController` adds undo, playback, selection and snapping, and projects export to an ffmpeg command or a CMX 3600 EDL. `createVideoEditorToolProvider` exposes 29 agent tools. React (`@pixerate/editor-react/video-editor`) and Svelte (`@pixerate/editor-svelte/video-editor`) add `<VideoEditor>`, `<VideoPreview>`, `<VideoTimeline>`, `<VideoTransport>`, `<ClipInspector>`, `<MediaBin>` and `useVideoEditor` / `createVideoEditor` with `useVideoEditorTools`.

## 0.75.0

### Minor Changes

- 27c66fe: Outlined text can animate a letter, word or line at a time.

  - **Splitting:** any command takes `split: "letter" | "word" | "line"` for a group of letter paths, meaning text converted to outlines.
  - **Reading order:** letters are sorted into lines by vertical overlap and into words by spacing (`motionTextLayout`), then staggered. Defaults are 40 ms a letter, 120 a word and 300 a line.
  - **Order:** `cascade` sets it: forward, backward, from the centre, from the edges, or a seeded random that is the same every time.
  - **Checks:** `split-not-text` warns when the target isn't a group of letter paths.
  - **Agents:** a new read tool, `get_text_layout`, shows the letters, words and lines.

## 0.74.0

### Minor Changes

- b8500f6: Animation scenes can be imported from PowerPoint with `fromPptxAnimation` and the `import_pptx_animation` agent tool (base64 `.pptx`, `slide`, dry run).

  - **Shapes:** a slide's shapes become the artwork: preset and custom geometry, groups, solid fills, outlines and theme colours.
  - **Animation:** its animation pane becomes a shot per click, and the scene plays on click.
    - Entrances, exits and emphasis map to the editor's commands, and motion paths become follows along hidden paths.
    - With previous and after previous, delays, repeats, auto-reverse and acceleration carry over.
  - **Notes:** text, pictures, charts and effects with no match are listed.
  - **Demo:** the animation tab can import a slide.

## 0.73.0

### Minor Changes

- 015ef78: Animation scenes can have motion blur.

  - **Setting:** `scene.motionBlur` takes `shutter` (degrees, default 180) and `samples` (default 8, at most 32).
  - **Sampling:** each frame on the stage, in `render_animation_frame` and in contact sheets averages moments across the shutter (`motionBlurTimes`). There are more moments for faster motion and none when nothing moves, added exactly with `plus-lighter`.
  - **Unchanged:** `motionFrameToSvg` and the Flair and Lottie exports stay sharp, and the exports say so.
  - **Agents:** `set_animation_settings` sets or clears `motionBlur`.
  - **React and Svelte:** `SceneSettings` has a Motion blur select.

## 0.72.0

### Minor Changes

- c3f10fd: Animation scenes get drivers: properties that follow other nodes' properties.

  - **What they're for:** parallax, a wheel turning as it rolls, a shadow fading as something rises.
  - **How they work:** `scene.drivers` maps a source's change from rest, times `factor` plus `offset` and clamped, onto the target's x, y, rotation, scale or opacity, on top of its own commands. Chains are followed.
  - **Checks:** a loop between drivers is a `driver-cycle` error, and unknown nodes are named with "did you mean".
  - **Export:** Flair and Lottie sample driven properties wherever their sources change.
  - **Core:** `motionPropertyValue`, `applyMotionDrivers` and `motionDriverSources`. `formatMotionDrivers` and `parseMotionDrivers` read and write drivers one a line (`dot.x <- box.x * 0.5`).
  - **Agents:** a new `set_animation_drivers` tool, and `get_animation` lists drivers.
  - **React and Svelte:** `SceneSettings` has a Drivers box.

## 0.71.0

### Minor Changes

- 2f6469d: The animation editor's agent tools get easier to use in fewer calls.

  - **References in batches:** in an `edit_animation` batch, later ops can use what earlier ones made: `"$0.indexes[0]"` is the first command op 1 added, `"$last.shot"` is the shot the op before changed, and `"$$"` is a literal `$`. The tool returns each op's outcome. `resolveMotionEditRefs` does the same outside the tools.
  - **Contact sheet:** `render_animation_frame` takes `times` (and `columns`) to draw several moments as one labelled contact sheet (`motionContactSheetSvg`), as SVG or PNG.
  - **Tests:** new tests do realistic agent tasks only through the tools. Golden fingerprints of frames catch any change to how scenes draw (regenerate with `vitest -u`).

## 0.70.0

### Minor Changes

- 9728f84: Drawing on (`draw`, `enter` with style `draw`, `exit` with style `undraw`) can order a group's strokes.

  - **Sequence:** `order: "sequence"` draws one stroke after another, each for a time in proportion to its length. Add `sortBy: "distance"` and an `origin` for a radial reveal.
  - **Speed:** `pace: "speed"` draws all strokes at one speed, starting or finishing together (`align`).
  - **Comet:** `draw` takes `comet`, a short stroke that runs along the path and off the end.
  - **Export:** Lottie writes the comet's tail as the trim start.
  - **Checks:** they treat a group as drawn when any of its strokes is.

## 0.69.0

### Minor Changes

- ea2b6d9: Animation scenes get reusable clips.

  - **Clips:** `scene.clips` holds named command lists written against the target `"$"`.
  - **Playing:** a `play` command plays a clip on any nodes, with stagger and `speed`. Each command of the clip is timed as in a shot, and the clip's length comes from its commands (`motionClipLayout`).
  - **Checks:** `unknown-clip` (with "did you mean") flags a play of a missing clip, and clips that name missing nodes are reported. Clips cannot play clips.
  - **Agent tools:** `set_animation_clip` defines, replaces or deletes a clip, refusing to delete one still being played. `copy_animation` gives other nodes one node's motion, inserting each copy after its original as one undo step. `get_animation` lists clips with their lengths.

## 0.68.0

### Minor Changes

- 97b6868: `move` takes `via` waypoints, so a node follows a smooth path that passes exactly through each point.

  - **Smoothness:** each axis is a monotone cubic. Velocity carries through every waypoint, and the path never overshoots one: turning points and flat stretches stay put, like Blender's clamped handles.
  - **Pacing:** `pacing: "even"` (the default) keeps the speed steady along the path, and `"equal"` gives each stretch the same time.
  - **Default length:** 700 ms plus 400 ms per waypoint.
  - **Export:** each leg is a cubic-bezier ease per axis. Flair and Lottie take one ease per transform, so those exports sample the path.
  - **New exports:** `smoothMotionLegs` and `smoothMotionTimes`.

## 0.67.1

### Patch Changes

- 21866a8: Click-triggered scenes now export the way Flair's player plays them.

  - **The problem:** Flair's player shows a click-triggered picture still until the first click, then plays steps 0 and 1 together. That made the first click play the first two shots at once.
  - **Export:** shot n now goes on step n + 1. Each click plays one shot, and after the last the first plays again.
  - **Import:** importing a click effect folds its step 0 into the first shot.

## 0.67.0

### Minor Changes

- 3c7b434: Animation scenes can play on a trigger: `trigger` is `click`, `hover`, `press` or `scroll`.

  - **Click export:** the Flair export turns each shot into a Flair step timed from the shot's start. The first shot plays on load, and each click plays the next.
  - **Hover, press and scroll:** these play, rewind or scrub the whole scene.
  - **Effects:** `toFlairVectorEffect` and the export tools carry the trigger, `FlairMotionExport.trigger` says what to pass to `SvgPlayer`, and `export*` options take `trigger` (null for none).
  - **Import:** Flair imports keep an effect's trigger.
  - **Lottie:** the Lottie export notes that it plays through.
  - **Checks:** `trigger-loop`, `click-one-shot` and `click-cue`.
  - **Agents:** `set_animation_settings` and `get_animation` handle `trigger`.
  - **React and Svelte:** the scene settings panel has a "Plays on" select.

## 0.66.1

### Patch Changes

- aeeac37: `toLottie` now leaves hidden artwork nodes (`visible: false`) out of the exported file. They were written as groups marked `hd: true`, which lottie-web ignores on groups, so hidden follow routes and morph targets showed in Lottie players. Follows and morphs that use a hidden node are unchanged: they are sampled into keyframes.

## 0.66.0

### Minor Changes

- 28493c5: The animation editor can now be used by hand, not just played.

  - **`<AnimationEditor>`** (React and Svelte) brings together the stage, a playhead scrubber and panels for editing commands, shots and scene settings, with undo and redo (⌘Z / ⇧⌘Z). Pass `editable={false}` to get a player with no editing.
  - **`<PlayheadScrubber>`**: a time ruler with shot bands, beat-grid and narration marks, drag or arrow keys to scrub, play / pause, and a loop mode.
  - **`<CommandList>`**: a shot's commands in order. Add, reorder, duplicate and delete commands, and change `with` and `delay` inline.
  - **`<CommandInspector>`**: a form generated from `MOTION_COMMAND_SCHEMA`, the schema the agent tools take. Enums appear as selects, numbers show their units and limits, and nodes and targets have pickers. It shows the Flair primitive each command plays.
  - **`<EasePicker>`**: easing presets, including the springs, with a curve preview sampled from `evaluateEasing`. A spring is drawn over the time it takes to settle.
  - **Stage picking**: click an element in `<AnimationStage>` (`onPick` / `onpick`) to pick it, or shift-click to add it to or remove it from the selected command's targets. Picked elements and targets are outlined (`highlight`).
  - **`<ShotInspector>`**: a shot's label, hold, speed and camera framing, a cue picker for `at` (a beat or a narration word), and buttons to add, move and delete shots.
  - **`<SceneSettings>`**: loop, frame rate, stepped time, target length with a Fit button (`fitMotionScene`), a beat grid, and narration words.
  - Every change is one `controller.apply` edit, so it is one undo step. When an edit is refused, the reason is shown.
  - **Core:** the components share helpers: `motionCommandFields`, `parseMotionFieldInput`, `motionFieldEdit`, `defaultMotionCommand`, `motionCommandRows`, `duplicateMotionCommandEdit`, `motionEasingCurve` / `motionEasingPath`, `motionNodeAtElement`, `highlightMotionSvg`, `motionRulerTicks`, `fitMotionSceneEdits`, `motionCueChoices`, `parseMotionNarration` and `formatMotionNarration`.
  - **New edit and agent tool:** `move_command` reorders a command within its shot as one undo step.
  - **Flair import:** preset colours written as `[r, g, b]` channel arrays, as Flair's catalog writes them, are now read as hex.

## 0.65.0

### Minor Changes

- 2751617: The animation stage shows motion on a still.

  - **Onion skin:** faded ghost frames either side of the playhead. Ghosts are a set time apart, or fall on the moments commands start and end, and fade with distance.
  - **Motion paths:** a dashed line where each node's centre travels, with a dot where each change starts or ends.
  - **Core:** `motionGhosts`, `motionPath`, `motionMovingIds`, `motionPathsSvg` and `motionStageSvg`. `controller.toSvg` takes `onionSkin`, `motionPaths` and `motionPathColor`.
  - **React and Svelte:** `<AnimationStage>` and `<AnimationEditor>` take `onionSkin` and `motionPaths`.
  - **Agents:** `render_animation_frame` takes `onion_skin` and `motion_paths`, and a new read tool, `get_motion_path`, returns the path as numbers.
  - **Demo:** the animation tab has toggles for both.

## 0.64.0

### Minor Changes

- 333ad75: Animation scenes export to Lottie with `toLottie` and the `export_lottie` agent tool. The output is Bodymovin JSON v5 for lottie-web and the iOS and Android players.

  - **Structure:** one shape layer whose groups mirror the artwork. Each node is an outer group for its animated pose (anchor at its centre) around an inner group for its own transform.
  - **Paint and drawing:** paths have solid fills and strokes with their colour, width and opacity animated. Drawing on becomes trim paths, the camera becomes a root transform, and each shot gets a marker.
  - **Keyframes:** a change driven by one cubic-bezier ease (mirrored repeats included) is an eased keyframe pair. Springs, elastic, behaviours, stepped time, follows, additive layers and camera moves are sampled at `fps`. A test compares Lottie's values against the editor's frame by frame.
  - **Notes:** the export lists what it could not carry over: gradients, dashes, reveal clips, skewed groups and morphs that change point counts.
  - **Demo:** the animation tab has an Export Lottie button.

## 0.63.0

### Minor Changes

- 2da00e7: Animation shots can be cued to music or a voiceover.

  - **Timing tracks:** a scene can carry a `beat` grid (`bpm`, `offset`, `meter`) and `narration` word timings, for example from TTS or speech-to-text.
  - **Cues:** a shot's `at` cue (`{ beat }`, `{ word }` or `{ ms }`) starts it on that moment, and the shot before holds until then.
  - **Checks:** `cue-missed` warns when the shot before runs past a cue, and `unknown-cue` flags a beat with no grid or a word the narration lacks.
  - **Helpers:** `motionBeatTime`, `motionBeatAt` and `motionCueTime`. `MotionShotTiming` gains `cue` and `missedBy`.
  - **Agents:** a new read tool, `get_timing_grid`, lists beats (with bar and beat) and words with their times. `set_animation_settings` sets the beat grid and narration, and shot tools take `at`.

## 0.62.0

### Minor Changes

- 70ae8ed: Animation scenes can be fitted to a length.

  - **Shot speed:** a shot's `speed` scales all of its time: camera move, delays, durations, staggers and hold.
  - **Fitting:** `fitMotionScene(scene, ms, { keep })` and the `fit_animation` agent tool (one undo step, with a dry run) set the shots' speeds so the scene lasts `ms`. Kept shots play as they are, and the rest stretch or squeeze together. This follows After Effects' protected regions.
  - **Refusals:** it refuses, with the reason, when the kept shots alone outlast the target or a speed would leave 0.05–20×.
  - **Checks:** the length warnings now point to `fit_animation`.

## 0.61.0

### Minor Changes

- 82031d8: The animation editor gains Smart Animate: the `match` command tweens a group into another group (usually hidden), part by part.

  - **Pairing:** parts pair by name, then by id with the groups' own ids taken out (`card-a-title` ↔ `card-b-title`), then by kind in stacking order. Nested groups pair their own parts the same way.
  - **Morphing:** each part morphs into its partner's shape, paint and place. Parts with no partner fade out.
  - **Checks:** `match-unpaired` notes the parts of `into` that have no partner (they cannot appear), and `match-self` refuses a group matched into itself or into a group it holds.
  - **Agents:** `matchMotionNodes` returns the pairing, and the command has an agent-tool schema.

## 0.60.0

### Minor Changes

- 2feef94: The animation editor stacks motion. A command with `blend: "add"` becomes a layer over the target's pose instead of a change that the next one takes over from. It stacks with whatever else moves the target, and what it adds stays once it ends.

  - **Emphasis:** pulse, shake, teeter, wave and wiggle are additive by default, so a shake during a slide shakes as it slides and lands where the slide ends. Pass `blend: "replace"` for the old take-over.
  - **Move, rotate and scale:** they take `blend: "add"` too. Offsets and turns add; scales multiply.
  - **Overlap check:** additive layers are no longer reported as overlapping.
  - **Flair export:** a layer on its own is one exact change; layers that overlap the pose are sampled.
  - **New exports:** `motionAddTrackKey`, `withMotionLayers`, `MOTION_ADDITIVE_PROPERTIES` and `MOTION_BLENDS`.

- c3503c6: Agents now edit rich text inline, the way collaborators do in Google Docs. `createRichTextToolProvider` draws the agent's caret, with its name, where its tools read and write. `find_text` and `set_selection` highlight the agent's selection, and edits tint the new text for a moment. With `presence: { typing: true }`, inserted and replacement text is typed out a few characters at a time. It is still one undo step, and it rolls back if the call is cancelled.

  `insert_text`, `replace_range` and `replace_selection` now return the new text's `range`. The caret is on by default; pass `presence: false` to turn it off. The new building blocks are `AgentCaret`, `setAgentCaret`, `clearAgentCaret`, `markAgentChanges` and `typeAgentText`.

## 0.59.0

### Minor Changes

- 24703a8: The animation editor gains timing features and imports from Flair.

  - **Springs:** Figma's named springs are new easing presets (`spring-gentle`, `spring-quick`, `spring-bouncy`, `spring-slow`; `SPRING_PRESETS`). A command with a spring and no `duration` lasts until the spring settles (`springSettleMs`). A new `spring-cut-short` warning flags a spring given less time than it needs. The tools accept spring and elastic objects.
  - **Repeat:** any command except `enter` and `exit` can `repeat`, with `repeatMode` `loop`, `mirror` (every other cycle plays backwards) or `offset` (carry on from where the last ended). `duration` is one cycle; see `motionCycleDuration` and `motionCommandRepeat`.
  - **Stepped time:** `steps` on a command, or on the scene with `set_animation_settings`, holds poses on a frame grid ("on twos").
  - **Geometric zoom:** `geometric` on `scale` and on cameras zooms at a steady rate.
  - **Flair export:** a `flair` version option (default `0.39`) decides what is written exactly. Flair 0.39 takes springs, stepped time as `strobe`, and mirrored repeats as reversed curves (`reverseCubicBezier`). Older versions get these sampled.
  - **Flair import:** `fromFlairSvgMotion` and `fromFlairVectorEffect`, plus the `import_flair_effect` agent tool (with a dry run), turn a Flair motion or catalog effect into a scene. Colour placeholders become controls, each step becomes a shot, and behaviours become emphasis commands, with notes on anything that does not carry over.

## 0.58.0

### Minor Changes

- 5af1e38: The animation editor plays Flair's clip-path reveals, and exports them and follows to Flair exactly:

  - **New styles:** `enter` gains `wipe` (an edge travelling `direction`, default right), `iris` (from the centre; `shape`: `circle` or `box`) and `split` (from a line through the middle; `orientation`: `horizontal` or `vertical`). `exit` gains `wipe`. They match Flair's `entrance.wipe`, `entrance.iris`, `entrance.split` and `exit.wipe`, padding the clip for the stroke. A node with no width or height fades instead, and `checkMotionScene` warns `reveal-no-box`.
  - **Frames:** reveals are clips in the node's box units, `MotionFrame.clips` (the vector model has no clips). `motionFrameToSvg` and `<AnimationStage>` wrap each clipped node in a group with an `objectBoundingBox` clip path, through `vectorDocumentToSvg`'s new `wrap` option.
  - **Flair export:** a reveal is a wrapper group plus a clip rect or circle whose attributes animate. A follow is Flair's `along` (with `orient` when it turns) on a wrapper, along a copy of the path in the node's parent's units, instead of sampled transform steps.
  - **Follows** are measured in the node's parent's units (a follow inside a rotated or scaled group now turns the right way), and with `rotate`, moves made during the follow turn with the path. `motionNodeOffset` takes a `follow` flag and returns the follow apart.

- 5af1e38: The animation editor speaks Flair's motion primitives (`@pixerate/flair/motion`). Shared commands and primitives have the same names and defaults:

  - **New entrances:** `enter` gains the `zoom` and `rise` styles, and a starting `scale` for `pop` and `zoom`.
  - **New emphasis commands:** `teeter`, `wave`, `wiggle` (seeded smooth noise; the same seed always wanders the same way, and by default each target gets its own seed from its id) and `color-pulse`.
  - **Shake:** `shake` takes an `axis`.
  - **Primitive names:** `motionFlairPrimitive` and `get_animation`'s `flairPrimitive` name the Flair primitive each command plays.

  Pulses, shakes and the new emphasis commands are now Flair behaviours. `MotionSegment.wave` is replaced by `behavior` (and `index`), and `@pixerate/editor/animation` exports `behaviorProgress`, `fractalWiggle` and `motionSeedFromId`, ported from Flair so the numbers match.

  The Flair export writes these behaviours as one exact change with `behavior` instead of sampling them. This needs Flair 0.38 or later; pass `behaviors: false` (also on `export_flair_motion` and `export_flair_effect`) to sample them for older Flair.

## 0.57.0

### Minor Changes

- f362946: The animation editor's Flair export writes cubic-bezier easings (`ease`, `ease-in`, `ease-out`, `ease-in-out`, the back eases and custom `{ type: 'cubic-bezier' }` curves) as one change with `ease: [x1, y1, x2, y2]` instead of sampling them into linear steps; Flair's own names are still used where they match within 1%. This needs Flair 0.36 or later: pass `curves: false` (also on the `export_flair_motion` and `export_flair_effect` agent tools) to sample them for older Flair. Adds `flairCurveFor` and the `FlairEase` type. Overshooting curves on colours, opacity and draw-on stay sampled, since their values cannot pass their ends.

## 0.56.0

### Minor Changes

- 391d3d0: Mermaid diagrams reach parity with Ursula: pie, mindmap, quadrant, C4, architecture, sequence, gitGraph, Gantt, timeline, journey, XY and radar diagrams are now editable statement by statement (lossless, like flowcharts), with family layouts and their own pictures (`mermaidToScene`, also used by `mermaidToSvg`, thumbnails and PNG export). `parseSankey` and `parseTreemap` read sankey and treemap data. `familyUI` describes each family's shapes, defaults and data fields, and `checkFieldData` validates them. Agents get `set_diagram_node_data`, `set_diagram_edge_data`, `set_diagram_settings` and `set_diagram_title`, and `get_diagram` lists the fields and values. React and Svelte add `<MermaidFamilyScene>`, plus `scene` and `renameTarget` on `useMermaidDiagram` / `createMermaidDiagram` (which also take `{ sceneTheme, layoutOptions }` as a second argument).

## 0.55.0

### Minor Changes

- f945529: Publish the vector animation editor (`@pixerate/editor/animation-editor`, `@pixerate/editor-react/animation-editor`, `@pixerate/editor-svelte/animation-editor`) and Mermaid diagram export. The 0.54.0 / 0.41.0 / 0.49.0 packages on npm were built before these landed (a release that failed part-way had already published those versions), so they do not contain them even though their changelogs list them.

## 0.54.0

### Minor Changes

- ea93937: Mermaid diagrams can now be exported and previewed (ported from Ursula's thumbnails and PNG export). `mermaidToSvg` draws a standalone SVG that matches the canvas layout, with Mermaid styles, arrow heads and labels. `mermaidThumbnailSvg` fits it to a box. `rasterizeSvg` and `downloadDiagramPng` make PNGs in the browser. `createDiagramToolProvider({ renderSvg, rasterize })` adds a `render_diagram` agent tool. React and Svelte add `<MermaidThumbnail>`.
- 14bd63e: Add an MCP bridge (ported from Ursula): `@pixerate/editor/bridge` (Node only, no dependencies) runs one MCP server over stdio that drives editors open in a browser over a localhost WebSocket. It has an origin allowlist, an optional token, `list_editors`, an `editor` argument for picking an editor, cancellation, timeouts and port retry. The `pixerate-mcp-bridge` CLI starts it. Pages connect their `ToolRegistry` with `connectToolBridge` (`@pixerate/editor/tools`), which re-sends the tool list on change and reconnects after the bridge restarts. React and Svelte add `useToolBridge`.
- e4a0275: Add a UI-agnostic animation editor for vector artwork (`@pixerate/editor/animation-editor`), modelled on Lingo's scenes. A `MotionScene` is the vector editor's artwork plus shots of commands (enter, exit, draw, move, rotate, scale, fade, style, morph, follow a path, pulse, shake, live path-effect tweens) and camera moves, with timing taken from the content. `motionFrameAt` / `motionFrameToSvg` draw any frame, `checkMotionScene` reports coded issues with "did you mean" suggestions, `AnimationEditorController` edits all-or-nothing with undo and plays on an injectable clock, and `createAnimationEditorToolProvider` gives agents 22 tools. `toFlairSvgMotion`, `toFlairVectorEffect` and `toFlairEffectDocument` export to Flair's vector motion, catalog effects (with colour controls and presets) and effect editor. React adds `useAnimationEditor`, `useAnimationEditorTools`, `<AnimationEditor>`, `<AnimationStage>` and `<ShotTimeline>` (`@pixerate/editor-react/animation-editor`); Svelte adds `createAnimationEditor`, `useAnimationEditorTools` and the same components (`@pixerate/editor-svelte/animation-editor`).

## 0.53.0

### Minor Changes

- 883d9d7: Charts: error bars, logarithmic axes and reversed axes.

  - Series take `errorBars` (bar, line, area, scatter) and `xErrorBars` (scatter / bubble x): `fixed`, `percent`, `stddev` (around the series mean, as Excel), `stderr` or `custom` plus / minus amounts, with `direction` and `cap`. Drawn as `error-bar` marks, on stack tops when stacked, and included in the axis range. `chartErrorAmounts`, `describeChartErrorBars`, `chartErrorBarsOfType`.
  - Value axes and the scatter x axis take `scale: "log"` with `logBase` (2–1000, default 10): power or 1-2-5 ticks (`niceLogScale`), values of 0 or less skipped with a `values-skipped` warning, refused with percent stacking. `ChartValueScale.logBase`, `chartScaleToPixel` / `chartScaleFromPixel`; drags move by ratio and ↑ ↓ step by a tenth of a power.
  - Every axis takes `reverse: true`.
  - Office import / export reads and writes `c:errBars`, `c:logBase` and `c:orientation maxMin` (no longer reported as unsupported); Mermaid keeps them in the `%% @pixerate` comment.
  - `update_chart` / `update_chart_series` (tools and commands) describe the new fields; summaries and descriptions mention log and reversed axes and error bars.
  - `<ChartInspector>` (React and Svelte): Reverse and Log scale toggles with a log base on axes, and error bar type, amount, custom amounts, direction and caps on the selected series.

- 3acb651: Agent edits to Mermaid diagrams can now be acted out by a cursor (ported from Ursula's remote control): `DiagramDirector` moves, clicks, drags, connects and types on the canvas, draws a whole-diagram write statement by statement (`draftFrames`), and commits each call as one undo step (rolled back if the diagram changed underneath). Pass it to `createDiagramToolProvider({ director })`. The presence store, clock, cursor tween and per-actor queue (`PresenceStore`, `PerformanceQueue`, `createInstantPresenceClock`) move to `@pixerate/editor/animation` and are shared with `ChartDirector`, which now hides cursors after `linger` as documented. React adds `useDiagramDirector` and `<DiagramPresenceLayer>`; Svelte adds `createDiagramDirector` and `<DiagramPresenceLayer>`.
- d01edac: Add Mermaid diagrams (ported from Ursula): `@pixerate/editor/diagram` parses and writes flowchart, state, class and ER diagrams losslessly (untouched statements round-trip byte for byte, edits rewrite only what they touch, positions in a `%% @pixerate` comment; Ursula's `@ursula` comment is still read), with `DiagramController` (validated, undoable edits), `findMermaidSources` and 19 agent tools (`createDiagramToolProvider`). `@pixerate/editor/canvas` adds `mermaidToCanvas` (dagre layout with nested groups, stored positions blended with new nodes), `mermaidMovesFromCanvas`, `DiagramStream` for diagrams that are still being written, and Mermaid shape geometry. React adds `useMermaidDiagram`, `useMermaidStream`, `<MermaidDiagramNode>` and `<MermaidDiagramGroup>`; Svelte adds `createMermaidDiagram`, `createMermaidStream` and the same components.

## 0.52.0

### Minor Changes

- 52ae1ba: Read charts from Excel, PowerPoint and Word files. `extractOfficeCharts` (and `extractXlsxCharts`, `extractPptxCharts`, `extractDocxCharts`) in `@pixerate/editor/chart` return every chart in a file as a `ChartSpec` with where it sits: the sheet and anchor cell in a workbook, the slide number in a deck. DrawingML and Office 2016 chartex charts are both read. `createOfficeChartToolProvider` gives agents `list_open_files`, `list_file_charts`, `get_file_chart` and `load_file_chart`, and React and Svelte register it with `useOfficeChartToolProvider`.

## 0.51.0

### Minor Changes

- e3c9c3e: Chart PNG previews. Core adds `rasterizeChartSvg` (resolves CSS-variable paints with `resolveChartSvgPaints`, so charts no longer draw black, then draws through a canvas at 2× with the longest side ≤ 1024 px), `createChartRasterizer`, `downloadChartPng` and `chartFileName`. `render_chart` now says when an image is worth its tokens, returns the layout warnings with SVG and PNG results, and the React and Svelte `useChartToolProvider` pass a browser rasterizer by default so `render_chart { format: "png" }` works out of the box (`rasterize: false` turns it off). `<ChartEditor>` gains a Download PNG toolbar button (`pngOptions`).

## 0.50.0

### Minor Changes

- 39d5cba: feat(canvas,image-editor,vector): add `PIXERATE_BRAND_GRADIENT`, UI-agnostic agent presence trajectory/rotation math and `AgentCursorPresence`, region mosaic/blur image filters (`applyRegionMosaic`, `applyRegionBlur`), and CSS transform scale compensation in `VectorCanvas`

## 0.49.0

### Minor Changes

- c286ab1: Word export writes `chart` nodes as native Word charts: each becomes a `word/charts/chartN.xml` part (`chartToOoxml`) with its relationship and content type, referenced from an inline drawing sized from the node's `width` / `height` (no width = the page's text width; wider charts are scaled down to fit). Re-importing the file gives back the same spec (series ids are renumbered: DrawingML has none). Inline `sparkline` nodes are written as text, their label or block characters (`▁▅█`), and reported. `DocxExportReport.written` gains a `charts` count.

## 0.48.0

### Minor Changes

- 5c63bdd: Charts in documents: `createRichTextPreset({ chart: true })` adds a `chart` block node (a `ChartSpec` in `data-chart`, a static SVG in HTML, a ` ```mermaid ` block in markdown) and an inline `sparkline` node, with `insertChart`, `updateChart` and `insertSparkline` commands and `getDocumentCharts`. DOCX imports insert embedded charts as chart nodes when the schema has them (otherwise a caption and a data table, as before, now after the paragraph). `createReactChartNodeView` and `createSvelteChartNodeView` draw each chart with `<ChartCanvas>`: read-only until clicked, then editable with the inspector and data grid, with every edit an editor undo step. `createRichTextToolProvider` adds `list_document_charts`, `insert_chart`, `update_chart_in_document` and `insert_sparkline`. Adds `chartSceneToDomSpec` for drawing charts in ProseMirror `renderHTML`.

## 0.47.0

### Minor Changes

- 151685e: Chart editor: bubble, radar, waterfall, histogram, box, funnel and treemap charts; a secondary value axis; numeric-x scatter; date axes; trendlines with fits; marker shapes, per-point colours, label positions, bar spacing, fixed tick steps and spreadsheet format codes; presets and colour-blind checks; Mermaid and Office chart XML import and export, with charts in DOCX imports; streaming views, agent presence cursors and sparklines; layout warnings, summaries and accessible SVG; drag snapping, fine adjustment and Escape to cancel. Adds `createChartToolProvider` (28 agent tools) with `useChartToolProvider` in React and Svelte. `run_commands` takes `$N.path` result references and `atomic` batches, and schema errors suggest the argument you meant.

## 0.46.1

### Patch Changes

- 31d12f7: Fix chart editor correctness bugs. Tick labels now use as many decimals as the step needs (a 2.5 step labels `0.0 | 2.5 | 5.0`, a 0.025 percent step labels `2.5%`). `niceScale` computes ticks as `first + i·step`, so ranges near 1e16 no longer emit duplicate ticks, and non-finite or ±`Number.MAX_VALUE` ranges stay finite. Stacked data labels pick dark or light text by the fill's luminance and are skipped when the segment is too short. No-op edits, and drags that end where they started, no longer record an undo step. `layoutChart` takes a `valueDomain` option and `ChartPointDrag` exposes `valueDomain`; the React and Svelte canvases pass it during a drag so the value axis no longer rescales under the pointer.

## 0.46.0

### Minor Changes

- 2dc922d: Add a UI-agnostic chart editor (`@pixerate/editor/chart`, `@pixerate/editor-react/chart`, `@pixerate/editor-svelte/chart`). Bar, line, area, scatter, pie and donut charts (combos, stacked and 100% stacked, horizontal bars, smooth / step lines) are described by a validated JSON `ChartSpec`. `layoutChart` turns a spec into DOM-free drawing primitives with click targets, and `chartToSvg` exports them. `ChartController` edits data and presentation with selection, drag gestures and undo. The interaction helpers (`startChartPointDrag`, `handleChartKey`) are shared by both frameworks, and `createChartCommands` provides agent tools. React and Svelte add `ChartEditor`, `ChartCanvas` (click to select, drag bars and points, keyboard editing), `ChartDataGrid` (spreadsheet paste, CSV import), `ChartInspector`, and `useChartEditor` / `createChartEditor` with `useChartCommands`.

## 0.45.0

### Minor Changes

- 07d4fab: Make agent tools easier for models to use correctly:

  - **Rich text**: new `find_text`, `replace_text` (all matches or the n-th, one undo step), `replace_range` and `set_selection` tools. `get_text { blocks: true }` returns each paragraph's document positions, so agents no longer have to turn plain-text offsets into ProseMirror positions.
  - **Canvas and prompt**: `createEditorMcpToolProvider` now exposes one strict tool per operation by default (`canvas_add_node`, `canvas_connect`, …, `prompt_insert_text`, …; definitions in `EDITOR_CANVAS_TOOLS` / `EDITOR_PROMPT_TOOLS`). Pass `toolStyle: "combined"` to keep `edit_canvas` / `edit_prompt`. Edits are checked against the snapshot with the new `validateAgentCommand` (unknown or duplicate ids, self-edges, unordered ranges). Results include the ids of created nodes and edges. Errors for combined tools name the missing arguments. `highlight` passes `color` / `durationMs` through.
  - **Spreadsheet**: new `set_range` (2D block as one undo step, refuses read-only targets), `insert_rows`, `delete_rows`, `insert_columns` and `delete_columns` tools.
  - **MCP server**: new dependency-free `createMcpServer(registry, { name, version, send })` in `@pixerate/editor/tools`. It handles `initialize`, `ping`, `tools/list`, `tools/call`, cancellation and `notifications/tools/list_changed` over any transport.
  - **Schema validation**: `validateJsonSchema` now supports `anyOf`, `oneOf`, `allOf`, `not`, local `$ref`, `exclusiveMinimum` / `exclusiveMaximum`, `multipleOf` and `uniqueItems`. Unknown-property errors list the allowed properties.
  - **Metadata**: component, image-editor and command tools now have titles and a description for every argument. `reset_overrides`, `push_overrides`, `detach_instance` and `remove_variant` are marked destructive.

## 0.44.0

### Minor Changes

- da26571: Add distort tools and live envelopes to the vector editor.

  - Free Distort mode of the selection box (`setFreeDistort`, `state.freeDistort`): dragging a corner distorts the selection in perspective by an exact homography (Shift+Alt+Mod: symmetric perspective), a side moves its two corners and Mod-dragging a side skews along it. `distort(corners)` and `skew(ax, ay)` do the same from code, on rotated nodes too (mapped in document space, written back into each node's own space). One undo step per gesture.
  - Adaptive path mapping (`mapVectorSubpaths`, `mapVectorPoints`, `mapBezierPath`): curves stay Bézier paths through any map within a tolerance, refitted to fewer anchors where possible; straight lines stay straight under a projective map. User-space gradient handles are mapped with the shape. Homography helpers: `vectorHomography`, `applyVectorHomography`, `orderVectorQuad`.
  - A non-destructive `envelope` effect: Photoshop's fifteen warp presets (arc, arc lower / upper, arch, bulge, shell lower / upper, flag, wave, fish, rise, fisheye, inflate, squeeze, twist) with bend, horizontal / vertical distortion and orientation, or an editable bicubic mesh of rows × columns (split exactly with de Casteljau). Expand Appearance bakes it; Release gives its shape back as a path; Make with Top Object uses a closed path's outline as the envelope. Controller `envelope`, `makeEnvelopeWithTopObject`, `releaseEnvelope`; mesh helpers in `warp.ts`.
  - An Envelope tool (U) that drags the mesh's anchors and handles, or pulls the surface from inside a patch, drawn in the overlay of both canvases.
  - Agent commands `vector.distort`, `vector.skew` and `vector.envelope`.
  - React and Svelte: a Distort toggle in `VectorToolbar` (`showDistort`), `VectorEnvelopePanel` (in `VectorStylePanel`: Make with Warp / Mesh / Top Object, warp preset, bend and distortion sliders, orientation, mesh rows and columns, Release, Expand), and the Free Distort quad and envelope mesh on `VectorCanvas`. The Effects panel lists an envelope without its parameters, which the Envelope panel edits.

## 0.43.0

### Minor Changes

- 2663d50: Upgrade gradients in the vector editor.

  - Gradient paints (`VectorGradient`, a superset of the canvas package's `CanvasGradientDef`, which is unchanged) gain conic, reflected and diamond styles; stop midpoints; sRGB / linear-light / Oklab interpolation and smoothness; pad / reflect / repeat spread; a radial focal point, focal radius and aspect; explicit start / end / aspect frames in the shape's box or its own space (the angle / centre shorthand still works, and node-space gradients follow scale and skew); and `strokeMode` (within, along or across a stroke).
  - Rendering and SVG export stay DOM-free and plain SVG: midpoints and colour spaces become extra stops, conic and diamond gradients and stroke modes become `<pattern>`s of linear-gradient tiles, and every field round-trips through `data-vector-gradient`. Import reads `fx`, `fy`, `fr`, `spreadMethod`, `gradientTransform`, `gradientUnits="userSpaceOnUse"` and `href` inheritance. `vectorPaintToSvg` now returns `{ value, defs }` and `scene.defs` holds `VectorPaintDef`s (gradients and patterns).
  - A Gradient tool (G): drag to set the vector, handles for start, end / radius, aspect and focal point, click the bar to add a stop, drag stops along it or off it to delete them, drag midpoints; one undo step per gesture.
  - Controller `setGradient`, `setGradientStop`, `addGradientStop`, `removeGradientStop`, `reverseGradient`, `setGradientTarget` and `selectGradientStop`; agent command `vector.setGradient` and a gradient paint schema for `vector.setStyle`; blends mix the new fields.
  - React and Svelte: `VectorGradientEditor` (in `VectorStylePanel`: type, stops with colour, opacity, position and midpoint, colour space, smoothness, spread, stroke mode, reverse), `VectorGradientAnnotator` on the canvas, and `VectorGradientDefs` rendering patterns.

### Patch Changes

- 57c2fa0: Fix the vector editor's History buttons lagging one step under React StrictMode: `VectorEditorController.subscribe()` now reconnects to the history after `destroy()`, so a controller kept by `useVectorEditorController` survives StrictMode's double effect.

## 0.42.0

### Minor Changes

- d8d1c26: Add non-destructive path effects and live booleans to the vector editor.

  - Paths and groups carry an editable effect stack (`effects`: Trim Paths simultaneous / individual, Round Corners, Pucker & Bloat, Twist, Zig Zag, seeded Wiggle Paths, Offset Paths with copies, Merge Paths, Repeater with an opacity ramp and fractional copies), stacked as in After Effects: effects act on every path above them and effects after a repeater act on its copies. `expandVectorAppearance` evaluates them in one cached place that rendering, hit-testing, bounds, snapping, booleans, the Pathfinder, Outline Stroke and SVG export read; anchors stay editable.
  - Controller: `addEffect`, `updateEffect` (slider drags merge into one undo step with `{ merge }` / `endMergedEdit`), `moveEffect`, `removeEffect`, `expandAppearance`, and `booleanOp(op, { live })` for live boolean groups whose operands stay editable, each with its own operation, folded with a prefix cache. The destructive `booleanOp` stays the default.
  - Agent commands `vector.addEffect`, `vector.updateEffect`, `vector.removeEffect`, `vector.expandAppearance` and a `live` option on `vector.boolean`; SVG export keeps effects and live booleans for round-tripping.
  - React and Svelte: an Effects section in `VectorStylePanel` (also `VectorEffectsPanel`) and a Live toggle for the toolbar's boolean buttons.

## 0.41.0

### Minor Changes

- a774bc8: Add live blends and path morphing to the vector editor.

  - `createVectorMorph` / `interpolateVectorPaths`: anchors inserted by arc length, the start and winding chosen by best fit and shape context, Procrustes in-betweens that turn rather than collapse, contours growing from points, open/closed pairs, live corners, rigid transforms, and paint (OKLab colours, resampled gradients, stroke width, opacity, dashes, width profiles). `evaluateVectorPathKeyframes` morphs path keyframes with the animation easings.
  - Blend groups (`blend`, `setBlendOptions`, `replaceBlendSpine`, `expandBlend`, `releaseBlend`, `addBlendKey`): keys plus in-betweens regenerated whenever a key changes, spaced by steps, distance or smooth colour, optionally following a replaced spine and oriented to it. A Blend tool (J), a spine overlay, `vector.blend` / `vector.blendOptions` / `vector.expandBlend` / `vector.releaseBlend` / `vector.replaceSpine` commands, and SVG round-trip.
  - React and Svelte: a Blend group in `VectorToolbar` (`showBlend`) and spine / Blend tool rendering in `VectorCanvas`.

## 0.40.0

### Minor Changes

- e30e81c: Vector editor: more of the Width tool and profile-aware arrowheads.

  - Width tool: Alt-drag a width point's centre to slide a copy; dropping a slid point onto another makes a discontinuous point (the width steps there); Shift-click adds or removes width points from a multi-selection, dragging one of several selected points moves or widens them together, and Delete removes them all.
  - **Breaking:** `VectorEditorState.selectedWidthPoint` (one ref or null) is now `selectedWidthPoints` (a list, all on one path). New `selectWidthPoints(refs)` and `removeWidthPoints(refs?)`.
  - Width Point Edit: double-click a width point or a stroke with the width tool to edit its position and left / right side widths numerically. Headless as `state.widthPointEdit` with `openWidthPointEdit`, `commitWidthPointEdit`, `closeWidthPointEdit` and `setWidthPoint({ nodeId, index? }, { t, left, right })`, plus a `vector.setWidthPoint` agent command; React and Svelte `<VectorCanvas>` show the new `<VectorWidthPointEditor>` beside the point.
  - Arrowheads on variable-width strokes are sized from the profile's width at their end, with the stroke width as a floor (a taper to nothing still gets a full-size head).

## 0.39.0

### Minor Changes

- a06095a: Shape Builder: Alt now erases the edges of closed outlines too, not only the pieces of unfilled open paths. The nearer of a line piece and an outline edge within tolerance is taken; an erased edge opens a closed subpath there, splits an open one or removes a subpath it runs all the way round, a filled open subpath runs round its invisible closing edge without it ever coming back, and an edge bounding a face deleted in the same gesture goes with that face. Results stay in each node's own space with its transform, `shapeBuilder()` and the `vector.shapeBuilder` command report the `edges` erased, and the overlay's `builder.lines` shows them. Hovered and dragged faces now get a 45° hatch (`builder.hatches`, from the new `hatchPath` helper) over the translucent fill, drawn by the React and Svelte canvases as `data-vector-builder-hatch`. New pathops helpers: `cutOutPiece`, `contourEnclosesArea`, `hatchPath`.

## 0.38.0

### Minor Changes

- 19884fe: Add Pathfinder extras, a Shape Builder tool and click-to-fill regions to the vector editor.

  - `VectorEditorController.pathfinder('divide' | 'trim' | 'merge' | 'crop' | 'outline' | 'minusBack')` in document space (rotated nodes, holes, live corners; unfilled stroked paths take part as their stroke's area), plus the `vector.pathfinder` command.
  - Shape Builder tool (M): hover highlights the face under the pointer, click or drag merges faces into one shape, Alt deletes faces and line pieces; `shapeBuilder`, `getShapeBuilderFaces` and the `vector.shapeBuilder` / `vector.shapeBuilderFaces` commands.
  - Paint Bucket tool (B) and `fillRegion`: fills the region the visible outlines enclose (crossings split, islands as holes, optional `editing.fillGap`), plus `vector.fillRegion`.
  - Core geometry: `pathfinder`, `PlanarMap`, `planarSplit`, `pathBooleanSelect` and `interiorPoint` in `@pixerate/editor/canvas`.
  - Overlay `builder` data; React and Svelte canvases draw the face highlights and both toolbars gain a Pathfinder group and a Gaps toggle.

## 0.37.0

### Minor Changes

- df0c7f3: Variable-width (tapered / profiled) strokes for the vector editor: `strokeWidthProfile` with left / right side scales and monotone interpolation, presets (taper start / end / both, bulge, pinch, teardrop, wave, pressure) and parametric taper / wave generators; exact outlines refitted to Bézier curves (caps, joins, dashes, live corners, arrowheads and alignment) used for rendering, hit-testing, SVG export (round-trips the profile) and Outline Stroke; a Width tool (W) with draggable width points; pencil strokes record pen pressure; a `vector.setWidthProfile` agent command; and a profile picker with reset in both style panels. The polygon boolean engine classifies edges with a band index, making large overlays much faster.

## 0.36.0

### Minor Changes

- 6e84d7b: Vector editor: live corners and stroke options. Any corner anchor can carry a radius (`anchor.corner = { radius, kind }`, kinds `round`, `inverted`, `chamfer`); the anchors stay sharp and `expandVectorCorners` (called by `subpathsToBezier`) draws the cut at render, hit-test, bounds, boolean, outline and export time, as a true arc at any angle that also follows curved sides and shrinks to fit short ones. The rectangle, polygon and star tools (and `<rect rx>` on import) now set corner radii instead of baking curves (`rectSubpath(bounds, radius)` returns four anchors with corners), `setCornerRadius` / `setCornerKind` edit them, and the direct tool shows draggable corner widgets (Alt-click cycles the kind). Strokes gain `strokeAlign` (`center`, `inside`, `outside`; closed shapes only) and arrowheads (`startArrow` / `endArrow`: triangle, arrow, open, circle, square, bar; `arrowAlign` `extend` / `tip`; `startArrowScale` / `endArrowScale`), drawn by both `VectorCanvas`es with clip paths / masks, respected by hit-testing, and exported to SVG as a double-width stroke with a clip or mask plus filled heads (or `{ strokes: 'outline' }`), which import merges back. New `outlineStroke()` action (toolbar ⊡) and helpers `vectorStrokeParts`, `vectorStrokeOutline`, `vectorCorners`, `getVectorCornerWidgets`. `getVectorSelectionStyle` reports the new fields, both `VectorStylePanel`s edit alignment, heads and corner radius / kind, and the agent commands add the fields to `vector.setStyle` plus `vector.setCorners` and `vector.outlineStroke`.

## 0.35.0

### Minor Changes

- 79c9606: Vector editor: path editing upgrades. Deleting points now keeps the shape (the neighbouring handles are refitted to follow the removed segments as closely as possible; `deleteAnchors(refs, { keepShape: false })` or `setEditing({ keepShapeOnDelete: false })` turns it off). Dragging a segment with the direct tool bends it through the pointer (a click still selects it); `bendSegment(ref, to, t)`. Dragging a lone point can bend its two segments like the Curvature tool (`setEditing({ curvatureMoves: true })`, Alt during the drag flips it; `moveAnchor(ref, to, { curvature })`). New clean-up actions: `joinPaths` (Mod+J), `averageAnchors` (Mod+Alt+J), `removeRedundantPoints`, `smoothPaths` and `cutAtAnchors`. New tools: Scissors (C, cut a path at a point), Knife (K, cut filled shapes along a freehand stroke with no gap between the pieces) and Eraser (E, rub out a round stroke from fills and outlines; `eraserSize`), also as `cutPathAt`, `knife(points)` and `erase(points)`. The pencil gains lazy-mouse smoothing (`pencilSmoothing`) and optional ink-to-shape recognition (`recognizeShapes`: lines, rectangles, ellipses, polygons). Everything edits in each node's own space, so rotated nodes work. New agent commands `vector.deleteAnchors`, `vector.moveAnchor`, `vector.bendSegment`, `vector.join`, `vector.average`, `vector.removeRedundantPoints`, `vector.smooth`, `vector.cut`, `vector.knife`, `vector.erase` and `vector.setEditing`; geometry helpers in `pathEdit` / `pathCut` / `ink` (`removeAnchorKeepingShape`, `bendSegment`, `curvatureMoveAnchor`, `cutSubpathAt`, `joinSubpaths`, `knifePath`, `eraseFromFill`, `LazyMouse`, `recognizeInkShape`, …) and `fitCubicWithTangents` in the curve fitter. The `e` key now picks the eraser (the ellipse tool stays on `o`). Both `VectorCanvas`es draw the knife and eraser strokes, the pencil string and the scissors cut point, and both `VectorToolbar`s add a path-editing group (`showPathEdit`).

## 0.34.0

### Minor Changes

- 8f7604e: Vector editor: smart guides and object snapping. Moves, selection-box resizes, anchor and handle drags, the pen and the shape tools snap to other objects' anchors, paths, path intersections (curve–curve included), perpendicular and tangent points, bounding-box edges and centres, the artboard and construction angles; moves also space themselves evenly between neighbours, and resizes and new shapes match other objects' widths and heights. Everything works in document space, so rotated nodes snap exactly. `snap` options are now `{ grid, objects, guides, threshold, angles }` (objects and guides on by default, 5 px pull), hold Cmd / Ctrl during a drag to bypass snapping, and `toggleSnapping()` flips object snapping. `state.guides` and `getVectorOverlayRenderData(...).guides` expose the labelled guide lines ("anchor", "centre", "intersect", "path", "align", gap and size labels). New `VectorSnapTargets` (gathered once per gesture, bisection lookups) for custom tools, and `segmentIntersections` in the path ops. The React and Svelte `VectorCanvas` draw the guides (`guideColor` prop) and both `VectorToolbar`s add a snapping toggle (`showSnap`).

## 0.33.0

### Minor Changes

- dcc38d0: Vector editor: nodes get an optional rigid `transform` (rotation + translation) so rotated shapes and groups keep a rotated selection box. `transformVectorNode` now composes the matrix, keeps the rotation in `transform` and bakes scale / skew / mirroring into the anchors (stroke widths and hit tolerances stay exact). Resize handles, `scale` and `flip` work along the selection's own axes, `setRotation` sets an absolute angle (also as `angle` on the `vector.transform` command, and `rotation` in `vector.list`), anchors and handles are edited in each node's own space, booleans and combine work in document space, SVG import keeps rotations and export writes `transform="matrix(…)"`. New helpers: `decomposeRigid`, `matrixRotation`, `vectorNodeRotation`, `vectorWorldMatrix`, `vectorParentMatrix`, `vectorPathWorldBezier`, `invertMatrix`, `getAnchorWorld`, `getVectorSelectionFrame` and `getVectorSelectionBoxGeometry`. The React and Svelte canvases render node transforms and the rotated selection box.

## 0.32.0

### Minor Changes

- 4f79b3b: Add a UI-agnostic vector editor. `@pixerate/editor/vector` has a document model of Bézier paths (corner / smooth / symmetric anchors, compound paths, groups, gradients), a headless `VectorEditorController` with select, direct-select, pen, pencil, rectangle, ellipse, polygon, star and line tools driven by pointer and key events, transforms with selection handles, boolean operations, align / distribute, grouping, stacking, grid snapping, copy / paste, a viewport and one undo step per gesture, plus scene / overlay render data, DOM-free SVG import / export and `createVectorCommands` for agents. `@pixerate/editor-react/vector` and `@pixerate/editor-svelte/vector` add `VectorEditor`, `VectorCanvas`, `VectorToolbar` and `VectorStylePanel` with `useVectorEditor` / `createVectorEditor` and `useVectorCommands`.

## 0.31.0

### Minor Changes

- bf3ebff: Support linear and radial gradients for canvas shapes and freehand drawing, and fix endcaps preservation on stroke completion.

  - Added gradient data models, angle-to-coordinate calculations, presets (`CANVAS_GRADIENT_PRESETS`), and SVG `<defs>` generation in core.
  - Updated `ShapePaint` and shape render pipelines to support gradient fills and strokes across React (`ShapeNode`) and Svelte (`ShapeNode.svelte`).
  - Added live gradient rendering preview to `CanvasDrawLayer` in both React and Svelte.
  - Fixed an issue where freehand pen/highlighter linecaps and joins were stripped upon finishing a stroke or creating single-point dots.

## 0.30.0

### Minor Changes

- a41385b: Add freehand drawing tools (pen, highlighter, eraser) for xyflow canvas:
  - `@pixerate/editor/canvas`: Streamline point smoothing, Bézier curve fitting to ShapeNode, eraser hit-testing, and headless CanvasDrawController with undo/redo history and batch deletion
  - `@pixerate/editor-react/canvas`: `useCanvasDraw` hook and `<CanvasDrawLayer>` interactive SVG overlay with live stroke preview, spacebar pan override, and viewport transforms
  - `@pixerate/editor-svelte/canvas`: `createCanvasDraw` rune and `<CanvasDrawLayer>` Svelte 5 component with reactive SVG overlay and cross-framework parity
- 9c8ab5d: Add parametric elastic easing curves (`elasticAt`, `ElasticEasing`, elastic presets, CSS `linear(...)` generator) to `@pixerate/editor/animation`, and add continuous parameter range mappers (`createRangeMapper`, `mapRange`) with customizable interpolation, easing curves, and domain clamping safeguards to `@pixerate/editor/parameters`.

## 0.29.0

### Minor Changes

- 41af28c: Add `@pixerate/editor/parameters`, a headless schema-driven parameters editor for effects, shaders, generators and component props. `ParameterSchema` covers number / int (slider or input, unit, step), boolean, choice, color (hex, optional alpha), vector (2–4), image and text fields with labels, descriptions, defaults, collapsible groups and `showIf` conditions. `ParametersController` validates values with sentence errors, keeps a stable `getState()` for `useSyncExternalStore`, records undo steps in a `HistoryManager` (slider drags merge into one via `beginGesture` / `endGesture`), and supports reset, seeded randomize, presets (apply / save / delete), `setSchema`, `toJSON` / `load` and optional keyframe hooks shaped like the canvas `AnimationTrack`. `createParameterCommands` exposes it to the command palette and agents, and `parameterSchemaFromShaderControls` adapts shader `@control` definitions.

## 0.28.0

### Minor Changes

- e06ae39: Add `@pixerate/editor/animation`, the keyframe animation model as its own dependency-free subpath: `AnimationTrack` / `AnimationKeyframe` / `AnimationValue` and the easing types, `resolveEasing`, `evaluateEasing`, `cubicBezierAt`, `springAt`, the easing presets and labels, `parseCssEasing`, `easingToCss`, `evaluateTrack`, `interpolateAnimationValue`, `normalizeKeyframes`, the OKLab colour helpers, `AnimationPlayer` / `createAnimationPlayer` and the `Clock` / `ManualClock` / `realClock` time sources. It imports no dagre, TipTap or canvas-node code, so apps that only need keyframes no longer have to install `@dagrejs/dagre`. `@pixerate/editor/canvas` still re-exports all of it.
- ca79b03: Add the `@pixerate/editor/tools` subpath: `ToolRegistry`, `createToolRegistry`, `ToolRegistryError`, the agent tool types, `validateJsonSchema` and the static `EDITOR_MCP_TOOLS` definitions, with no TipTap, ProseMirror or dagre imports. Hosts that only combine tool providers (for example `createCommandToolProvider`) no longer need TipTap installed. `@pixerate/editor/agent` still re-exports all of it, and the TipTap-bound providers (`createRichTextToolProvider`, `createEditorMcpToolProvider`, ...) stay there. The React and Svelte tool-provider helpers now import their types from `/tools`.

## 0.27.0

### Minor Changes

- 40d8cb2: Edit the variants of a canvas component set. Core adds `addCanvasVariant` (duplicate a variant with new ids and property values; new property names are added to every variant; duplicate combinations are refused; laid out next to the source or by the set's auto layout), `removeCanvasVariant` (refuses the last variant; instances switch to the closest variant, keeping overrides), `setCanvasVariantProperties`, `renameCanvasVariantProperty`, `renameCanvasVariantValue` and `getNextVariantValues`. The components controller gains undoable `addVariant`, `removeVariant`, `setVariantProperties`, `renameVariantProperty` and `renameVariantValue` with `can…` reasons, registered as `canvas.*` commands and agent tools (`add_variant`, `remove_variant`, `set_variant_properties`, `rename_variant_property`, `rename_variant_value`). React and Svelte `CanvasComponentsPanel` take an optional `components` (and `onError` / `onerror`) to show "+ Variant" on sets, inline property / value renames, and a per-variant menu (also on right click) to edit, duplicate or remove a variant.
- 40d8cb2: Spreadsheet defined names now survive the single-document save path. Apps that only save the document passed to `onDocumentChange` (including through `useSpreadsheetEditor` and `createReactiveSpreadsheet`) lost every defined name on reload. Each sheet document now has an optional `names` array: all the workbook-scoped names plus that sheet's own sheet-scoped names. The controller updates it on every change, including define, rename, delete, undo and redo.

  `new SpreadsheetController({ document })`, `loadDocument` and `addSheet({ document })` read these names back. Any `sheetId` in a document's names means "this sheet". When a workbook is loaded, `workbook.names` wins over the same names repeated in `sheets[*].names`, and names found only in sheet documents are added (the first sheet wins). `getWorkbook()` is unchanged: names stay in `names` only. Saved documents and workbooks without these fields load as before. `new SpreadsheetController({ workbook })` no longer changes the `id`, `name` or `names` of the sheet objects passed in.

### Patch Changes

- 40d8cb2: Pasting or importing a table while the cursor is in a table cell no longer creates a nested table. A pasted table on its own (HTML, markdown or the rich clipboard) fills the cells from the cursor, growing the table when needed; pasted content that has a table among other blocks, and imported DOCX / PDF / HTML files with tables, are inserted after the outermost table. A guard moves any table another edit puts into a cell (e.g. `insertContent`) after the table. Tracked changes still record the insertions. Documents that already contain nested tables load unchanged. New exports: `handleTablePasteWithoutNesting`, `insertSliceAfterTable`, `unnestTables`, `createTableNestingPlugin`, `ALLOW_NESTED_TABLES_META`, `sliceContainsTable`, `isInTableCell`, `outermostTableDepth`.
- 40d8cb2: Spreadsheet sort and transpose now move conditional formats and data validations with the cells, as Excel does: rule parts covering only some of the sorted rows follow their rows (formulas re-anchored), rule parts spanning every sorted row stay with the column, and transposing transposes rule ranges and their formula references. Both are part of the sort/transpose undo step. Adds `sortRuleRanges`, `transposeRuleRanges`, `mergeRuleRanges`, `sortRules`, `transposeRules`, `reanchorRuleFormula`, `transposeRuleFormula`, `mapConditionalFormatFormulas`, `mapDataValidationFormulas` and `transposeFormulaReferences`.

## 0.26.1

### Patch Changes

- 41b2435: Make `preprocessMarkdownMentions` (and so markdown import) linear on malformed input. It split content with `MARKDOWN_MENTION_SPLIT_REGEX`, which is cubic on unclosed mention spans (4,000 repetitions of `<span data-type='mention' ` took 219 s) and quadratic on unclosed fences, `<pre>`/`<code>` and tags. It now uses the new `splitMarkdownMentionParts`, a single forward scan that returns the same parts. One deliberate difference: a quoted `class`/`data-mention` value can no longer run past the tag's first `>`.

## 0.26.0

### Minor Changes

- 723b347: Add Figma-style components and instances to the canvas. `@pixerate/editor/canvas` turns a frame (or a wrapped selection) into a main component (`data.component`), places instances (`data.instance`) whose layers are real nodes copied from the main with stable source ids (`data.componentSource`), records edits inside instances as per-layer overrides (`data.componentOverrides`: text, fills, styles, visibility, auto layout padding / gap, token bindings, …) and rebuilds every instance when its main changes, keeping overrides and layer ids (`syncCanvasComponents(before, after)`). Component sets hold variants (`combineCanvasComponentsAsVariants`; switching variants keeps overrides the variants agreed on), and component properties drive layers (boolean → visibility, text → a `data` field, instance swap → a nested instance's main). Also: nested instances, swap, detach (keeps the look), reset overrides (all, per layer or per group), push overrides to the main, a "missing main" state when a main is deleted with `restoreCanvasMainComponent`, cycle prevention, deleting a layer inside an instance hides it, token bindings and per-instance modes inside instances, and links that survive JSON, copy / paste and duplication. `createCanvasComponentsController` makes each action one undoable step with `can…` checks giving disabled reasons; `createComponentCommands` (`@pixerate/editor/commands`) and `createCanvasComponentToolProvider` (`@pixerate/editor/agent`) expose them to the palette and agents. React adds `useCanvasComponents`, `<CanvasComponentsPanel>` and `<CanvasInstanceInspector>`; Svelte adds `createCanvasComponents`, `<CanvasComponentsPanel>` and `<CanvasInstanceInspector>`. Portions ported from FigCraft (MIT OR Apache-2.0).
- 723b347: Add keyframe animation for canvas nodes. `@pixerate/editor/canvas` stores per-property tracks in `node.data.animation` (so they copy, paste and duplicate with the node) for x, y, width, height, rotation, scale, opacity, fill, stroke, stroke width, corner radius and a motion path. Keyframes use hold, linear, CSS `cubic-bezier` presets or springs; colours interpolate in OKLab with premultiplied alpha; unsorted and duplicate keyframe times are handled. `evaluateAnimation` / `applyAnimation` return evaluated copies without touching the source and compose with `resolveCanvasTokens`. Editing helpers (`setKeyframe`, `updateKeyframe`, `deleteKeyframes`, `setKeyframeEasing`, `setTrackEnabled`, `moveKeyframes`, `scaleKeyframes`, `snapKeyframeDelta`, `copyKeyframes` / `pasteKeyframes`, `recordAnimationChanges`, `animateNode`) never apply partial edits. `AnimationPlayer` plays on an injected `Clock` with loop, ping-pong and playback rate. Export covers `sampleAnimationFrames`, CSS `@keyframes` (`exportCssAnimation`) and Web Animations (`toWebAnimations`). `createCanvasAnimationController` adds record mode, undoable edits and keyframe drags with snapping. `@pixerate/editor/commands` adds `createCanvasAnimationCommands`, which agents can also call as tools (for example `canvas.animation.animateNode`). React adds `useCanvasAnimation` and `<AnimationTimeline>`. Svelte adds `createCanvasAnimation` and `<AnimationTimeline>`. Portions ported from FilmCraft (MIT OR Apache-2.0).
- 723b347: Word (.docx) export and review import.

  - Core: new `@pixerate/editor/export` subpath (also re-exported from the root): `exportDocx(editorOrJSON, { styles, comments, author, privacy, title, remoteImages })` writes a dependency-free `.docx` with paragraph styles (`styles.xml` with `basedOn` / `next` / `link`), formatting, links, bullet / ordered / task lists, block quotes, code blocks, embedded images, tables (`gridSpan` / `vMerge` / header rows), tracked insertions, deletions, moves, formatting and block changes with authors and dates, and comments with replies and resolved state; returns a report of anything dropped. `privacy: "strip-authors"` anonymises names. Also `exportDocxBlob`, `createDocxParts`, `DocxExportController`, `downloadBlob`, `writeZip`.
  - Core: the DOCX importer reads comments (replies, resolved, author ids from `people.xml`) into `DocumentImport.comments` with `data-comment-id` ranges, tracked changes as review marks with `trackedChanges: "marks"`, and `styles.xml` into `DocumentImport.styles` (a style registry) with `data-style` on styled paragraphs; `Block Text` paragraphs become block quotes and `Code` paragraphs code blocks. `applyImportedReviewData` loads comments and styles into an editor (`importFilesIntoEditor` does it automatically). The HTML sanitizer now keeps `<ins>`.
  - React: `useDocxExport` and `ExportDocxButton`. Svelte: `createDocxExport` and `ExportDocxButton`.

- 723b347: Tables in the rich-text editor.

  - **Behaviour change:** `createRichTextPreset` now includes tables by default (TipTap's `table`, `tableRow`, `tableHeader`, `tableCell` nodes): resizable columns, header rows/columns/cells, `colspan` / `rowspan` (kept from pasted HTML and from DOCX and PDF import, which were previously flattened into paragraphs), cell `align` and `backgroundColor`, and table node selection. Pass `table: false` to keep the old flattening, or `table: { … }` to configure them. `createRichTextToolProvider` now also lists an `edit_table` tool when the schema has tables.
  - New table API: `TABLE_ACTIONS`, `getTableActionState` (with reasons such as "Place the cursor in a table first."), `runTableAction`, `getTableState`, `createTableStore`, `createTableCommands` (command registry: `table.insertTable`, `table.addRowAfter`, `table.mergeCells`, `table.toggleHeaderRow`, `table.goToNextCell`, `table.setCellAlignment`, …), `DEFAULT_TABLE_TOOLBAR`, `shouldShowTableBubbleMenu`, `createTableExtensions`.
  - Export: plain text writes table rows as lines of tab-separated cells; markdown writes GFM pipe tables (header alignment, escaped `|`) when representable and HTML otherwise; GFM tables in markdown import as tables. The HTML sanitizer now allows `colgroup`, `col` and `colwidth`.
  - Track changes: inserted and deleted rows, columns and tables are tracked as whole-block changes (reject removes inserted ones, accept removes deleted ones); header toggles are tracked block changes; merging/splitting cells is disabled while tracking. Whole-block changes inside tables are described as "Inserted 2 table cells".
  - React: `TableToolbar`, `TableBubbleMenu`, `InsertTableGrid`, `useTableMenu`. Svelte: `TableToolbar`, `TableBubbleMenu`, `InsertTableGrid`, `createTableMenu`.

- 723b347: Faster recalculation for formulas over ranges, and virtualised rendering of large sheets.

  - **Range-aware dependency graph** (`@pixerate/editor`): ranges are stored whole in an interval index (per column, plus a per-sheet index for ranges wider than 64 columns) instead of one key per cell, so `=SUM(A1:A50000)` and `=SUM(A:A)` are one entry each and an edit finds its dependents in O(log n + k). Only the dirty subgraph is recalculated, in topological order, with cycles, spills, cross-sheet / 3-D / defined-name references and LAMBDA unchanged. New: `IntervalIndex`, `extractReferenceDependencies`, `rangeDependencyKey`, `DependencyGraph.dependsOn` / `setVolatile` / `getVolatileKeys` / `detachSpilledCell` / `getIndexStats`, `getEvaluationPlan(keys, { includeVolatile })`, and `SpreadsheetController.getRecalculationStats()` (formulas evaluated by the last recalculation). `DependencyGraph.getDependencies` now returns range keys (`A1:A3`, `A:`) rather than every cell of a range.
  - **Volatile functions** (`NOW`, `TODAY`, `RAND`, `RANDBETWEEN`, `RANDARRAY`, also through defined names) now recalculate on every edit, as in Excel.
  - **Bulk loads**: CSV import, `importRows`, paste and autofill register formulas once and recalculate in one plan (one full evaluation when the grid grows); row and column lookups by id no longer scan the sheet, so a 50k-row CSV import goes from ~23 s to ~0.5 s.
  - **Single-cell edits** are undone from a record of that cell instead of a whole-sheet snapshot (an edit on a 50k-cell sheet: ~25 ms → ~0.2 ms).
  - **Evaluation fast paths**: `SUM`, `PRODUCT`, `AVERAGE`, `COUNT`, `COUNTA`, `MIN` and `MAX` read range arguments without materialising blank cells (`EvaluationContext.resolveRange` gets an optional `{ skipBlanks }` hint), large ranges read by several formulas are resolved once per recalculation, and formulas are parsed once for registration and evaluation.
  - **Fixes**: a blocked dynamic array no longer becomes `#CYCLE!` through its blockers, and stale spill edges no longer cause false cycles after re-entering an anchor or typing into a spilled cell.
  - **Virtualised rendering**: new core helpers `measureSpreadsheetView`, `getSpreadsheetViewWindow`, `getSpreadsheetScrollToCell` and `shouldVirtualizeSpreadsheet`. React (`useSpreadsheetViewport`) and Svelte (`createSpreadsheetViewport`) `SpreadsheetEditor`s render only the visible rows and columns plus overscan for sheets over 200 rows or 60 columns (`virtualize` prop: `'auto'` | `true` | `false`), keeping frozen panes, merged cells, row groups, conditional formats, selection, column resizing and keyboard navigation (the active cell scrolls into view). Smaller sheets render as before. `SpreadsheetGroupRow` accepts `labelColumns`, `leadingColumns`, `leftSpace` and `rightSpace` for windowed columns.

## 0.25.0

### Minor Changes

- c96cabb: Add curve-preserving path operations for the canvas. A new Bézier path engine (`pathBoolean`, `unitePaths`, `intersectPaths`, `subtractPaths`, `excludePaths`, `dividePaths`, `normalizeBezierPath`) intersects curves directly (subdivision with Newton polishing, tangencies, coincident edges and T-junctions resolved; nonzero / evenodd fill rules) and rebuilds results from exact sub-curves of the inputs, falling back to the polygon engine (reported as `engine` / `fallbackReason`) only when it cannot resolve the input. Adds `offsetPath` (inset / outset with miter, round or bevel joins and loop removal), `outlineStroke` (SVG joins, caps, miter limit and dashes to a clean filled path) and arc-length / area / hit-test utilities (`bezierPathLength`, `bezierPathPointAtLength`, `bezierPathArea`, `pointInBezierPath`, …).

  Behaviour change: `combineShapeNodes` (and the arrange controller's Unite / Intersect / Subtract / Exclude / Divide) now use the curve engine by default, so results keep exact arcs and straight sides instead of fitted polylines; pass `engine: 'polygon'` (or `curves: 'lines'`) for the previous behaviour. Results also report `engine`.

  New undoable shape commands: `arrange.offsetShapes(distance, ids?, options?)` and `arrange.outlineStroke(ids?, options?)` (with `canOffsetShapes` / `canOutlineStroke`) in core, `useCanvasArrange` (React) and `createCanvasArrange` (Svelte); pure `offsetShapeNodes`, `outlineShapeNodeStrokes` and `applyShapeReplacement`; and `createShapeCommands` for the command palette / context menus. Portions ported from VectorCraft (MIT OR Apache-2.0).

- c96cabb: Add design tokens (Figma-style variables) with modes such as light / dark. The new dependency-free `@pixerate/editor/tokens` subpath has collections, modes (default, add / duplicate / reorder / remove), typed colour / number / string / boolean variables with per-mode values, aliases across collections with cycle and type checks, scopes for pickers, `resolveToken` with diagnostics, an undoable `TokenStore` with change events and transactions, W3C Design Tokens JSON import / export (merging by name, keeping ids, modes in `$extensions`) and CSS custom properties per mode (`exportTokensCss`, `getTokenCssVariables`). Deleting a variable or collection detaches aliases to their values. `@pixerate/editor/canvas` binds node properties (fill, stroke, stroke width, opacity, corner radius, auto layout gap and padding, text colour and size, visibility) to variables via `data.tokenBindings`, with an explicit mode per frame or group (`data.tokenModes`) inherited by descendants; bound values are written into the nodes (`resolveCanvasTokens`), survive copy / paste and duplication, and `detachTokenBindings` keeps the last value when a variable is deleted. React adds the `./tokens` subpath (`useTokens`, `useTokenStore`, `<TokensPanel>`) and `useCanvasTokens`, `<TokenBindingPicker>` and `<TokenModeSwitcher>` in `./canvas`; Svelte adds the same (`createTokens`, `<TokensPanel>`, `createCanvasTokens`, `<TokenBindingPicker>`, `<TokenModeSwitcher>`). Portions ported from FigCraft (MIT OR Apache-2.0).
- c96cabb: Image editor selections and masks. Core (`@pixerate/editor/image-editor`): 8-bit `SelectionMask` selections with magic wand (scanline fill, RGB or perceptual tolerance, contiguous / global, sample merged), colour / tone / hue range, rectangle / ellipse / lasso, replace / add / subtract / intersect, grow / shrink (exact distance transform), feather, border, smooth, invert, and guided-filter Refine Edge (radius, smart radius, smooth, feather, contrast, shift edge) for snapping coarse AI masks to image edges. Selections are undoable, saved run-length encoded as an optional `selection` key, shown as marching ants or a Quick Mask tint, and included in `toMaskDataURL()`. Adjustment layers get an optional `mask` with non-destructive density and feather (`applySelectionAsLayerMask`, `selectionFromLayerMask`), resampled through crop / rotation / flips. Selection- and mask-free documents serialize exactly as before. New agent tools: `get_selection`, `select_region`, `select_by_color`, `modify_selection`, `refine_selection`, `apply_selection_as_mask`. React and Svelte: `SelectionOptionsBar`, `RefineEdgePanel` and a Select & Mask tab in `ImageEditor`.
- c96cabb: PDF import now recovers document structure from the page layout. The new pure `analyzePdfLayout` reads multi-column pages in column order, removes running headers, footers and page numbers, re-joins hyphenated words, and detects headings (levels from font-size and weight clusters against the body size), bulleted and numbered lists (nesting by indent, ordered `start`), and tables from ruling lines (with spanning cells) or aligned column gaps (spanning header/totals rows, header rows from bold or labels over numbers). `createPdfImportAdapter` uses it by default, reads ruling lines and font weights from pdf.js, and returns a `structure` report (counts, confidences, detected items); `structure: false` (at creation or per import via the new `adapterOptions: { pdf: { structure: false } }` on `importFile`, `importFilesIntoEditor`, the file-import controller and the `FileImport` extension) restores the plain paragraph import. New helpers: `pdfLayoutBlocksToHtml`, `pdfTextItemsToRuns`, `pdfOperatorListToRules`, `summarizeImportStructure`. React's `useFileImport` and Svelte's `createFileImport` expose `structureSummary`.
- c96cabb: Generation records and Recreate, and asset mentions with roles.

  - Core (`/generation`): `createGenerationRecord` (built on provenance, plus template/capability/prompt hashes, original settings, seed, assets with roles and content hashes, lineage). `recreateRequest(record, { templates, capabilities, assets, mode: "exact" | "latest" })` returns the re-planned request and a drift report (template changed/deleted, model missing/changed, setting unsupported/changed, asset missing/changed). Also adds `variationRequest`, `createGenerationRecordStore` on the persistence storage adapters (filter by model/template/asset/role, prune, subscribe), and `hashText` / `hashCapabilities`. `recreateRequest(provenance)` keeps its old behaviour.
  - Roles are extensible: models may declare custom roles. Each role can list accepted media (`accepts`). Aliases such as `style` and `start-frame` map to built-in roles. `planGenerationRequest` accepts `mentions` and validates them per role. `validateAssetMentions`, `describeAssetMentions` and `getAssetRoleOptions` are new. Agent schemas list custom roles and `mediaType`.
  - Mentions: opt-in `@handle:role` text syntax (`extractMentions(text, { details: true, roles: true })`, `preprocessMarkdownMentions(…, { roles })`). `findTextMentions` and `setMentionRoleInText` are new. The Mention node has an `assetRole` attribute (`data-role`), with `setMentionRoleAt` / `getMentionNodes`. `htmlToPlainText` writes `@label:role`. Output without roles is unchanged.
  - React and Svelte: `<AssetMentionChips>` (role badges, role picker popover), `<GenerationHistory>` (drift report, Recreate exact/latest, Variation), `useGenerationRecords` / `createGenerationRecords`.

- c96cabb: Add spreadsheet conditional formatting and data validation (ported from GridCraft).

  Conditional formatting (`@pixerate/editor/spreadsheet`): cell value comparisons (with formula operands), formula rules with relative references (`=$A1>10` formats whole rows), text contains / not contains / begins / ends with, blanks, errors, duplicates / unique, top / bottom N and N%, above / below average (with standard deviations), dates occurring, 2- and 3-colour scales and data bars (min / max / number / percent / percentile / formula anchors), and icon sets (12 sets, file or default thresholds, reversed, value hidden). Rules apply in priority order with stop if true. `evaluateConditionalFormats(sheet, rules)` returns a per-cell overlay (fill, font colour, bold / italic / underline / strikethrough, data-bar fraction and colour, icon); `ConditionalFormatEngine.update` re-evaluates only affected cells after edits. The controller stores rules in `document.table.conditionalFormats` and adds undoable `addConditionalFormat`, `updateConditionalFormat`, `deleteConditionalFormat`, `moveConditionalFormat`, `clearConditionalFormats`, plus `getConditionalFormatOverlay` / `getConditionalFormat`. Rule ranges and rule formulas follow inserted and deleted rows and columns.

  Data validation: whole number, decimal, list (literal or from a range), date, time, text length and custom formula rules, with ignore blank, input messages and stop / warning / information alerts (`document.table.dataValidations`, undoable `addDataValidation`, `updateDataValidation`, `deleteDataValidation`, `clearDataValidation`). `commitEditing()` now validates and returns a `SpreadsheetCommitResult`: invalid input keeps the editor open and sets `validationPrompt`, answered with `resolveValidationPrompt('accept' | 'retry' | 'cancel')`. New `commitCellInput` validates formula-bar and dropdown input; `setCellValue`, paste and import do not validate. Also `validateCellInput`, `getValidationListValues`, `findInvalidCells` and "circle invalid data" (`setInvalidDataCircles`, `isInvalidDataCircled`).

  React and Svelte grids render fills, font styles, data bars, icons and invalid-data circles, show a dropdown arrow on list-validated cells (also Alt+Down), the input message, and validation alert dialogs. The context menu gains conditional formatting and data validation items, including compact "Conditional formatting…" and "Data validation…" managers (`SpreadsheetConditionalFormatPanel`, `SpreadsheetDataValidationPanel`, `SpreadsheetValidationDialog`; menu items with `panel` are opened through the context menu's `onOpenPanel`).

- c96cabb: Spreadsheet LAMBDA functions, defined names and multiple sheets (ported from GridCraft's calc engine and workbook model).

  **LAMBDA.** `LAMBDA(params…, body)` creates function values with lexical scoping (closures keep their LET variables). Call them inline (`=LAMBDA(x, x+1)(2)`), through LET (`=LET(f, LAMBDA(x, x*2), f(3))`) or a defined name (`=Double(4)`, recursion included), or pass them, or a built-in by name, to `MAP`, `REDUCE`, `SCAN`, `BYROW`, `BYCOL` and `MAKEARRAY`. `ISOMITTED` checks for left-out arguments (`f(1,)`); empty arguments now parse everywhere. Wrong argument counts are `#VALUE!`, an uncalled lambda in a cell is `#CALC!`, and recursion deeper than `MAX_LAMBDA_DEPTH` (1000) is `#NUM!`. New exports `FormulaLambda`, `isFormulaLambda`; `EvaluationContext` gains `resolveName` and `resolveSheetSpan`, and its resolvers receive an optional sheet name.

  **Defined names.** `defineName(name, refersTo, { sheet?, comment? })` for workbook- or sheet-scoped ranges, constants, formulas and lambdas; `renameName` rewrites the formulas (and other names) that use it; `deleteName` leaves `#NAME?`. Names are validated like Excel (`validateDefinedName`: not cell- or R1C1-like). Formulas depend on the cells a name refers to, so edits recalculate them; `getNames`, `getName`, `getNameSuggestions` and `evaluateFormula(formula, { sheet })`. Formula autocomplete suggests names (`getFormulaHints(input, caret, { names })`, `<FormulaHints names>`).

  **Sheets.** A `SpreadsheetController` is now a workbook (a single-sheet controller works exactly as before; `document` is the active sheet): `addSheet`, `renameSheet`, `moveSheet`, `deleteSheet` (not the last), `duplicateSheet` (with its sheet-scoped names), `setActiveSheet`, `getSheets`, `getWorkbook`/`loadWorkbook` and the `workbook`, `onWorkbookChange` and `onActiveSheetChange` options. Formulas reference other sheets (`Sheet2!A1`, `'My Sheet'!A1:B2`, `Data!A1#`, `Data!Rate`) and 3-D ranges (`SUM(Sheet1:Sheet3!A1)`). Renaming a sheet rewrites references to it, deleting one turns them into `#REF!` (3-D spans shrink), and inserting/deleting rows or columns, sorting and transposing rewrite references from other sheets too. Undo snapshots the changed sheet (undoing switches to it) or, for sheet and name operations, the whole workbook. CSV/row imports take a `sheet` option. New helpers: `validateSheetName`, `quoteSheetName`, `renameSheetInFormula`, `deleteSheetInFormula`, `renameNameInFormula`, `getSheetTabMenuItems`, `getNameManagerRows`; `shiftFormulaReferences` / `remapFormulaReferences` accept a sheet filter, and menu items can ask to `confirm`.

  **React and Svelte.** `<SheetTabs>` (click to switch, double-click to rename, drag to reorder, context menu with insert/rename/duplicate/move/delete-with-confirm, `+` to add), `<NameManager>` (list with values, add/edit/rename/delete), `showSheetTabs` on `<SpreadsheetEditor>`, and `sheets`, `activeSheetId`, `names` plus the sheet and name actions on `useSpreadsheetEditor` / `createReactiveSpreadsheet`.

- c96cabb: Tracked moves and paragraph styles.

  - **Tracked moves** (`TrackChanges`): with tracking on, a cut followed by a paste of the same text, or a drag within the document, of at least a sentence (`isMoveSized`; configurable with the `isMove` and `trackMoves` options) is recorded as one move. Both ends are `insertion`/`deletion` marks sharing a `moveId` (`data-move-id`) and styled with a green double strike/underline (`moveHTMLAttributes`). `getTrackedChanges` lists a move once (`type: "move"` with `move.from`/`move.to`); new `acceptMove(id)`/`rejectMove(id)` commands (and `acceptChange`/`rejectChange`/accept-all) remove the source or the destination, taking an emptied top-level paragraph with it. New `selectChange(id)` command and `trackedChangeLabel` helper. `getEditorText` resolves moved paragraphs without leaving empty lines. Block changes of a paragraph style read "Changed style to …".
  - **`compareDocuments({ detectMoves: true })`** records a uniquely identical top-level paragraph deleted in one place and inserted elsewhere as a move; the summary has a new `moves` count.
  - **Paragraph styles**: `createStyleRegistry` / `StyleRegistry` with built-in Normal, Title, Subtitle, Heading 1–6, Quote, Code and List Paragraph styles (plus linked and Emphasis/Strong character styles), `basedOn` chains (cycle-safe), `next` styles, document defaults, cascade resolution, user styles, JSON round-trip and a scoped stylesheet (`toCSS`). The `ParagraphStyles` extension (`paragraphStyles` preset option) adds a `styleId` attribute (`data-style`) to paragraphs, headings and code blocks, a `characterStyle` mark, `setParagraphStyle`, `clearParagraphStyle`, `setCharacterStyle`, `unsetCharacterStyle`, `updateParagraphStyleFromSelection` and `createParagraphStyleFromSelection` commands, next-style on Enter and CSS injection. Headings without a `styleId` map to Heading N, so existing documents are unchanged.
  - **React**: `StylesGallery` (dropdown or gallery, update/new style from selection) and `useParagraphStyles`; `TrackedChangesList`; `useTrackChanges` gains `select`, `acceptMove` and `rejectMove`.
  - **Svelte**: `StylesGallery` and `createParagraphStyles`; `TrackedChangesList`; `createTrackChanges` gains `select`, `acceptMove` and `rejectMove`.

### Patch Changes

- c96cabb: Ship TipTap command typings with the rich-text preset. The preset installs StarterKit, Underline, TextAlign, Highlight, Color, TextStyle, Link, Image and TaskList, but the published declarations never referenced those packages, so `editor.chain().toggleBold()`, `toggleHeading()`, `setTextAlign()` and similar were type errors in apps that use the preset without depending on the extension packages directly. The declarations now import them (through the exported `RichTextPresetCommandPackages` type), so their `Commands` augmentations apply.

## 0.24.0

### Minor Changes

- fd0c687: Add autosave, crash recovery and document migration (`@pixerate/editor/persistence`).

  - Core: `createAutosaveController` (debounced crash-recovery snapshots with a hydration gate, exponential retry, `flushNow` for `pagehide`, `checkRecovery` / `discardRecovery`, and `markClean` that only retires a snapshot this session wrote), the pure `createRecoveryPolicy` state machine, `createRevisionTracker` (revisions from a `HistoryManager` and `bindDirtyToHistory`), storage adapters (`createMemoryStorage`, `createLocalStorageAdapter`, `createIndexedDbAdapter`, `createOpfsAdapter` with temp-file rename or pointer-swap writes, all feature-detected and with injectable failures), and `migrateDocument` / `loadSections` / `loadDocument` with a `LoadReport` (step-wise migration, per-section fallback, read-only newer versions, unknown keys preserved).
  - Core: `loadImageEditorDocument` in `@pixerate/editor/image-editor` loads `SerializedImageEditorState` with a `LoadReport`; valid state is returned unchanged.
  - React: `useAutosave` and `<RecoveryPrompt>` (`@pixerate/editor-react/persistence`).
  - Svelte: `createAutosave` and `<RecoveryPrompt>` (`@pixerate/editor-svelte/persistence`).

- fd0c687: Add Figma-style auto layout and constraints for canvas sub-flows. Frames are nodes with `data.layout` (horizontal, vertical or grid; gap, padding, wrap, main / cross / content alignment including space-between and baseline, hug / fill / fixed sizing, min / max, `fr` grid tracks with spans and anchors); children take `data.childLayout` (sizing, limits, absolute positioning and constraints). Core adds the pure `layoutFrame`, `layoutAll`, `layoutUp`, `applyConstraints`, `makeSizingCoherent`, `getAutoLayoutGrid`, `getAutoLayoutInsertTarget` and `moveLayoutChild`, plus `createCanvasAutoLayoutController`, which relayouts frames after nodes are added, removed, resized or reordered (one undo step with the triggering action) and reorders children dragged within their frame. React gets `useCanvasAutoLayout`, Svelte `createCanvasAutoLayout`, and the arrange controller an `autoLayout` option. Portions ported from FigCraft (MIT OR Apache-2.0).
- fd0c687: Compare two documents into tracked changes.

  - `@pixerate/editor` (also `@pixerate/editor/compare`): `diffSequences` / `diffChanges` (Myers diff with common prefix/suffix stripping and patience anchors for long inputs), `compareDocuments(original, revised, options)` returning the revised document with the differences as `insertion` / `deletion` / `formatChange` marks and `blockChange` records plus a summary (`insertions`, `deletions`, `formatChanges`, `blockChanges`, `notHonoured`), and `compareHtml`. Options: `granularity: "word" | "char"`, `ignoreCase`, `ignoreWhitespace`, `formatting`, `author`, `date`. Accepting all changes yields the revised document, rejecting all the original.
  - New `DocumentCompare` extension (added by the rich-text preset with `trackChanges`) with the `setContentFromComparison(original, revised)` command, and `applyDocumentComparison(editor, …)` / `compareInEditor`; the content is set without being tracked.
  - Track changes: `blockChange` records can carry `operation: "insert" | "delete"` for wholly inserted/deleted blocks (accepting a deletion or rejecting an insertion removes the block and emptied containers). They render with `data-block-operation` and the new `blockInsertedClass` / `blockDeletedClass` options, and are described as "Inserted Paragraph" / "Deleted 2 blocks". Exports (`getEditorText`, Markdown, `resolveTrackedChanges`) resolve them like inline changes.
  - React: `useDocumentCompare(editor)`; Svelte: `createDocumentCompare(editor)`.

- fd0c687: Add an Excel number-format engine (ported from GridCraft's numfmt): `NumberFormat.parse` never throws and supports up to four sections, `[>=100]` conditions, `[Red]`/`[ColorN]` colours, `,` scaling, `%`, scientific `E+`, `?` padding, fractions (`# ??/??`), `_x` spacing, `*x` fill, elapsed `[h]`/`[m]`/`[s]`, the `@` text section, date/time tokens and Excel's 15-significant-digit rounding (`2.675` → `2.68`); codes over 255 characters display as General. Also `formatNumberFormatValue`, `formatTextFunction`, `formatGeneralFit`, `builtinNumberFormat`/`builtinNumberFormatId` (ids 0–49), `numberFormatColorToCss`, `NUMBER_FORMAT_PRESETS` and `CellFormat` ↔ code mapping helpers.

  `TEXT()` now uses the engine (text that is neither a number nor a date is returned unchanged, as in Excel, instead of `#VALUE!`). `formatCellForDisplay(cell)` returns the text, colour and whether the value is numeric; `formatCellDisplay` uses it, and numbers in cells with a `currency` / `percentage` / `date` `CellFormat` but no code use that kind's code. New `SpreadsheetColumn.numberFormat`, `CellData.explicitNumberFormat`, and undoable `setCellNumberFormat(range, code)` / `setColumnNumberFormat(colId, code)` on the controller (also on the React and Svelte spreadsheet state). Context menu items can be `checked` and ask for `input` (`runSpreadsheetMenuItem`).

  React and Svelte grids render formatted values right-aligned for numbers with `[Red]`-style colours, and the table context menu gains "Format cells" presets (General, Number, Currency, Percent, Date, Time) and a Custom… code prompt.

- fd0c687: Add `@pixerate/editor/generation`: declarative model capability descriptors (media kind, prompt limits counted on resolved text, negative/system prompts, aspect ratios, resolutions, quality, output count, durations, seeds, reference inputs by role with per-role and total limits, edit/inpaint modes, extra numeric/enum/boolean params, timing). `planGenerationRequest(request, caps, { strategy })` snaps, clamps, truncates and drops unsupported values with a report of every adjustment and error (`error`, `nearest`, `downgrade`, `upgrade` strategies). `capabilitiesToJsonSchema`, `mergeCapabilities`, and `createGenerationToolProvider` add `list_models`, `plan_generation`, `estimate_generation` and an idempotent `generate` (deduplicated by `idempotencyKey`) to a `ToolRegistry`. `createProvenance` / `serializeProvenance` / `parseProvenance` / `recreateRequest` record pinned template versions, values, the resolved prompt and source map, and the planned settings. Also adds `createBatchResolver`, `estimateJobProgress`, `expectedDurationFor`, and headless form helpers (`getGenerationControls`, `getReferenceSlots`).

  React (`@pixerate/editor-react/generation`): `useGenerationPlan`, `<GenerationSettings>`, `<JobProgress>` and `useJobProgress`. Svelte (`@pixerate/editor-svelte/generation`): `createGenerationPlan`, `<GenerationSettings>`, `<JobProgress>` and `createJobProgress`.

- fd0c687: Image editor: non-destructive adjustment layers, Photoshop blend modes, a histogram, a control table and agent tools.

  - **Adjustment layers**: `ImageAdjustments.layers?: AdjustmentLayer[]` (`{ id, kind, params, enabled, opacity, blend, name? }`), evaluated bottom to top after the base adjustments (and before blur) on the encoded result, each blended over the layers below with its blend mode and opacity. Kinds: `curves` (master + R/G/B natural-spline curves), `levels` (per channel then master, Photoshop whole-level stretch and soft gamma toe), `hueSaturation` (master + six trapezoid hue ranges, colorize), `vibrance`, `colorBalance`, `blackWhite` (with tint), `photoFilter`, `invert`, `posterize`, `threshold`, matching Photoshop ground truth. Each layer is compiled once per parameter change (per-channel kinds into LUTs). Controller: `addAdjustmentLayer`, `updateAdjustmentLayer` (with `commitToHistory = false` for drags), `removeAdjustmentLayer`, `moveAdjustmentLayer`, `toggleAdjustmentLayer`, `clearAdjustmentLayers`, `getAdjustmentLayers`, all undoable. States with layers serialize as schema `version: 2`; states without layers still serialize as version 1, byte for byte, and render exactly as before. `migrateSerializedImageEditorState` normalises stored states. `resetAdjustments()` now keeps adjustment layers (it resets the sliders).
  - **Blend modes** (`BLEND_MODES`, `blendChannel`, `blendRgb`, `blendPixel`, `blendImageData`, `canvasCompositeOperation`): all 26 Photoshop modes including Photoshop soft light, vivid / linear / pin light, hard mix, subtract, divide, darker / lighter colour and hue / saturation / color / luminosity with a hardened ClipColor, composited with the W3C formula. Annotations accept an optional `blend`: drawn with `globalCompositeOperation` where the canvas matches, with a scalar fallback otherwise.
  - **Histogram**: `computeHistogram(imageData)` (R, G, B and luminance bins, clipping counts, transparent pixels excluded), `histogramPath`, and `controller.getHistogram()` / `subscribeHistogram()` for the rendered preview after adjustments.
  - **Control table**: `IMAGE_ADJUSTMENT_CONTROLS` and `ADJUSTMENT_LAYER_CONTROLS` (`ControlSpec`: id, label, section, range, step, default, decimals, track), with `clampControlValue`, `formatControlValue`, `getControlPath` / `setControlPath`.
  - **Agent tools**: `createImageEditorToolProvider(controller)` for `ToolRegistry`: `get_adjustments`, `list_controls`, `set_adjustments {values, label}` (clamped, echoed, one undo step; base ids or `layers.<id>.<control>`), `add_adjustment_layer`, `render_preview {maxSide}`, with complete MCP annotations.
  - **React / Svelte**: `<Histogram>`, `<AdjustmentLayersPanel>` (add / reorder / show / remove layers, blend and opacity, curves editor with draggable points over the histogram, levels per channel, hue range selector, colour balance tones), `<CurvesEditor>` and `<ControlSlider>`. The image editor's Adjustments tab renders its sliders from the control table and shows the histogram and the layers panel. `useImageEditor` and `createReactiveImageEditor` gain `histogram` and the layer methods.

- fd0c687: Mail merge on top of the prompt grammar.

  - **Comparison conditions**: `{?amount>100}…{/amount}`, `{?status=paid}…{/status}`, `{!tier<>"gold"}…{/tier}` with `= <> != < > <= >=`, compared numerically when both sides are numbers and as case-insensitive text otherwise. The section is closed by the bare variable name, so existing prompts (including `{?a>1}…{/a>1}`) resolve exactly as before. Malformed comparisons stay literal and are reported as `invalid-condition`. Tokens carry `comparison: { operator, operand }`; new helpers `compareConditionValues`, `parseComparison`, `conditionSubject`, `formatConditionalTag`, `describeConditionalTag`, `parseConditionExpression`, `evaluateConditionExpression`. `extractVariables` flags `usedInComparison`, and such variables are no longer `conditionOnly` form fields. `GradientText` decorates comparisons and flags malformed ones.
  - **Data sources**: `parseDataSource(text | rows | objects, { delimiter, hasHeader, format, maxRecords, maxFields })` reads CSV/TSV (delimiter auto-detect) and JSON into `{ fields, records, warnings }` with header normalisation, padding and caps. `matchFields(variables, fields)` maps variables to fields case-/space-insensitively and through aliases (`FirstName`/`First`/`GivenName`, …); `recordToValues` builds prompt values.
  - **Merging**: `mergeRecords(template, source, { mapping, skipIf, separator, maxOutputs, maxLength, from, to })` resolves one output per record with source maps, skips records with a condition or function, and reports diagnostics. `serializeMergeOutputs` writes text or JSON.
  - **React / Svelte**: `<MergePreview />` (paste or pick CSV/JSON, editable field mapping, Prev/Next record preview, Merge all with copy/download) plus `useMergePreview` / `createMergePreview`. `TemplateRenderer` shows comparison tags.

- fd0c687: Word-style Find and Replace for the rich-text editor.

  - New `FindReplace` extension (opt-in `createRichTextPreset({ findReplace: true })`): commands `setSearch`, `openFindReplace`, `closeFindReplace`, `findNext`, `findPrevious`, `replaceCurrent`, `replaceAll` (one undo step) and `clearSearch`; Mod+F / Mod+H open the find state, F3 / Mod+G step. Matches are decorated with `pixerate-find-match` and `pixerate-find-match-current`. `getFindReplaceState(editor)`, `getFindReplaceStore(editor)` (cached snapshots), `formatFindStatus`, `FIND_OPTION_TOGGLES`.
  - Options: match case, whole words, match prefix / suffix, ignore punctuation / white space, Word `^` special characters (`^p`, `^t`, `^l`, `^?`, `^#`, `^$`, `^w`, `^13`, `^u8212`, … and `^&` / `^c` in the replacement), Word wildcards (`?`, `*`, `[a-z]`, `[!x]`, `{n,m}`, `@`, `<`, `>`, groups with `\1`–`\9` in the replacement), a raw regex mode and a literal mode.
  - Patterns compile with `compileFindPattern` and run on a linear-time Pike VM, so no Find text can backtrack catastrophically; searches are bounded by a time budget and match cap (`truncated`). Invalid patterns return a structured `{ code, message }` error instead of throwing. Regex mode uses `RegExp` and rejects nested repetition.
  - Searching skips tracked-deleted text (matches never span a deletion; word boundaries see the live text), reads paragraphs together only when the pattern contains `^p`, and replacements made while Track Changes is on become tracked changes. A paragraph mark in the replacement splits the paragraph. `searchDocument(doc, query, options)` and `applyReplacements(tr, matches)` are exported for custom flows.
  - `createFindReplaceCommands(editor)` returns command-registry specs (`findReplace.open`, `.openReplace`, `.find`, `.next`, `.previous`, `.replaceAll`) for menus, the palette and agents.
  - React: `FindReplaceBar` and `useFindReplace(editor)`.
  - Svelte: `FindReplaceBar` and the `createFindReplace(editor)` rune.

### Patch Changes

- fd0c687: Fix catastrophic regex backtracking on malformed HTML in `extractMentions`, `htmlToPlainText` (Node fallback), `stripMarkdownCode` and tracked-change stripping. Inputs such as thousands of unclosed `<span data-type="mention"` tags could block for minutes; they are now processed in linear time with identical results for well-formed input.

## 0.23.0

### Minor Changes

- 5a37e61: Canvas distance measuring, resize / grid snapping and Bézier curve fitting.

  - **Measuring**: `measureBetween(a, b)` (inside, overlapping and separated boxes, labelled lines plus dashed extension lines), `measureToLine`, `measureSelection(nodes, selectedIds, hoveredId)` and `measureLabel`. `GuideLine` gains the `measure` / `extension` kinds and an optional `label`, which both `<CanvasGuidesLayer>`s draw (new `measureColor` prop). Alt-hover hooks: React `useCanvasMeasure`, Svelte `createCanvasMeasure`.
  - **Resize snapping**: `snapResize(rect, handle, targets, options)` keeps the opposite edge / corner fixed, snaps corner axes independently, rejects snaps that collapse or flip the box, and supports `keepAspectRatio`, `minWidth` / `minHeight`. The arrange controller adds `snapResizeChanges` (React Flow `dimensions` changes), `beginResize` / `resize` / `endResize`, and the Svelte rune adds `resizerHandlers(id)` for `<NodeResizer>`. Locked nodes are not resized.
  - **Grid snapping**: `snapToGrid` and the `gridSize` / `gridOrigin` guide options for drag and resize snapping.
  - **Curve fitting**: `fitCubics`, `fitPathData`, `fitFreehandPath` (Schneider-style with corner preservation). `polygonToSvgPath` takes `curves: 'fit'`, and `combineShapeNodes` now fits curves by default (`curves: 'lines'` restores straight segments), so booleans of curved shapes stay smooth.

- 5a37e61: Add one command system for shortcuts, a command palette and agent tools.

  - **Core (`@pixerate/editor/commands`, new subpath with no third-party imports)**:
    - `CommandRegistry`: commands have `enabled(ctx, params)` that returns `true` or a reason, JSON Schema `params` (unknown keys are rejected with a message naming the accepted ones), `undoable` (runs inside `history.batch`, so a failure rolls back its partial changes), and structured `execute` / `executeAsync` results. It also provides `list({ scope, enabledOnly })` and `subscribe` / `invalidate`.
    - `ShortcutMap`: platform-neutral chords (`Mod` is ⌘ on macOS and Ctrl elsewhere) matched on `event.code`, scoped bindings that win over global ones, a guard against firing in text inputs, user overrides, `findConflicts(platform)` and `formatShortcut`.
    - Palette helpers: `rankCommands`, `fuzzyMatch` and `pushRecent`, plus `createCommandPaletteController`.
    - `createCommandToolProvider`: exposes `list_commands`, `run_command` and `run_commands` (ordered, not atomic) to a `ToolRegistry`.
    - Built-in command helpers: `createHistoryCommands`, `createArrangeCommands` and `createSpreadsheetCommands`.
  - **Core (agent)**: every built-in agent tool (rich text, spreadsheet and the static editor tools) now has a `title` and the complete set of MCP annotation hints.
  - **Core (canvas)**: `matchArrangeShortcut` now uses `ShortcutMap`. Its exports are unchanged and `Mod` still matches ⌘ or Ctrl. Without Alt, a letter key that produces a different Latin letter (AZERTY, QWERTZ, Dvorak) now matches that letter instead of its physical position.
  - **React** (`@pixerate/editor-react/commands`, also exported from the root entry): adds `CommandPalette`, `useCommandPalette` (optional `hotkey`, e.g. `Mod+K`), `useCommandShortcuts` and `useRegisterCommands`.
  - **Svelte** (`@pixerate/editor-svelte/commands`, also exported from the root entry): adds `CommandPalette`, `createCommandPalette`, `createCommandShortcuts` and `useRegisterCommands`.
  - **History shortcuts**: `useHistoryShortcuts` and `createHistoryShortcuts` now use the shared history keymap and match `event.code`. Mod+Z, Mod+Shift+Z and Mod+Y (off macOS) work as before. Chords with extra modifiers, such as Mod+Alt+Z, no longer trigger undo.

- 5a37e61: History gestures, undo marks, memory budget, History-panel entries and dirty-vs-saved tracking.

  - `HistoryManager.executeMerged(cmd, { key })` folds consecutive merged executes with the same key into one undo step regardless of timing; any other recorded command, undo, redo, `revertTo`, `goTo`, `clear` or `endGesture()` ends the gesture. `beginGesture(key)` / `endGesture()` hold a gesture so every merged execute joins one step. Tag-only `executeMerged` keeps its 300 ms time window.
  - `mark()` / `revertTo(mark)` take back every step since the mark without leaving anything on the redo stack (Escape-cancel); a mark that has left the history is a no-op returning 0. `isMarkValid(mark)`.
  - `maxBytes` with a `sizeOf(command)` hook (or `command.byteSize`) drops the oldest steps beyond the budget but always keeps the newest; `getByteSize()`.
  - `getEntries()` (`{ id, label, index, current, undone }`) and `goTo(index)` for History panels; `getRevision()`.
  - `DirtyTracker` gains `normalize`, a revision-keyed `isDirty(value, revision)` cache, stateful `update` / `dirty` / `markClean` / `subscribe`, and re-entrant `suppress(fn)` (also `withoutDirty`). `bindDirtyToHistory` keeps it in step with a `HistoryManager`, so undoing back to the saved state is clean again. Also exported from `@pixerate/editor/history`.
  - `SpreadsheetController` caps its snapshot undo at `maxHistoryBytes` (default 64 MiB) in addition to 50 steps, and exposes `getHistoryByteSize()` / `getHistoryDepth()`.
  - React: `useHistory()` returns `entries`, `goTo`, `mark`, `revertTo`, `beginGesture`, `endGesture`; new `useHistoryDirty()`.
  - Svelte: `createHistory()` gains the same members; new `createHistoryDirty()` rune.

- 5a37e61: Image editor: proper white balance, LUT-based tone without intermediate clipping, and process versions. `ImageAdjustments` gains optional `tint` (−100 green … +100 magenta) and `process` (`1 | 2`). Process 2 (the default for new edits and Reset) decodes sRGB to linear float once, applies exposure and a Bradford white-balance matrix relative to "as shot" (`temperature` maps to Kelvin at one mired per unit around 6500 K; `tint` is Duv × 3000), then per-channel tone LUTs (highlight shoulder, contrast S-curve anchored at black / grey / white, brightness midtone lift), luminance-preserving saturation in linear light, and a LUT encode, clamping only at the end. Adjustments saved without `process` keep the frozen legacy rendering (`applyLegacyAdjustments`) and serialize exactly as before; `controller.upgradeProcess()` / `isProcessOutdated` (also on `useImageEditor` and `createReactiveImageEditor`) move an edit to the current process in one undo step. New `@pixerate/editor/image-editor` exports: `tempTintToXy`, `xyToTempTint`, `wbMatrix`, `whiteBalanceMatrix`, `whiteBalanceFromSample` (neutral-point eyedropper), `temperatureToKelvin`, `kelvinToTemperature`, `toneCurve`, `buildToneLut`, `normalizeProcessVersion`, `applyProcess2Adjustments` and friends. The React and Svelte image editors add a Tint slider and an "Update" notice for legacy edits. Note: `DEFAULT_ADJUSTMENTS` now carries `process: 2`, so `applyAdjustments(img, { ...DEFAULT_ADJUSTMENTS, … })` renders with process 2; pass `process: 1` for the old output.
- 5a37e61: Spreadsheet: typed cell input is now parsed into typed values, and comparisons follow Excel.

  - New `parseCellInput(raw)` (numbers with `$`, `%`, thousands separators, scientific notation, `(100)` negatives, fractions such as `1 1/2`; dates such as `3/4/2026`, `4-Mar-2026`, `Mar 4, 2026`; times; TRUE/FALSE; error literals; a leading `'` forces text) and `parseNumberText(text)`. Dates stay ISO text (`2026-03-04`); a time on its own becomes a fraction of a day.
  - `setCellValue`, TSV/CSV import, `importRows`, clipboard paste and autofill store the typed value in `value` and keep `raw` as typed. Cells get an automatic `numberFormat` (new optional `CellData` field) and, when the column format is unset or `text`, a matching `format` (`currency`, `percentage`, `date`, `number`). Documents saved with numeric-string values are re-parsed from `raw` on load.
  - Writes to bound number/boolean/date fields are coerced by the field type before `updateRecord`; string and enum fields still receive the text as typed. Values read from data sources are never re-parsed.
  - `compareValues` follows Excel: numbers < text < booleans < errors, numbers compared at 15 significant digits (`=0.1+0.2=0.3` is TRUE), blanks as 0/""/FALSE, ISO dates chronologically (and as serials against numbers). New `sortCompareValues` (blanks last), `compareNumbers`, `numberToText`. `&` and other text coercion print numbers with up to 15 significant digits; arithmetic coerces numeric text such as `"1,000"`, `"50%"` and date text.
  - Table sort uses Excel's type order; filters and criteria (`SUMIF`, `COUNTIFS`…) read operands with the typed-input rules (`">1,000"`, `"10%"`, `">=3/1/2026"`).
  - New `formatCellDisplay(cell)`, used by the React and Svelte grids, CSV/TSV export and clipboard text, shows typed values as entered (`10%`, `$1,200.50`, `3/4/2026`) and booleans as TRUE/FALSE.

## 0.22.0

### Minor Changes

- be14fc8: Add Freeform-style shape boolean operations (Unite / Intersect / Subtract / Exclude / Divide) for canvas shape nodes. Core (`@pixerate/editor/canvas`) gains a dependency-free polygon boolean engine for multi-polygons with holes (`polygonBoolean`, `unionPolygons`, `intersectPolygons`, `subtractPolygons`, `xorPolygons`, `dividePolygons`), shape geometry (`data.shape` descriptions for rect / rounded rect, ellipse, regular polygon, star and SVG path data; `parseSvgPath`, `flattenSvgPath`, `shapeToPolygon`, `polygonToSvgPath`, `simplifyRing`, `getShapeRenderData`), `combineShapeNodes` / `canCombineShapeNodes`, and `combineShapes` / `unite` / `intersect` / `subtract` / `exclude` / `divide` / `canCombineShapes` on the arrange controller (one undo step with `HistoryManager`). `useCanvasArrange` and `createCanvasArrange` expose the new actions, and both packages add a headless `ShapeNode` component for React Flow / SvelteFlow.
- be14fc8: Add dependency-free DOCX, PDF and zipped-export import adapters.

  - **DOCX** is now a built-in `document` adapter (`docxImportAdapter`, `createDocxImportAdapter`, `docxToDocumentImport`): headings, run formatting, hyperlinks (incl. `HYPERLINK` fields), nested lists, tables, line breaks, tabs, footnotes / endnotes and embedded images, sanitized with `sanitizeImportedHtml`. Tracked changes import as accepted by default (`trackedChanges: "original"` to reject). `getImportAccept("document")` now includes `.docx`, `.docm`, `.dotx` and the WordprocessingML MIME types, so React `useFileImport` / `useEditor({ fileImport })` and Svelte `createFileImport` / the `fileImport` prop import Word files automatically.
  - **PDF** (opt-in): `createPdfImportAdapter(pdfjs)` takes an injected pdf.js-compatible object and groups text items into lines and paragraphs; `pdfTextItemsToParagraphs` is exported.
  - **Zipped exports** (opt-in): `zipImportAdapter` / `createZipImportAdapter` import `.zip` archives of markdown / HTML / text / DOCX files with a heading per file and report skipped entries.
  - **ZIP reader**: `readZip` / `ZipArchive` / `ZipError` parse ZIP (incl. ZIP64) and inflate with `DecompressionStream`, with entry-count, uncompressed-size, path-traversal, encryption and CRC-32 checks.
  - `ImportErrorCode` gains `invalid_file` and `unsupported_environment`; `ImportError`s thrown by adapters now keep their code instead of being wrapped as `adapter_failed`. `ImportContext` exposes the running `registry`.

- be14fc8: Spreadsheet dynamic arrays and date arithmetic.

  - **Spilling**: a formula returning several values (`=A1:A3`, `=A1:A3*2`, `=SEQUENCE(3)`, `INDEX(..., 0, n)`, 2D `XLOOKUP` results) spills into the cells below and to the right. Spilled cells keep an empty `raw`, carry `CellData.spillAnchor` and are not stored in the document. A blocked spill (non-empty cell, merged cells, another spill, or the edge of the sheet; the grid never grows) shows `#SPILL!` with a message naming the blocking cell. Typing into a spilled cell blocks the array; clearing it restores the spill. New controller methods `getSpillAt(row, col)` and `getSpills()` return `SpreadsheetSpill` objects.
  - **Recalculation**: spill ranges join the dependency graph (`DependencyGraph.setSpillEdges`), so dependents of spilled cells recalculate when the array changes size, and cycles through spills are `#CYCLE!`.
  - **`A1#` spill references** in the lexer (`SPILL_REF`), parser (`SpillRef`), evaluator (`EvaluationContext.resolveSpill`) and reference rewriting (insert/delete, paste/autofill offsets, sort/transpose remaps, clipboard JSON).
  - **Array functions**: FILTER, SORT, SORTBY, UNIQUE, SEQUENCE, TRANSPOSE, RANDARRAY and LET; element-wise arithmetic, comparison and `&` on arrays with broadcasting; scalar functions such as IF, LEN, ROUND and IFERROR apply element by element (`FormulaFunctionDefinition.elementwise`); implicit intersection `@`. New error codes `#SPILL!` and `#CALC!`. `evaluateWithDiagnostics` now also returns multi-value results in `array` (`value` is still the top-left value). LAMBDA is not implemented.
  - **Dates**: `date + n` / `date - n` return ISO dates, `date - date` returns days, and ISO dates compare chronologically. TRIM collapses inner runs of spaces like Excel.
  - **Table operations**: sorting, merging and transposing a range that touches a spill are refused; CSV/TSV export writes spilled values; copying spilled cells without their anchor pastes them as values.
  - **React / Svelte**: the spreadsheet editors draw a border around the active spill range and show the anchor's formula greyed out in the formula bar for spilled cells.

- be14fc8: Track formatting, block-structure and code-block edits in suggestion mode.

  - Core: `TrackChanges` now records formatting changes on existing text (mark added/removed/changed, e.g. bold, links, highlight, font size) with a `formatChange` mark holding the author, id and the `before` / `after` formatting, and textblock changes (paragraph ↔ heading, heading level, code block, alignment, list wrap/lift/indent/outdent, list type, blockquote) with a `blockChange` node attribute holding the previous type, attributes and wrappers. Accept/reject (single and all) handle every kind as one undo step; reject restores the previous formatting, type and nesting. Insertions and deletions inside code blocks are tracked as well. New options `trackFormatting`, `trackBlocks`, `trackCodeBlocks`, `blockTypes`, `ignoredMarks`, `ignoredBlockAttributes`, `formatChangeHTMLAttributes` and `blockChangeClass`.
  - `TrackedChange.type` adds `"format"` and `"block"`; every change has a human-readable `description` ("Formatted: Bold", "Changed Paragraph to Heading 2"), plus `format` / `block` details. New exports: `TrackedFormatChange`, `FORMAT_CHANGE_MARK_NAME`, `BLOCK_CHANGE_ATTRIBUTE`, `describeFormatChange`, `describeBlockChange` and the related types.
  - Serializers export the new formatting and block types by default and the original ones with `trackedChanges: "original"`. Pasted content drops format and block records.
  - React / Svelte: `ReviewToolbar` shows the current change's author and description (`showDescription`, `descriptionClassName` / `descriptionClass`).

### Patch Changes

- be14fc8: Fix UI bugs found in the browser:

  - Spreadsheet (React): text typed into a cell is committed again on Enter, Tab and blur (`setDraftValue` now updates the controller's draft).
  - Spreadsheet (React, Svelte): typing on a selected cell no longer doubles the first character, the cell editor is focused (Svelte), focus returns to the grid after Enter / Tab / Escape, sticky header and row-number cells are opaque, the context menu stays inside the viewport (new `clampMenuPosition` helper), and a denied clipboard write in the copy fallback no longer causes an unhandled rejection.
  - Canvas: the snapped position is kept when a drag ends (React Flow's drag-stop change and SvelteFlow's drop no longer restore the raw pointer position), and `snapPositionChanges` accepts React Flow's `NodeChange[]` (id-less `add` changes).

## 0.21.0

### Minor Changes

- dd09aac: Per-feature entries so a spreadsheet- or image-only app does not take canvas dependencies.

  - **`@dagrejs/dagre` is now an optional peer dependency** of all three packages instead of a hard dependency of `@pixerate/editor` and `@pixerate/editor-svelte`. It is only used by the canvas entries; if you use `@pixerate/editor/canvas`, `@pixerate/editor-react/canvas`, `@pixerate/editor-svelte/canvas` or the agent canvas planner, add it to your app: `npm install @dagrejs/dagre`.
  - **New `./spreadsheet` subpath** in `@pixerate/editor-react` and `@pixerate/editor-svelte`. It imports only the framework and `@pixerate/editor/spreadsheet`, so it bundles no TipTap, markdown or dagre code. The root entries still re-export the spreadsheet components.
  - The React and Svelte spreadsheet and history bindings now import from the narrow `@pixerate/editor/spreadsheet` and `@pixerate/editor/history` subpaths instead of the root entry.
  - `@pixerate/editor` and `@pixerate/editor-react` are marked `sideEffects: false` so bundlers can drop unused root exports.
  - `tiptap-markdown` (already bundled into `@pixerate/editor`) moved to `devDependencies`, so it is no longer installed separately.

## 0.20.0

### Minor Changes

- a626b31: Add Freeform-style canvas arrangement features. Core (`@pixerate/editor/canvas`) gains `alignNodes`, `distributeNodes` (equal gaps or equal centres), `matchSize`, node locking (`lockNodes` / `unlockNodes` / `isLocked`), z-order helpers (`reorderNodes` for bring forward / send backward / bring to front / send to back), smart guides with snap-to-shape (`computeSnapGuides`, `createGuideIndex`, `snapNodeDrag`, edge, centre and equal-spacing guides), connector snapping (`findConnectorSnap`, `nearestHandlePositions`), a headless Scenes store (`CanvasScenesStore`, `fitViewportToNodes`), arrange keyboard shortcuts (`matchArrangeShortcut`) and a shared `createCanvasArrangeController` with optional `HistoryManager` undo. React adds `useCanvasArrange`, `useCanvasArrangeShortcuts`, `useCanvasScenes` and `<CanvasGuidesLayer>`. Svelte adds `createCanvasArrange`, `createCanvasArrangeShortcuts`, `createCanvasScenes` and `<CanvasGuidesLayer>`.
- a626b31: Add document-structure features for the rich-text editor, all opt-in via new `createRichTextPreset` options (`outline`, `tableOfContents`, `footnotes`, `bookmarks`, `crossReferences`, `autocorrect`); existing consumers see no behaviour change.

  - **Outline**: `Outline` extension gives headings stable `id` attributes and keeps a heading outline in plugin state (`getOutline`, `buildOutlineTree`, `getActiveHeading`, `createOutlineStore`, `navigateToHeading`, `focusHeading` / `scrollToHeading` commands).
  - **Table of contents**: `TableOfContents` atom block with linked entries refreshed on every change, `insertTableOfContents` command, `[[toc]]` markdown round-trip.
  - **Footnotes**: `FootnoteReference`, `Footnotes` and `Footnote` nodes with automatic numbering, reordering and pruning; `insertFootnote`, `updateFootnote`, `deleteFootnote`, `goToFootnote`, `goToFootnoteReference` commands; `[^n]` markdown export and import.
  - **Bookmarks and cross-references**: `Bookmark` mark (`setBookmark`, `removeBookmark`, `renameBookmark`, `goToBookmark`) and `CrossReference` node that shows its target's current text and a broken state when the target is removed.
  - **Autocorrect**: `Autocorrect` extension with a rule registry (smart quotes, symbols, fractions, sentence capitalization, two initial capitals), an exceptions list, Word-like undo of a correction, and no corrections in code or prompt tokens. `SmilieReplacer` is unchanged; its smilies are also available as `smilieAutocorrectRules`.
  - `documentStructureCommandItems` / `getDocumentStructureCommandItems` for slash menus and toolbars.
  - React: `OutlinePanel` component and `useOutline` hook. Svelte: `OutlinePanel` component and `createOutline` rune.

- a626b31: Add file import adapters, a rich-text clipboard MIME type and a dynamic agent tool registry.

  - **Import adapters** (`@pixerate/editor`): `registerImportAdapter`, `findImportAdapter`, `importFile`, `getImportAccept` and `ImportAdapterRegistry`, with built-in markdown, HTML (sanitized), plain-text and RTF adapters for the `document` target. DOCX/PDF/zip or CSV → spreadsheet adapters can be registered. New serializers: `sanitizeHtml`, `sanitizeImportedHtml`, `plainTextToParagraphHtml`, `rtfToPlainText`.
  - **Drag-and-drop / picker import**: opt-in `FileImport` extension (`createRichTextPreset({ fileImport: true })`), `importFilesIntoEditor`, `FileImportController`; React `useFileImport` and `useEditor({ fileImport })` / `usePromptEditor({ fileImport })`; Svelte `createFileImport` and the `fileImport` prop on `EditableTextNodeEditor`.
  - **Rich clipboard**: opt-in `RichClipboard` extension writes `application/x.pixerate.document+json` (slice JSON + schema signature) on copy/cut and prefers it on paste when schemas match; `richClipboard` option in React `useEditor` and on the Svelte editor.
  - **Agent tool registry** (`@pixerate/editor/agent`): `ToolRegistry` with MCP-shaped `listTools` / `callTool`, JSON-Schema-lite argument validation (`validateJsonSchema`), structured errors, namespacing on name collisions and coalesced `onListChanged`. Providers: `createRichTextToolProvider`, `createSpreadsheetToolProvider`, `createEditorMcpToolProvider`. The planner gains `toolCallToAgentCommand`, `planToolCall` and a `tool:call` command / `step:tool_call` step. React and Svelte `useAgentToolProvider`.
  - Fix (Svelte): `EditableTextNodeEditor` no longer passes `undefined` `onUpdate`/`onCreate` to TipTap, which made editor updates throw when those props were omitted.

- a626b31: Prompt grammar: variable defaults, descriptions, conditional sections and resolution with values.

  - `{name|default|description}` variables (FILLIN-style). The tokenizer exposes `defaultValue` and `description` on variable tokens, and `\|`, `\{`, `\}`, `\\` escapes are supported.
  - `{?name}…{/name}` and `{!name}…{/name}` conditional sections, emitted as `conditional` tokens. They nest, and they work inside template bodies with cycle detection. Unbalanced tags stay literal text and are reported as diagnostics (`tokenizePromptWithDiagnostics`, `getPromptDiagnostics`).
  - New `values` option on `resolveTemplates` / `resolveTemplatesWithMapping`, and a new `resolvePrompt()` that returns `{ text, map, diagnostics }`. Source maps gain `variable` and `conditional` segments. Without `values`, output is unchanged.
  - Headless fill-in form helpers: `extractVariables`, `getVariableFormFields`, `compactVariableValues`, plus `evaluatePromptTokens` for renderers.
  - `GradientText` styles variables that have defaults, balanced conditional tags, and unbalanced conditional tags (each differently).
  - React and Svelte: `TemplateRenderer` accepts `values` and `bindings` and renders the new tokens. New `VariableForm` component.
  - `extractVariableNames` now strips defaults and includes names used by conditions. `resolveVariables` honors defaults and sections.

- a626b31: Add review features for the rich-text editor: comments and tracked changes.

  - Core: `Comments` extension (`comment` mark + `addComment` / `resolveComment` / `deleteComment` / `setActiveComment` / `focusComment`) backed by a headless, server-free `CommentStore` (threads, replies, resolve, orphan detection, `toJSON` / `load`). `TrackChanges` extension (suggestion mode) with `insertion` / `deletion` marks, `setTrackChanges` / `toggleTrackChanges`, `acceptChange` / `rejectChange` / `acceptAllChanges` / `rejectAllChanges` (single undo steps), `selectNextChange` / `selectPreviousChange`, and `getTrackedChanges`. Both are opt-in via `createRichTextPreset({ comments, trackChanges })`.
  - Serializers: `htmlToPlainText`, `getEditorText` and `getEditorMarkdown` accept `{ trackedChanges: "accepted" | "original" | "all" }` and default to `"accepted"`, so suggested deletions never leak into exported text. New `resolveTrackedChanges(doc, view)`.
  - React: `CommentsPanel`, `ReviewToolbar`, `CommentButton`, `useComments`, `useTrackChanges`.
  - Svelte: `CommentsPanel`, `ReviewToolbar`, `CommentButton`, `createComments`, `createTrackChanges`.

- a626b31: Spreadsheet formula engine: function registry, 70 new functions, diagnostics and autocomplete.

  - **Function registry** (`@pixerate/editor`): every formula function now has a category, description and argument specs. Use `registerFormulaFunction` / `unregisterFormulaFunction` to add or override functions, `listFormulaFunctions` / `searchFormulaFunctions` for function browsers, and `getFormulaSignature` (e.g. `SUMIF(range, criteria, [sum_range])`) / `getFormulaSignatureParts` for hints. The existing 16 functions moved onto the registry unchanged.
  - **New functions**: IFERROR, IFNA, AND, OR, NOT, XOR, IFS, SWITCH, SUMIF(S), COUNTIF(S), AVERAGEIF(S), MAXIFS, MINIFS, COUNTBLANK, INDEX, MATCH, XLOOKUP, VLOOKUP, HLOOKUP, LEFT, RIGHT, MID, FIND, SEARCH, SUBSTITUTE, REPLACE, REPT, TEXTJOIN, PROPER, EXACT, VALUE, TEXT, ROUNDUP, ROUNDDOWN, INT, MOD, POWER, SQRT, PRODUCT, MEDIAN, MODE, STDEV, VAR, LARGE, SMALL, RANK, CEILING, FLOOR, SIGN, PI, RAND, RANDBETWEEN, NOW, DATE, YEAR, MONTH, DAY, WEEKDAY, EDATE, EOMONTH, NETWORKDAYS, DATEDIF, ISBLANK, ISNUMBER, ISTEXT, ISERROR, ISNA. Criteria support `">5"`, `"<>x"`, `"=a"` and `*` / `?` wildcards.
  - **Diagnostics**: `FormulaEvaluator.evaluateWithDiagnostics()` returns `{ value, error, message }` with argument-indexed messages (`Argument 1 of SUMIF must be a range.`), unknown-function, argument-count and circular/self-reference messages. Cells get an optional `CellData.errorMessage`, and `CellData.error` now carries the code for value errors such as `#DIV/0!` (previously only set for `#CYCLE!` and malformed formulas). Wrong argument counts now return `#ERROR!` instead of throwing.
  - **Autocomplete**: `getFormulaCaretContext`, `getFormulaHints` and `applyFormulaSuggestion` in core; new `FormulaHints` components in React and Svelte, wired into the cell editor and formula bar of `SpreadsheetEditor` (ArrowUp/Down to choose, Tab or click to accept, Escape to close). Error cells show their message as a tooltip.

- a626b31: Spreadsheet CSV/TSV import adapters for the import registry (`csvImportAdapter`, `tsvImportAdapter`, `registerSpreadsheetImportAdapters`, `importFileIntoSpreadsheet`) and `SpreadsheetController#importRows`. Fixes generated row/column/filter ids colliding when many rows are created in the same millisecond, which made large imports share cell storage and report false `#CYCLE!` errors.
- a626b31: Spreadsheet table operations, CSV and rich clipboard.

  - `SpreadsheetController` gains undoable table operations: `sortRows` (multi-column, stable, numbers before text, blanks last; whole table or a range; header/footer rows stay put), filters (`addFilterRule`, `setFilterRules`, `updateFilterRule`, `removeFilterRule`, `clearFilters`, `setFiltersEnabled`, `toggleFilters`), header/footer/frozen row and column counts, `hideRows`/`hideColumns`/`unhideRows`/`unhideColumns`/`unhideAll`, `mergeCells`/`unmergeCells` (selection, navigation and editing respect merges), `autofill` (number/date series, "Item 1" → "Item 2", formulas with relative references shifted), categories (`groupRowsBy`, `setGroupSummary`, `toggleGroupCollapsed`, `getGroups`) and `transposeRange`. Sort and transpose keep formula references pointing at the moved cells, and merges follow row/column inserts and deletes.
  - `getViewModel()` / `buildSpreadsheetView()` describe what to render: visible rows (with group headers) and columns in display order, frozen offsets and merged-cell spans. Keyboard navigation follows the view, skipping hidden, filtered and collapsed rows.
  - New RFC 4180 CSV module (`parseCsv`, `serializeCsv`, `parseTsv`, `serializeTsv`) and `importFromCsv` / `exportToCsv`.
  - New spreadsheet clipboard: `copyToClipboardData` writes `text/plain` (TSV), `text/html` (a table) and `application/x.pixerate.spreadsheet+json` (raw inputs and formulas); `pasteClipboardData` prefers that format (formulas re-based to the target), then HTML tables, then TSV.
  - New core helpers: `offsetFormulaReferences`, `remapFormulaReferences`, `mapFormulaReferences`, `fillSeries`, `computeFillTarget`, `compareCellValues`, `matchesFilterRule`, `aggregateValues`, `getSpreadsheetMenuItems`, `bindSpreadsheetTableActions`.
  - React (`useSpreadsheetEditor`, `<SpreadsheetEditor />`) and Svelte (`createReactiveSpreadsheet`, `<SpreadsheetEditor />`) expose every table action plus `viewModel`, and render frozen panes (sticky), merged cells, hidden rows/columns, filtered-column markers and collapsible category headers with summaries. Both add a right-click table menu, a fill handle for autofill, and copy/paste of all three clipboard formats. Mod+C now lets the browser's `copy` event write the rich formats, falling back to `navigator.clipboard.writeText` (TSV) when no copy event fires.

## 0.19.0

### Minor Changes

- 76593c8: Fix image editor geometry under rotate/flip/crop and make AI edits undoable.

  **`@pixerate/editor` (image editor)**

  - The crop box and annotations now live in one coordinate space: natural pixels of the source image. A single forward/inverse transform (90° rotations, flips, crop, fit scale, zoom, pan) drives rendering, export, hit-testing, viewport metrics and mask generation.
    - `canvasToImagePoint` now accounts for rotation, flips and the crop offset, and `imageToCanvasPoint` is its exact inverse. Results are no longer rounded to whole pixels.
    - The crop overlay and `getViewportMetrics().cropRect` are correct at 90°/270°. For example, the left half of an 800×600 image drawn at 90° is now 600×400, not 300×800.
    - `hitTestCrop` returns the crop handle in image space, so dragging a crop on a flipped or rotated image moves the correct edge. `getCropCursor(handle, transform?)` and `calculateCropDrag(..., aspectRatio, transform?)` take an optional transform so the cursor and the on-screen aspect ratio match what the user sees. `applyCropPreset` treats its ratio as the on-screen aspect.
    - The depth mask gets the same rotate/flip transform as the image.
    - Annotations stay attached to the image content when the image is rotated, flipped or cropped, and are clipped to the visible region. Annotations saved by earlier versions while a crop or rotation was active were stored in display space, so they may appear shifted.
  - `renderMask` is aligned with the natural-size source image. Its output is strictly black and white: annotations are never drawn in their own colours or opacity, and edges are thresholded. Negative circle radii no longer throw.
  - `applyInpaintedImage` and `applyBackgroundRemovedImage` are each a single undoable step. Undo restores the previous source image (URL and element), dimensions and annotations, and redo applies the edit again. If the new image has different dimensions, the crop and annotations are rescaled. `reset()` still returns to the image that was originally loaded.
  - New `renderSource()` / `toSourceDataURL()` return the untransformed source image, which is the image the mask lines up with.
  - The base-render cache key now includes `depthMask.maskSource` and the identity of the source image, so changing either re-renders the base image instead of showing a stale one.
  - `rotate`, `setRotation`, `flipHorizontal` and `flipVertical` now create a new `transform` object instead of changing the existing one, so subscribers that memoize by reference see the change.
  - There is now one `getAnnotationBounds` (in the geometry module). `ImageEditorRenderer#getAnnotationBounds` delegates to it and is deprecated.
  - When the controller is constructed with an image element, `sourceUrl` is now set from that element's `src`.

  **`@pixerate/editor-react` / `@pixerate/editor-svelte`**

  - The built-in AI panel now sends the untransformed source image (`toSourceDataURL()`) to `onInpaint` / `onRemoveBackground`, so the image and the mask line up, and the returned image replaces the source without crop, rotation or adjustments being applied twice.
  - The crop cursor and the aspect-locked crop drag respect rotation and flips.
  - `useImageEditor()` and `createReactiveImageEditor()` expose `toSourceDataURL()`.

## 0.18.0

### Minor Changes

- 1166e77: Fix several canvas, history and agent-planner engine bugs.

  - **`StreamingLayoutManager`**: `pushStreamUpdate` is now a real throttle (leading + trailing edge) instead of a debounce, so layouts keep running at most once per `throttleMs` during a continuous stream. Glides now animate known nodes from their current position to the newly computed layout. Previously every known node was pinned to its current position, so no glide ever ran. Only `layoutOptions.storedPositions` are treated as pinned. Added `getTargetPositions()`.
  - **`runMultiNodeTransition`** (core and the Svelte fork): no longer mutates the input nodes, and handles object styles (React Flow / xyflow) as well as CSS-string styles. Before this fix, an object `style` threw an error. **Behavior change:** updated node copies are passed to `onUpdate(nodes)` and `onComplete(nodes)`, in the same order as `transitions`. If your code read the mutated input nodes, merge these copies by `id` instead. A new `styleFormat: 'string' | 'object'` option controls the style created for nodes that have none (default `'string'`). `useCanvasExplosion` (React) passes `'object'`. Added the `withStyleOpacity` helper and the `CanvasNodeStyle` type. `CanvasNode.style` is now `string | Record<string, any>`.
  - **Canvas clipboard**: `isValidCanvasNode` now requires `position.x` and `position.y` to be finite numbers. A string like `"1e3"` is rejected. A non-array or malformed `edges` payload is ignored instead of crashing. `remapPastedNodes` remaps `parentId` (and the legacy `parentNode`) to the new parent ID when the parent was pasted too. In that case the child keeps its parent-relative position. Added `isValidCanvasEdge`. The Svelte `createCanvasClipboard` paste handler gets the same fixes.
  - **`HistoryManager`**: if `batch(fn)` throws, the commands that already ran in the batch are rolled back in reverse order, nothing is pushed, and the error is rethrown. If a command's `undo`/`redo` throws, the command stays on its original stack and the error is rethrown.
  - **Agent planner**: `canvas:add_node` accepts the schema's `side` values `top` and `bottom`, plus `above` and `below`. Before, `top` was treated as below. `canvas:layout` now defaults `incremental` to `true`, as the `edit_canvas` tool schema says. An unknown `nearNodeId` no longer adds a dangling edge. Added `normalizeSide`.

## 0.17.0

### Minor Changes

- ee94411: Spreadsheet engine correctness fixes (`SpreadsheetController` and the formula engine):

  - **Recalculation order and cycles:** recalculation now follows dependency order, so loading a document where `A1` = `=A2*2` and `A2` = `=3+1` gives 8, not 0. Every cell in a reference cycle is marked `#CYCLE!`, and it stays marked across inserts, undo and full recalculations. Cells depending on a cycle show `#CYCLE!` too. Breaking the cycle recalculates every member. The dependency graph is rebuilt on full recalculation instead of keeping stale keys.
  - **Inserting and deleting rows or columns rewrites references**, like spreadsheet apps. References after the change shift, ranges grow or shrink, references to a deleted row or column become `#REF!`, and `$` markers are kept. The new `shiftFormulaReferences(formula, change)` helper is exported.
  - **`[property]` references** in column formulas resolve against the row being evaluated. Previously they used the selected cell's row, giving every row the same value.
  - **Formula semantics** now follow spreadsheet conventions:
    - Errors propagate: `=1/0+1` gives `#DIV/0!`, not `NaN`, and `#REF!` literals are supported.
    - Unknown names and functions give `#NAME?`.
    - Unterminated strings and unexpected characters are formula errors.
    - `$A$1:$B$2` and whole-column ranges such as `A:A` now work.
    - `MIN`, `MAX` and `SUM` handle very large ranges without overflowing the stack.
    - `ROUND` rounds half away from zero without float drift: `ROUND(-2.5)` gives -3 and `ROUND(1.005, 2)` gives 1.01.
    - `IF` accepts the text `"TRUE"`/`"FALSE"`; other text gives `#VALUE!`.
    - Comparisons are type-aware: `"1"=1` is FALSE, and text comparisons are case-insensitive.
    - Blank cells act as `""` in text and 0 in arithmetic, so `=""&A1` is `""`.
    - `TODAY()` returns the local date.
  - **TSV import (paste):** a paste is now a single undo step, recalculates once, keeps leading empty cells (`"\tB"` puts B in column B), and grows the grid without shifting references. Large pastes are dramatically faster: a 3,000-row formula chain dropped from minutes to under 100ms.
  - `undo()` / `redo()` no longer leave the controller stuck in history mode if recalculation throws.

  **Behavior changes:**
  - Formulas referencing unknown bare names now return `#NAME?` instead of the name as text.
  - Blank cells are passed to formulas as `""` instead of `0`.
  - `tokenizeFormula` throws on unterminated strings and unexpected characters.

## 0.16.2

### Patch Changes

- a8f80dd: Fix spreadsheet keyboard handling in React and Svelte:

  - **Formula bar:** keystrokes no longer fall through to the grid. Previously Backspace in the formula bar cleared the active cell, arrow keys moved the cursor, and Enter re-opened the cell editor. In React, typing in the formula bar now actually edits the value; it commits on Enter or blur and is discarded on Escape. The formula bar is read-only for read-only sheets and columns.
  - **Redo:** Cmd/Ctrl+Shift+Z now redoes (with Shift held, `e.key` is `"Z"`), and Ctrl+Y is supported.
  - **Copy:** Cmd/Ctrl+C copies the selected range instead of the whole sheet. `SpreadsheetController.exportToTsv(range?)` accepts an optional range.
  - **React column resize:** `onColumnResize` now fires when the pointer stops moving before mouseup. Previously the effect re-subscribed after every width update and lost the drag state.
  - **React `useSpreadsheetEditor`:** the initial `document` now reflects the controller, so `<SpreadsheetEditor />` without a document renders the default grid immediately instead of an empty table. The `onDocumentChange`, `onSelectionChange` and `onCellCommit` callbacks are no longer captured once at mount.

## 0.16.1

### Patch Changes

- 0a1a841: Fix `usePromptEditor` lifecycle bugs:

  - Passing `templateColorMap` inline (`new Map(...)` in render) no longer causes an infinite render loop ("Maximum update depth exceeded"). The map is now compared by value.
  - Toggling `isEditing`, or changing `placeholder`, `className` or `jsonVariables`, updates the live editor instead of destroying and recreating it. Undo history, focus and the caret are kept.
  - `content` is now applied when the parent changes it, so you can clear the editor after submit with `setPrompt("")`. Echoes of the editor's own `onContentChange` are ignored, so typing never resets the caret.
  - Milestones use the core tokenizer, so `__award_winning__` now fires `used_magic`. Each milestone fires once per mount instead of on every keystroke.
  - Plain-text paste handling uses the new core `plainTextToSlice` helper, which replaces two duplicated copies. Core now exports `plainTextToSlice(text, schema)` from its serializers.

## 0.16.0

### Minor Changes

- 869b4d4: **Breaking:** TipTap's core packages are now peer dependencies, so your app and these packages share a single TipTap/ProseMirror instance. Install them alongside the editor packages (npm 7+ and pnpm install peer dependencies automatically):

  ```bash
  # core / Svelte
  npm install @tiptap/core@^2.11.5 @tiptap/pm@^2.11.5
  # React
  npm install @tiptap/core@^2.11.5 @tiptap/pm@^2.11.5 @tiptap/react@^2.11.5
  ```

  Previously each package pulled in its own `@tiptap/core` and `@tiptap/pm`, and `@pixerate/editor-react` allowed TipTap v3 while core required v2. That could install two ProseMirror copies, which breaks `instanceof` checks and loads v2 extensions into a v3 editor. The untested `^3.0.0` range has been removed from `@pixerate/editor-react`; all packages now target TipTap `^2.11.5`.

## 0.15.0

### Minor Changes

- c949fd9: **Breaking (core):** the root `@pixerate/editor` entry no longer re-exports the canvas, agent or image editor modules. Import them from their subpaths:

  ```diff
  - import { ensureLayout, ImageEditorController, planAgentCommand } from "@pixerate/editor";
  + import { ensureLayout } from "@pixerate/editor/canvas";
  + import { ImageEditorController } from "@pixerate/editor/image-editor";
  + import { planAgentCommand } from "@pixerate/editor/agent";
  ```

  The root entry therefore no longer loads `@dagrejs/dagre` or the Canvas 2D image renderer. The core build now uses code splitting, so subpath entries share a single copy of common modules. Previously each entry bundled its own copy, which created duplicate singletons such as `globalImageCache` and broke `instanceof` checks across entries. The React and Svelte image editors now import from `@pixerate/editor/image-editor`.

## 0.14.3

### Patch Changes

- ac4f459: Add package READMEs (installation, API overview and Tailwind styling requirements) so the npm package pages are no longer empty.

## 0.14.2

### Patch Changes

- ea4dd6d: Sanitize raw HTML in `markdownToTipTapHtml` (also used by `EditorController.setMarkdown` and markdown-mode initial content).

  - Raw HTML embedded in markdown is now restricted to an allowlist of tags and attributes. Event handlers (`onerror`, `onclick`, …), `style`, and unsafe URL schemes (`javascript:`, including entity- and whitespace-obfuscated forms) are removed. Disallowed tags such as `<script>`, `<iframe>` and `<style>` are rendered as escaped text.
  - Mention spans, `data-*` attributes, file/vscode/cursor links and task-list checkboxes keep working, so markdown round-trips are unaffected.
  - `preprocessMarkdownFileLinks` now escapes link hrefs and labels, so a crafted `[x](file:///a"onmouseover="…)` can no longer inject attributes.
  - Pass `allowUnsafeHtml: true` to restore the previous unsanitized behavior for fully trusted input.

## 0.14.1

### Patch Changes

- 6a369fc: Fix plain-text serialization and literal text insertion:

  - `htmlToPlainText` (and therefore `getEditorText`, `EditorController.getPlainText`, `onPlainTextChange` and dirty tracking) no longer repeats list items (TipTap renders `<li><p>…</p></li>`) and no longer drops code blocks, blockquote content or other text outside the recognised block tags.
  - HTML is now parsed into an inert `<template>` fragment instead of a `<div>` owned by the live document, so `htmlToPlainText` / `extractMentionsFromDoc` on untrusted HTML can no longer trigger `<img onerror>`-style handlers.
  - Mention-span normalization no longer backtracks catastrophically on malformed HTML (previously seconds per keystroke on large inputs).
  - The Node.js fallback decodes `&amp;` last (so `&amp;lt;` stays `&lt;`), no longer trims leading blank lines, and handles nested list paragraphs.
  - `plainTextToTipTapHtml` only passes input through untouched when it is paragraph HTML (starts with `<p>` and ends with `</p>`); plain text that merely contains `<p>` is now escaped.
  - `EditorController.insertText`, `insertTextAt` and `replaceRange` now insert text literally (HTML is not parsed) and split paragraphs on newlines.

## 0.14.0

### Minor Changes

- 743f096: Fix template resolution edge cases:

  - Template bodies containing `$&`, `` $` ``, `$'` or `$$` are now inserted literally. Previously they were treated as `String.replace` patterns, which corrupted output and could hang the resolver forever.
  - **Behavior change:** loop and max-depth errors now replace only the offending tag instead of the whole prompt. `resolveTemplates("Hello {{a}} world")` with a self-referencing `a` now returns `"Hello [Template loop detected] world"`. Use the new `TEMPLATE_LOOP_ERROR` / `TEMPLATE_DEPTH_ERROR` constants with `.includes()` to detect errors.
  - `resolveTemplatesWithMapping` now produces exactly the same text as `resolveTemplates` (it previously expanded loops one level further and ignored `maxDepth`), and accepts an optional `{ maxDepth }` options argument.
  - `mapResolvedOffsetToRaw` / `mapRawOffsetToResolved` now map the end of a trailing template to the end of its tag instead of jumping back to its start.
  - New `getTemplateBody(template, bindings)` helper exposes version-binding resolution.

## 0.13.0

### Minor Changes

- 47db314: Add AI inpainting and background removal hooks and tool panel support:
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

## 0.12.0

### Minor Changes

- ce828f8: Add UI-agnostic Canvas 2D image editor engine with cross-framework parity across Vanilla JS, React, and Svelte 5:
  - **Core Canvas 2D Engine**: persistent interactive crop overlay with 8 resize handles, aspect ratio locking, geometric hit-testing, transformations (rotate, flip), color adjustments (brightness, contrast, saturation, exposure, temperature, blur, opacity), drawing and annotation vector layers with live draft camera projection (pen, rect, circle, arrow, line, text), zoom/pan viewport, live compare mode, and JSON state serialization.
  - **Gleamforge Depth Alpha Masking**: threshold and brightness depth alpha blending with softness, invert, and `removeAlpha`.
  - **React Support**: `useImageEditor` hook and `<ImageEditor />` component with interactive crop box dragging, handle resizing, live annotation preview, top toolbars, and side control panels.
  - **Svelte 5 Support**: `createReactiveImageEditor` rune helper and `<ImageEditor />` component with 1:1 functional parity.

## 0.11.0

### Minor Changes

- ce112c2: Add deterministic animation clock, streaming view stabilization, and agent vision/narration features:
  - Core: `Clock`, `realClock`, and `ManualClock` for step-by-step frame animation testing and deterministic trajectories.
  - Core: Streaming stabilization math including `layoutBounds`, `canvasHeight`, `estimateCanvasHeight`, `blendLayout`, and `connectedOnly`.
  - Core: `MCP_TOOL_VIEW_EDITOR` and `EXPORT_EXCLUDED_SELECTORS` for multimodal evaluation without cursor artifact loops.
  - Core: Choreography `say` and `wait` command planning with `note` support on `AgentPresence`.
  - React & Svelte: `AgentPresenceLayer` speech bubbles and presence exclusion classes.
  - React & Svelte: `useStreamingCanvas` and `createStreamingCanvas` with `connectedOnly` and `clock` options.

## 0.10.0

### Minor Changes

- 09e2459: Add canvas math primitives, smart collision-avoiding layout, agent planning & MCP tools, streaming canvas gliding, and slot component inversion:

  - **Core Canvas Extraction**: Extracted graph layout, trajectory animations, directional displacement, and clipboard serialization into `@pixerate/editor/canvas`.
  - **Smart Layout & Collision Avoidance**: Implemented `ensureLayout` (centroid-based incremental layout blending) and `placeBeside` (spiral raycast collision avoidance).
  - **React Canvas Parity**: Implemented `useCanvasGraph`, `useCanvasLayout`, `useCanvasClipboard`, `useCanvasShortcuts`, `useCanvasDocking`, and `useCanvasExplosion` in `@pixerate/editor-react/canvas`.
  - **Agent Director & MCP Layer**: Added `planAgentCommand`, MCP tool definitions (`get_editor_state`, `edit_canvas`, `edit_prompt`), and `<AgentPresenceLayer />` for visual multi-agent cursor choreography in both React and Svelte.
  - **Streaming Viewers**: Added `StreamingLayoutManager`, `useStreamingCanvas` (React), and `createStreamingCanvas` (Svelte) for throttled auto-layout with tweened node gliding during rapid streams.
  - **Slot-Based Inversion**: Added `EditorSlotsProvider` and `useEditorSlots` to allow zero-fork injection of custom design system components.

## 0.9.0

### Minor Changes

- 3f1e332: feat(core): add mention parsing, extraction, code-block immunity, and markdown preprocessing

  - Add `preprocessMarkdownMentions` to transform raw markdown `@mentions` into TipTap mention node HTML spans before document creation.
  - Add strict code-block immunity (`MARKDOWN_MENTION_SPLIT_REGEX` and `stripMarkdownCode`) protecting fenced code blocks (``` and ~~~), inline code (`...`), HTML `<pre>`/`<code>` blocks, markdown links (`[text](url)`), and raw URLs from false-positive mention parsing.
  - Add `extractMentions` to extract unique mention handles from text, markdown, or HTML, safely ignoring HTML attributes, URLs, and code blocks.
  - Add `parseMentionSegments` to tokenize content into plain text and mention tokens while preserving punctuation boundaries.
  - Add `preprocessMarkdownFileLinks` and support `MarkdownToHtmlOptions` (`mentionables`, `preprocessMentions`, `preprocessFileLinks`) in `markdownToTipTapHtml`.
  - Enhance `extractMentionsFromDoc` to gracefully fallback to extracting raw mentions when provided plain text or markdown without pre-rendered HTML spans.

## 0.8.1

### Patch Changes

- 4bcf5f0: Allow `file://`, `vscode://`, and `cursor://` link protocols in markdown serializer and rich text preset

## 0.8.0

### Minor Changes

- fba3d0d: feat(history): add generalizable undo/redo HistoryManager with React and Svelte adapters

  - Introduced framework-agnostic `HistoryManager` with bounded undo/redo stacks, atomic `batch()` transactions, continuous-event coalescing (`executeMerged`), and `createSnapshotCommand()` helper.
  - Added `@pixerate/editor-react` hooks: `useHistory()` (powered by `useSyncExternalStore`) and `useHistoryShortcuts()` with active input focus guards.
  - Added `@pixerate/editor-svelte` adapters: `createHistory()` (dual Svelte 5 rune and store contract support) and `createHistoryShortcuts()`.
  - 100% backward compatible and completely optional for consumers to adopt.

## 0.7.0

### Minor Changes

- 943b59c: Add dirty state tracking and navigation guards across Core, React, and Svelte packages:

  - **Core (`@pixerate/editor`)**:
    - Add `DirtyTracker` and `createDirtyTracker` utilities for baseline tracking and structural equality comparison (`defaultIsEqual`).
    - Add `isDirty()`, `setCheckpoint()`, `resetDirty()`, and `getBaselineContent()` to `EditorController`.
  - **React (`@pixerate/editor-react`)**:
    - Add `useNavigationGuard` hook to guard against tab close/external unloads (`beforeunload`) and intercept internal link clicks with confirmation dialog support.
    - Add `useDismissGuard` hook to guard modal dialogs and edit sessions on `Escape` key or explicit dismissal triggers.
    - Re-export dirty tracking utilities from core.
  - **Svelte (`@pixerate/editor-svelte`)**:
    - Add `navigationGuard` Svelte action (`use:navigationGuard`) intercepting internal link clicks and external unloads.
    - Add `createNavigationGuard` Svelte 5 rune state manager for programmatic navigation interception.
    - Re-export dirty tracking utilities from core and provide complete TypeScript typings.

## 0.6.1

### Patch Changes

- db73d55: feat(image): add maxBase64Size enforcement, onUploadError callback, and optimistic node cleanup on upload failure

## 0.6.0

### Minor Changes

- 25f0707: feat: add Image extension and clipboard paste/drop handling to editor and EditableTextNodeEditor

## 0.5.1

### Patch Changes

- f0924c4: Publish built-in markdown support and serializers to npm.

## 0.5.0

### Minor Changes

- e32b1ff: Add built-in optional Markdown support, serializers, and controller synchronization:
  - Export `Markdown` extension and `MarkdownOptions` configuration in `@pixerate/editor`.
  - Add `markdown?: MarkdownOptions | boolean` to `createRichTextPreset`.
  - Export `markdownToTipTapHtml` and `getEditorMarkdown` from `@pixerate/editor/serializers`.
  - Add `markdownMode`, `getMarkdown()`, `setMarkdown()`, and `onMarkdownChange` to `EditorController`.
  - Expose `markdown` and `richTextOptions` in `EditableTextNodeEditor` in `@pixerate/editor-svelte`.

## 0.4.5

### Patch Changes

- 0557d6b: Support double-clicking column header edge to size to fit in spreadsheet view

## 0.4.4

### Patch Changes

- 878ae7a: Ensure spreadsheet columns can be reduced and collapsed with explicit inline styles and style block rules on table cells, and align controller min width constraint to 30px

## 0.4.3

### Patch Changes

- 5faaf5d: Fix CommonJS module interop for TipTap extensions by using resilient named and default unwrapping

## 0.4.2

### Patch Changes

- 73a0740: Add inline standard linear-gradient and background-clip styles to GradientText decoration for framework and CSS version resilience

## 0.4.1

### Patch Changes

- 3fa68c9: Add `loadDocument` and `syncWithDataSource` methods to `SpreadsheetController`, `createReactiveSpreadsheet`, and `useSpreadsheetEditor`. Deep clones loaded documents to prevent reactive proxy mutation cascades.

## 0.4.0

### Minor Changes

- 3edfea4: Add generic spreadsheet editor with pure TypeScript formula engine, reactive dependency graph, data source two-way binding, and cross-framework Svelte 5 and React components.

## 0.3.0

### Minor Changes

- c0348c6: Add native Mention extension with atomic inline node, extraction, and serializers; add Notion markdown input rules for TaskItem and Link; fix BubbleMenu plugin registration and sizing.

## 0.2.3

### Patch Changes

- fac79d3: Align TipTap dependencies to ^2.11.5 to prevent npm peer dependency resolution conflicts with @pixerate/editor-svelte

## 0.2.2

### Patch Changes

- c1113ed: Fix TextStyle interop import across TipTap v2 and v3

## 0.2.1

### Patch Changes

- 169b363: - Fix CJS/ESM interop for StarterKit and Placeholder
  - Support resilient Suggestion unwrapping
  - Implement slash command keyboard navigation and paste handling
  - Implement native BubbleMenu using BubbleMenuPlugin for TipTap v2 and v3 compatibility
  - Support number and string version values in Template types
  - Widen @tiptap/* dependencies to support ^2.11.5 || ^3.0.0

## 0.2.0

### Minor Changes

- 654701d: Initial release of the UI-agnostic rich text and prompt media editing engine with JavaScript, React, and Svelte packages.
