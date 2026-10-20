# Known Gotchas, Pitfalls & Solutions

This document tracks known issues, framework quirks, edge cases, and pitfalls encountered across `@pixerate/editor` packages, along with their solutions and workarounds.

All contributors and AI assistants should check this file before starting work and update it whenever discovering a new issue or solution.

---

## Template for New Entries

```markdown

### [Scope/Area] Brief description of the issue

- **Issue / Symptom**: What goes wrong or behaves unexpectedly.
- **Root Cause**: Why it happens (e.g. ProseMirror transaction lifecycle, Svelte reactivity timing, Tailwind reset conflicts, bundling issues).
- **Solution / Workaround**: How to resolve it or avoid it.
```

---

## Entries

### [core/vector] Constraints Need Anchor Ids, and Every Hand-Built Anchor Copy Must Carry Them

- **Issue / Symptom**: Constraints disappeared after ordinary edits (a move, a reverse, a shape-keeping delete of a neighbour).
- **Root Cause**: Constraints refer to anchors by `VectorAnchor.id`; code that copies anchors field by field (`mapAnchor`, `reverseSubpath`, `pathMap`'s mapper, the shape-keeping delete) dropped the new field, so the solver's purge removed constraints whose anchors it could no longer find (the same trap as live corners).
- **Solution / Workaround**: Copy anchors with `cloneAnchor`, or add `...(a.id ? { id: a.id } : {})` to hand-built copies. Ids are given lazily (only to anchors a constraint refers to), so most documents never carry them. Operations that rebuild a path from scratch (booleans, Outline Stroke, Expand) do drop them, and the constraints go with them.

### [core/vector] Dimensionless Constraint Rows Converge Too Loosely Over Long Segments

- **Issue / Symptom**: Two segments constrained perpendicular were 4 × 10⁻⁶ units off at their far ends while the solve reported success.
- **Root Cause**: The solver's tolerance is in document units (1e-9 of the largest coordinate), but a cross product of unit vectors is dimensionless: a residual just under the tolerance still turns into a visible offset over a 60-unit segment.
- **Solution / Workaround**: Express every row in length units: parallel / perpendicular use one unit direction and one full segment, tangent at an anchor uses the outgoing handle's length, and angle rows are radians times the segments' mean length. New residuals should follow the same rule.

### [core/vector] The Solve After Every Edit Needs to Know What Was Just Edited

- **Issue / Symptom**: Dragging a constrained anchor left it short of the pointer; the solver pulled it back towards the rest.
- **Root Cause**: A minimum-norm solve moves every free parameter a little. Without weights, the dragged anchor takes its share of the correction.
- **Solution / Workaround**: The controller keeps the last solved document; `solveVectorConstraints(doc, previous)` gives every parameter that differs from it a weight of 10⁶, so edited geometry (dragged, typed by a command, undone) moves least and the dependent geometry follows. Checks that need exact positions should compare constrained quantities, not the dragged anchor's coordinates.

### [core/vector] Instances Carry Their Symbol's Art, Because Geometry Sees One Node at a Time

- **Issue / Symptom**: Bounds, hit-testing, rendering and export of an instance came back empty, or stale after the symbol changed.
- **Root Cause**: Every geometry helper takes a node, not the document, so an instance cannot look its symbol up. A module-level lookup would also go stale whenever an edit creates a new instance object (moves spread the node).
- **Solution / Workaround**: Instances carry `art`, the symbol's own `nodes` array, resolved by `resolveVectorSymbols` in the controller's `refreshed()` (with the blend refresh) and on load; spreads carry it along. Storage strips it (`toJSON`, `stripVectorSymbolArt`), and `vectorDocumentToSvg` resolves documents that come without it. Code that builds documents outside the controller should call `resolveVectorSymbols` before measuring instances.

### [core/vector] An Instance's Transform Scales, So Draw It Through a Group Whose Transform Stays Rigid

- **Issue / Symptom**: Strokes in scaled instances hit-tested at the wrong width, and filters and distance tolerances were off.
- **Root Cause**: Everything else in the editor relies on rigid node transforms (local distances are document distances). An instance is the one node whose transform may scale and skew.
- **Solution / Workaround**: `vectorInstanceGroup` splits the instance's matrix with `decomposeRigid`: the rotation goes on the drawn group, the scale and skew are baked into the art (`transformVectorNode`), and strokes are multiplied by √|det| unless `scaleStrokes` is false. Everything downstream sees ordinary nodes. Anything that reads `nodeMatrix(instance)` directly (it is the full matrix) must go through `vectorInstanceDrawn` instead, as `vectorChildAppearanceShapes` and the overlay outline do.

### [core/vector] Isolation Mode Swaps the Controller's Document, So Snapshots Must Carry It

- **Issue / Symptom**: After leaving a symbol, Undo put the symbol's art in place of the whole document.
- **Root Cause**: Editing a symbol in isolation makes the controller's `doc` the art, so every command works unchanged; history snapshots taken there hold that art.
- **Solution / Workaround**: Snapshots keep the isolation context (`symbolEdit`, with the host document), and `restore` steps into or out of isolation with the view following (`viewInto` / `viewOutOf`). `toJSON`, `toSvg` and `onChange` compose the whole document (`storedDocument`). Entering and leaving are not undo steps themselves.

### [core/text] `r.pos += r.u16()` Reads the Old Position Before the Call Advances It

- **Issue / Symptom**: The OpenType reader drew garbage glyph outlines (points shifted and mixed on and off curve) for a valid TrueType font.
- **Root Cause**: In `x += f()` JavaScript reads `x` before calling `f`, so `r.pos += r.u16()` added the instruction length to the position from before the two-byte length was read, landing two bytes short.
- **Solution / Workaround**: Read into a local first (`const n = r.u16(); r.pos += n;`). Watch for the same pattern with any reader whose methods move a cursor.

### [core/vector] Text Lays Out with One Page-Wide Shaper, and Caches Key on It

- **Issue / Symptom**: After loading fonts (`setTextShaper`), text kept its old glyphs: expanded appearance, bounds and outlines were cached per node object, and the node objects had not changed.
- **Root Cause**: Geometry helpers (`vectorNodeBounds`, `expandVectorAppearance`, hit-testing) are pure functions of the node, with no editor to ask for fonts, so text reaches its shaper through a module-level setting (`setVectorTextShaper`). Every cache keyed only by node object went stale when it changed.
- **Solution / Workaround**: `setVectorTextShaper` bumps a generation that the appearance caches (`shapeCache`, `outlineCache`, `expandCache`) and the text caches store with each entry, and `controller.setTextShaper` also gives every text node a new object so views keyed on the document draw again. The shaper is shared by every vector editor on the page: set it once, before documents load where possible. Web fonts must be loaded before the Canvas shaper measures them, or the fallback's widths are cached.

### [core/vector] Text Without Glyph Outlines Draws as SVG Text but Has Box Geometry

- **Issue / Symptom**: With the browser's (Canvas 2D) shaper, path effects and envelopes on text did nothing visible, and hit-testing, snapping and bounds used rectangles rather than letter shapes.
- **Root Cause**: Canvas 2D measures and draws text but cannot give glyph outlines. Without outlines, text renders as SVG `<text>` (placed character by character from our layout, so it matches the measurements), and its geometry is a box per line fragment (a box per character on a path).
- **Solution / Workaround**: Effects need geometry to act on, so `vectorAppearanceShapes` skips a text node's effects while it has no outlines (they stay stored and apply as soon as an outline shaper is set). Create Outlines refuses with the reason. Hosts that need effects on text or font-independent SVG load font files (`loadOpenTypeFont`) into `createOutlineTextShaper`; the demo's "Load fonts…" button does this.

### [react|svelte/vector] The Hidden Textarea Must Not Forward Printable Keys, and Must Stop Its Events

- **Issue / Symptom**: Typing "v" into text switched to the Select tool, and typed characters were inserted twice.
- **Root Cause**: The canvas `<svg>` handles tool shortcuts on `keydown`, and the textarea sits inside it, so its key events bubbled to the canvas; forwarding every key to `controller.keyDown` also inserted characters that the textarea's `input` event delivers again.
- **Solution / Workaround**: The textarea stops propagation of its key and clipboard events, lets printable keys (no Cmd / Ctrl) through to the browser so they arrive as `input` (and as `compositionend` for IME), and forwards only editing keys and shortcuts to `controller.keyDown`, whose text mode handles them (and swallows other Mod shortcuts while editing). Keys typed while the canvas itself has focus are inserted by the controller.

### [core/video-editor] A Frame Cache Keyed by Clip Is Thrown Away by Every Edit

- **Issue / Symptom**: Keyed by clip and timeline frame, as a sequencer's final-frame cache is, every trim, slip or move invalidated frames whose pictures had not changed. Two clips cut from one shot each decoded it again.
- **Root Cause**: Timeline keys describe where a picture shows, not what it is.
- **Solution / Workaround**: `VideoFrameCache` keys raw source frames by the file the preview plays (the asset's `src`, or the proxy it picks) and the source frame on the project's fps grid. Grades, LUTs and compositing still happen at draw time. Each entry keeps the timeline time it is next needed at (refreshed in the prefetch window) for eviction only. Decode at the middle of a frame (`videoSourceFrameTime`) so rounding never lands on the frame before. While playing, the engine draws the `<video>` element; it uses cached frames only when paused, scrubbing or mid-seek, because a playing element is already current.

### [core/video-editor] Proxies Must Match the Original Frame for Frame, and Camera Files Seek Slowly

- **Issue / Symptom**: Scrubbing 4K camera footage in the preview lagged by seconds. A proxy made with a frame-rate change or a trimmed start played the wrong frames for every clip.
- **Root Cause**: Camera and phone H.264/HEVC often has a keyframe only every one to several seconds, so each seek decodes from the previous keyframe at full size. The preview seeks a proxy to the clip's source time, so a proxy is only correct when its timeline is identical to the original's.
- **Solution / Workaround**: `videoProxyFfmpeg` scales the video only. It keeps the frame rate and start, uses `-g`/`-keyint_min` 12 with `-sc_threshold 0 -bf 0` for cheap seeks, and keeps the sound so a video element can play both. The real-ffmpeg test checks size, keyframe count, duration and that the same moment shows the same picture. Proxies never reach `toVideoFfmpeg` or `toVideoEdl`.

### [core/video-editor] A LUT Cannot Be a Canvas or SVG Filter, and ffmpeg's `lut3d` Reads Only Files

- **Issue / Symptom**: There is no CSS or canvas `filter` for a 3D LUT, SVG filters have only per-channel tables and a 4 × 5 matrix, and `lut3d=file=https://…` (or a blob URL) fails in ffmpeg.
- **Root Cause**: A 3D LUT mixes all three channels non-linearly, which neither `feComponentTransfer` nor `feColorMatrix` can express. `lut3d` opens its `file` with the local file system, not ffmpeg's protocol layer.
- **Solution / Workaround**: The preview draws a LUT layer on a scratch canvas (`willReadFrequently`), runs `getImageData` through `applyVideoLutToPixels` (tetrahedral, like `lut3d=interp=tetrahedral`), then lays it on with the layer's opacity and blend. SVG frames use `videoLutSvgApproximation`: curves along the grey axis, then a least-squares matrix, exact for LUTs that are only curves or only a matrix. The `feComposite` that mixes by strength needs the pre-LUT picture as a named `result`. The export maps `src` to a path with `resolveLut` and notes URLs. A grade with only a LUT has an empty CSS filter: set `ctx.filter = 'none'`, since `''` is ignored and the last filter stays.

### [core/video-editor] Scopes Read a Stale Picture While a `<video>` Seeks, and Nothing From a Cross-Origin One

- **Issue / Symptom**: `get_video_scopes` at another time measured the frame the preview showed before the seek. With media from another origin, reading the preview canvas threw "The operation is insecure".
- **Root Cause**: After `currentTime` is set, a `<video>` keeps `readyState >= 2` and draws its old frame until `seeked` fires. A canvas that has drawn cross-origin media without CORS is tainted, and `getImageData` throws a `SecurityError`.
- **Solution / Workaround**: `VideoPreviewEngine` marks a frame incomplete while any media layer is missing or `seeking`, and `VideoPreviewPixels.next(time)` waits for a complete drawing of that time (or times out with a reason). Serve media with `Access-Control-Allow-Origin` (the engine sets `crossOrigin = "anonymous"`); `VideoPreviewPixels.read()` turns the `SecurityError` into a message that says so. Luma computed from equal channels can come out a hair under the value (39.99999…), so scope bins are nudged before flooring.

### [core/image-editor] AI Results Must Be Computed From the Composite When They Become Layers

- **Issue / Symptom**: Sending the original source image to an inpainting hook in a layered document would give a result that ignores everything painted on the layers above. Added as a new layer on top, it would then hide those edits inside the selection.
- **Root Cause**: `toSourceDataURL()` is the Background's source, which the old replace flow needed because the result replaced that source.
- **Solution / Workaround**: `toAIInputDataURL(options)` returns the source in replace mode and the composite without annotations (`renderSourceView({ includeAnnotations: false })`) in new-layer mode. The editors call it with the same target they pass to `applyInpaintedImage` / `applyBackgroundRemovedImage`.

### [core/image-editor] "Multi-Layer" for the AI Hooks Counts Pixel Layers and Groups Only

- **Issue / Symptom**: Counting every layer would switch old documents with adjustment layers or annotation scribbles to the new-layer behaviour, changing how inpainting worked for them.
- **Root Cause**: Since phase 1, adjustment layers and annotations are layers, but they were never separate images.
- **Solution / Workaround**: `isMultiLayer` counts pixel layers and groups. The UI shows which behaviour "Auto" will use, and `target` overrides it.

### [core/image-editor] Dirty Rectangles Are Only Safe on a Compositor That Sees One Stack

- **Issue / Symptom**: A design to recomposite only the dabs' rectangles during a stroke could leave stale pixels when the same compositor had meanwhile composited a different layer list (an export of chosen layers, `compositePixels`, a merge).
- **Root Cause**: The partial path copies the tile's previous result outside the dirty rectangle. That is only correct when the previous result was computed from the same stack, differing just inside the rectangle.
- **Solution / Workaround**: The viewport has its own `LayerCompositor`, and exports, `compositePixels`, merges and sampling use others. The controller's `pendingDirty` collects stroke rectangles and resets to `'all'` on any other change, so a render after, say, an opacity change never takes the partial path.

### [core/image-editor] A Stroke Must Recomposite From the Pre-Stroke Tile, Not the Last Live One

- **Issue / Symptom**: Compositing each new batch of dabs over the stroke's previous live result would paint overlaps twice, so strokes would go darker than their opacity.
- **Root Cause**: Stroke coverage is cumulative (build-up towards the opacity ceiling), and the stroke composites once at the stroke opacity. Compositing the coverage over pixels that already hold part of the stroke applies it again.
- **Solution / Workaround**: `PaintStrokeSession` keeps the pre-stroke surface. For each touched region it copies the pre-stroke pixels back into the live tile and composites the whole coverage there (`applyStrokeToTile` with `into` and `region`).

### [react|svelte/image-editor] Mice Report Pressure 0.5

- **Issue / Symptom**: Strokes drawn with a mouse would come out at half size with "pressure controls size" on.
- **Root Cause**: Pointer Events report `pressure` 0.5 for a pressed mouse button (and 0 for a pen on `pointerup`).
- **Solution / Workaround**: `pointerPressure` uses the reported pressure only for `pointerType === 'pen'` with a value above 0, and 1 otherwise.

### [core/image-editor] Merge Down Only Looks the Same Over an Opaque, 100 % Normal Lower Layer

- **Issue / Symptom**: Tests that expected Merge Down to leave the image unchanged failed: with a faded lower layer, or a Screen layer above a lower layer with transparent areas, the merged result looked different.
- **Root Cause**: Merging composites the upper layer onto the lower one in isolation and keeps the lower layer's opacity and blend. A faded lower layer then fades the merged content too, and the upper blend mode no longer sees the layers below the lower one where the lower one is transparent. Photoshop behaves the same way.
- **Solution / Workaround**: This is the intended behaviour. Test merges over an opaque, 100 % normal lower layer when you expect identical pixels, and check the other cases against the isolated composite. The image-editor skill tells agents the same.

### [core/image-editor] Compositing in Document Space Cannot Reproduce Every Old Render

- **Issue / Symptom**: Moving the image editor to a layer compositor that works in document space and projects afterwards changed some old documents by a level here and there: rotated by a non-quarter angle, cropped at fractional coordinates, depth-masked, faded with output opacity, or blurred with a crop or a 90° turn.
- **Root Cause**: The old renderer drew the cropped, rotated source first and adjusted the projected pixels; blur ran on that buffer (clamping at the crop edge, with its two passes swapped by a quarter turn) and the depth mask and opacity rounded alpha in a fixed order. Per-pixel operations commute with crops, flips and quarter turns, but not with resampling, and box blurs and repeated alpha rounding do not commute with each other.
- **Solution / Workaround**: Documents that still have the exact v1 / v2 shape (`isLegacyShape`) take the old base path in exactly those cases (`needsLegacyBase` in `layers/render.ts`; the list is in `docs/image-editor-layers.md`). Everything else uses the compositor. `tests/image-layers-equivalence.test.ts` requires byte equality for every random old document the compositor renders; when you change either path, keep that test green and add a routing case rather than accepting a difference.

### [core/image-editor] Consecutive Adjustment Layers Must Composite as One Float Pass

- **Issue / Symptom**: Rounding to 8 bits after every adjustment layer made migrated documents with several adjustment layers differ by one level in places.
- **Root Cause**: `applyAdjustmentLayers` evaluates the whole stack in float per pixel and rounds once at the end.
- **Solution / Workaround**: The compositor groups adjacent, unclipped adjustment layers into one step and calls `applyAdjustmentLayers` with all of them (masks as per-layer coverage planes). The prefix cache works per step, so its checkpoints sit at run boundaries.

### [core/image-editor] The Viewport Must Draw a Layered Document the Same Two-Step Way

- **Issue / Symptom**: At zooms other than 1, a few viewport pixels of a layered document differed by one level from the old render of the same pixels.
- **Root Cause**: The old path drew the rotated base canvas at scale 1, then scaled it into the viewport. Drawing the composite straight through rotation and scale in one `drawImage` samples differently on the GPU.
- **Solution / Workaround**: `layeredBase` in `renderer.ts` draws the composite into a cached base canvas through `baseProjection` (crop, rotation, flips at scale 1), then the viewport draws it with the same call the legacy path uses. Both paths are then identical at every zoom.

### [core/image-editor] Canvas PNG Round Trips Lose Partly Transparent Colours

- **Issue / Symptom**: Painted pixels with alpha below 255 came back with slightly different colours after saving layers as PNG through a canvas and loading them again.
- **Root Cause**: Canvas 2D stores premultiplied alpha, so `putImageData` / `toDataURL` / `getImageData` round colours of partly transparent pixels (and drop the colour of transparent ones). `toDataURL` is also the only synchronous canvas encoder, and there is none in Node or workers.
- **Solution / Workaround**: Layer assets use the TypeScript PNG codec in `raster/png.ts` (with `raster/zlib.ts`), which is exact, synchronous and DOM-free. Encodings are memoised per surface, so saving unchanged layers costs nothing.

### [core/tests] Failing `toEqual` on Large Typed Arrays Hangs Vitest

- **Issue / Symptom**: A deliberately broken compositor made an equivalence test run for minutes instead of failing.
- **Root Cause**: When `expect(a).toEqual(b)` fails on arrays of hundreds of thousands of elements, Vitest builds a full diff of them, which is very slow.
- **Solution / Workaround**: Compare large pixel buffers with a loop that throws at the first differing byte (`expectSameBytes` in `tests/image-layers-equivalence.test.ts`). Keep `toEqual` for small buffers.

### [core/image-editor] Lifting Stored Adjustments Must Keep a Missing `process` Legacy

- **Issue / Symptom**: Old documents without `process` loaded on process 2 after the move to layers, so they looked different and were re-saved with `process: 2`.
- **Root Cause**: `{ ...DEFAULT_ADJUSTMENTS, ...stored }` fills a missing `process` with the new default (the same trap as the process-version entry below).
- **Solution / Workaround**: `layersFromLegacy` normalises stored adjustments the way `normalizeStoredAdjustments` does: defaults only when nothing is stored, otherwise `process: normalizeProcessVersion(stored.process)`.

### [core/video-editor] Speed Ramps: Browsers Refuse Very Slow Rates, and ffmpeg Freezes Come From `fps`

- **Issue / Symptom**: The preview threw or ignored a freeze frame when it set a `<video>`'s `playbackRate` to 0. In the ffmpeg export, there was no obvious way to make one source frame last a second.
- **Root Cause**: Browsers only accept playback rates from about 1/16 up (Chrome throws below 0.0625). In ffmpeg, `setpts` can only move each source frame to a new time; it cannot repeat a frame.
- **Solution / Workaround**: `VideoPreviewEngine` treats any speed under 1/16 as frozen: it pauses the element and seeks it every tick, as when paused. The export uses `setpts` to move each source frame to the clip time the ramp first shows it (the ramp's inverse; frames inside a freeze are skipped), then `fps` repeats frames to fill slow stretches and freezes, and `tpad` holds the ends. Sound cannot be re-timed continuously, so it is cut into straight stretches, each with its own `atempo` (silence for freezes), and joined with `concat`.

### [core/video-editor] ffmpeg `geq` and `rotate` Freeze an Animated Size, and `rotate` Loses Transparency When Its Angle Moves

- **Issue / Symptom**: A clip with keyframed scale stayed at its first size in the ffmpeg export whenever it also had keyframed opacity, a wipe, an iris or a rotation. A clip with keyframed rotation rendered with an opaque box around it.
- **Root Cause**: `geq` and `rotate` set their frame size from the first frame, so a `scale=...:eval=frame` before them has its later sizes frozen. And with a time-varying angle, `rotate=...:c=none` fills the uncovered corners with opaque pixels (only a constant angle gets transparent ones). Both were hidden in tests by the frozen size: a smaller picture passed the same pixel checks.
- **Solution / Workaround**: The animated `scale` goes last in a clip's chain, after every `geq` and `rotate`, scaling by `iw` / `ih` (uniform scale and rotation about the centre commute, so the picture is the same). `rotate` uses `c=black@0`, which keeps the corners transparent for any angle. When a pixel test checks an animated size, also check it at a time when the size has changed.

### [core/video-editor] ffmpeg `blend` Is Not Symmetric, and the Input Order Differs by Mode

- **Issue / Symptom**: Overlay, hard-light, dodge, burn and soft-light layers rendered differently in the ffmpeg export from the browser preview, even though the mode names matched.
- **Root Cause**: `blend` takes a first ("top") and a second ("bottom") input, and the non-symmetric modes use them differently from CSS. Measured against the W3C compositing formulas: `overlay`, `hardlight` and `softlight` match when the backdrop (the composite) is the first input, but `dodge` and `burn` divide by their first input, so they match only when the layer comes first. ffmpeg's `softlight` uses a different formula in any order (up to about 10/255 off). `blend` also works per plane, so blending in YUV gives wrong colours.
- **Solution / Workaround**: `toVideoFfmpeg` converts both inputs to `gbrap`, puts the composite first except for color-dodge and color-burn, and adds a note for soft-light. To add a mode, measure it against the CSS formula in both orders before choosing (`tests/video-editor-ffmpeg.test.ts` has pixel checks).

### [core/video-editor] ffmpeg `loudnorm` Outputs 192 kHz Audio

- **Issue / Symptom**: A normalised export came out with 192 kHz sound, much larger than it should be, and some players or encoders refuse that rate.
- **Root Cause**: `loudnorm` upsamples to 192 kHz internally so it can measure true peaks, and it passes that rate on to whatever follows it in the graph.
- **Solution / Workaround**: Always follow it with `aresample=48000`, as `loudnormFilter` in `export.ts` does. Two-pass normalisation also needs the measuring pass to use the same target (`I`, `TP`, `LRA`) as the second pass; `toVideoLoudnessMeasure` takes the same `loudness` option for that reason.

### [core/video-editor] An Hour of 29.97 fps Is Not `01:00:00:00` in Non-Drop Timecode

- **Issue / Symptom**: With drop-frame turned off at 29.97 fps, an EDL's record timecode started at `00:59:56:12` instead of `01:00:00:00`.
- **Root Cause**: The record start was a clock time (3,600,000 ms). Non-drop timecode counts 30 labels a second while only 29.97 frames pass, so an hour of real time is 107,892 frames, which non-drop labels `00:59:56:12`. Drop-frame skips labels so that it matches the clock.
- **Solution / Workaround**: Count timecode positions in frames, not milliseconds: `videoHourFrames(fps, dropFrame)` gives the frame count of `01:00:00:00` (107,892 in drop-frame, 108,000 in non-drop), and `formatVideoTimecodeFrames` formats a frame count. Count frames at the exact NTSC rate (30000/1001), not a rounded 29.97.

### [core/video-editor] ffmpeg `afade` Curves Are Mirrored for Fade-Outs

- **Issue / Symptom**: Exponential fade-outs sounded different in the browser preview and in the ffmpeg export.
- **Root Cause**: `afade=t=out` applies the curve to the time *remaining*, gain = f(1 − progress); it does not flip the curve upside down to 1 − f(progress). For `cub`, a fade-out drops fast at first and then tails off.
- **Solution / Workaround**: `videoFadeCurveGain` takes the fraction left for a fade out, as ffmpeg does. The curve formulas were measured from ffmpeg itself (`tri`, `qsin`, `hsin`, `cub`, `ipar`), and `tests/video-editor-ffmpeg.test.ts` compares the rendered levels with `videoFrameAt`. When adding a curve, measure ffmpeg's version before writing the formula.

### [core/tools] `capture_view` Screenshots Miss Web Fonts, Pseudo-Elements and Cross-Origin Images

- **Issue / Symptom**: A canvas or DOM screenshot from `rasterizeElement` (used by `createCanvasCaptureToolProvider` and `createElementCaptureSurface`) shows text in a fallback font, leaves out `::before` / `::after` content, draws some images blank, or fails with "the canvas is tainted".
- **Root Cause**: The element is cloned with its computed styles inlined and drawn as an SVG `<foreignObject>` image. An SVG used as an image cannot load anything external, so web fonts and `<img>` URLs are not fetched; same-origin images are copied in as data URLs, cross-origin ones cannot be read. Pseudo-elements are not part of the DOM, so they are not cloned. Safari has tainted canvases that drew a `foreignObject`.
- **Solution / Workaround**: For pixel-exact output, pass `rasterize` to the surface options and use a library such as html-to-image (it embeds fonts) or a server-side renderer. Mark UI that should never show with `data-capture="exclude"` and transient overlays with `data-capture="overlay"`. Non-viewport canvas regions re-frame the xyflow viewport transform and remove everything outside it (the background pattern and screen-space layers follow the live viewport, so they would be misplaced).

### [core/video-editor] A Ripple Is Refused Because of a Music Bed or Title on Another Track

- **Issue / Symptom**: `delete_clips` / `trim_clip` with `ripple`, or `extract_range`, fails with "Rippling out … would pull track "a1" out of sync: clip "music" … is in that stretch", even though the edited track itself has room.
- **Root Cause**: Tracks are sync-locked by default (`syncLocked` unset = true). A ripple moves every unlocked sync-locked track by the same spans (merged across tracks, closed right to left), so nothing drifts out of sync. Closing time where another sync-locked track still has a clip would have to delete part of that clip, so it is refused instead. Opening time (insert, ripple trims that lengthen) never refuses: it cuts the clips across the edit point on those tracks, which is why `insert` leaves `music-1` style right-hand parts behind.
- **Solution / Workaround**: Turn `syncLocked` off on a track that should stay put (a music bed), lock it, put it in the range edit's `tracks`, or lift instead of rippling. Tests with a long music clip under a rippled cut must do one of these. A property test that inserts then extracts the same range compares tracks with continuing cuts joined up (the split parts stay split), and exactly only when nothing ran across the insert point.

### [svelte/video-editor] Shift-Dragging a Clip Overwrites Only When Shift Is Pressed After the Drag Starts

- **Issue / Symptom**: In the Svelte timeline, holding Shift before pressing on a clip adds it to the selection and the drag does nothing; overwrite only happens if Shift is pressed once the clip is moving.
- **Root Cause**: Svelte's `onclipdown` treats Shift / Cmd / Ctrl at pointer-down as additive selection and turns editing off for that gesture. The placement mode (Alt = insert, Shift = overwrite) is read from each pointer-move, so a modifier held from the start never reaches a drag.
- **Solution / Workaround**: Press Shift after the drag has started (tests send `shiftKey` on the move and up events only). React reads the modifiers on move and up too, so the same gesture works in both.

### [core/video-editor] Keyframed Clip Values Are Not Numbers, and ffmpeg's `t` Means Two Things

- **Issue / Symptom**: Code that reads `clip.opacity ?? 1`, `clip.volume` or `clip.transform.x` and does arithmetic gets `NaN` or `[object Object]` once a property is keyframed. In the ffmpeg export, an animation lands early or late by the clip's start or by its transition lead.
- **Root Cause**: `opacity`, `volume` and the transform's fields are `number | { keys }` (`VideoAnimatable`), with key times in clip time (ms from the clip's start). In the filter graph, `t` / `T` on a clip's own chain (`scale`, `geq`, `rotate`, the audio `volume`) counts from the clip's first rendered frame, which is `start − lead` when a transition plays before the cut; on `overlay` and `drawtext`, which run on the composite, it is timeline time.
- **Solution / Workaround**: Always read these through `videoValueAt(prop, clipTime, default)` (or `videoTransformAt`). In the export, convert with `(t*1000-lead)` on the clip chain and `(t*1000-start)` on the composite (`onChain` / `onTimeline` in `toVideoFfmpeg`). Do not use `st()` / `ld()` in `geq` expressions: slice threads share the variables. A title drawn as an image (`titleImage`) gets the clip without its transform when the transform is keyframed, and the export moves the full-frame image instead.

### [core/video-editor] Homebrew's ffmpeg Has No `drawtext`

- **Issue / Symptom**: Rendering a project with titles fails at once with `Filter not found`, although every other filter in the graph exists.
- **Root Cause**: `drawtext` needs ffmpeg built with libfreetype. Homebrew's `ffmpeg` formula (9.x) is built without it, and so are other slim builds.
- **Solution / Workaround**: Pass `titleImage` to `toVideoFfmpeg`. Each title then goes in as a transparent full-frame PNG, overlaid like a still with its opacity and fades. In a browser, draw `videoTitleFrame(project, clip)` with `drawVideoFrame` and save the canvas. The export's notes mention `drawtext` whenever it is used. `tests/video-editor-ffmpeg.test.ts` checks `ffmpeg -filters` and falls back to a title image.

### [react|svelte/video-editor] A Clip Dragged to Another Track Loses Its Pointer Capture

- **Issue / Symptom**: Dragging a clip into another track's row stopped following the pointer, and releasing it did nothing.
- **Root Cause**: The clip block is rendered inside its track's row. Once the drag preview moves it to another row, the framework remounts the block under a new parent, so the element that called `setPointerCapture` is gone and its `pointermove` / `pointerup` handlers never fire again.
- **Solution / Workaround**: Follow the drag with `pointermove`, `pointerup` and `pointercancel` listeners on `window`, added at pointer down and removed on release, instead of handlers on the clip element.

### [react|svelte/video-editor] Testing `<VideoPreview>` in jsdom

- **Issue / Symptom**: Preview tests log "Not implemented: HTMLCanvasElement.prototype.getContext" and "Not implemented: HTMLMediaElement's pause()" / "load()", and nothing can be asserted about drawing.
- **Root Cause**: jsdom implements neither canvas drawing nor media playback.
- **Solution / Workaround**: `VideoPreviewEngine` accepts a null context and injectable `createMedia` / `context`. In component tests, stub `HTMLCanvasElement.prototype.getContext` (null, or a recording Proxy to assert draws) and `HTMLMediaElement.prototype.pause` / `load`. In Svelte, don't put `role="img"` on the `<canvas>` (svelte-check treats canvas as interactive); an `aria-label` is enough.

### [core/video-editor] ffmpeg `drawtext` Text Needs Escaping Twice

- **Issue / Symptom**: A title with a colon, apostrophe or comma (`It's 10:30, live`) breaks the ffmpeg render with "No option name near…" or a truncated title, even though the args are passed without a shell.
- **Root Cause**: A filtergraph is parsed at two levels: the graph splits on `,` `;` `[` `]` and quotes, then each filter splits its options on `:` and drawtext expands `%`. Each level consumes one layer of backslashes.
- **Solution / Workaround**: Escape option-level characters (`\ ' : %`) first, then graph-level characters (`\ ' [ ] , ;`) — `ffmpegFilterValue` does both in that order. Do not add shell quoting on top when passing `args` to `spawn`; only `command` (the one-line string) is shell-quoted.

### [core/video-editor] A Dip Must Not Use Handles, or Valid Cuts Are Refused

- **Issue / Symptom**: Setting a dip-to-black between two clips trimmed to the very ends of their media was refused for lack of handles, and the preview played a moment of the next clip's audio before the cut.
- **Root Cause**: Crossfades and wipes play both clips past the cut (half the transition each side), so they need media beyond the out and in points. A dip only shows the outgoing clip before the cut and the incoming one after it, under the colour, but the shared overhang code treated it like a crossfade.
- **Solution / Workaround**: `videoClipOverhang`, `checkVideoProject` and the ffmpeg export treat a dip as needing no handles, and `videoFrameAt` skips the hidden half of each clip for pictures and sound. Any new transition type must decide which side of the cut each clip plays on and update all of these together.

### [core/video-editor] Snapping a Moved Clip Must Ignore the Edge That Did Not Snap

- **Issue / Symptom**: Dragging a clip so its end lands near another clip's start did not snap; the clip stayed exactly where the pointer left it.
- **Root Cause**: `planVideoClipDrag` snaps both the head and the tail and keeps whichever moved the clip less. An edge with no snap point nearby "moves" it by 0, so it always won.
- **Solution / Workaround**: Only edges that actually snapped (a non-zero shift) compete; with none, the raw position is kept.

### [svelte] A Local Named `state` Breaks `$state` Runes in the Same Component

- **Issue / Symptom**: `svelte-check` reports "Cannot use 'state' as a store. 'state' needs to be an object with a subscribe method" on every `$state(...)` call in a component, although the runes work at runtime and in tests.
- **Root Cause**: In a component with a top-level variable `state`, Svelte reads `$state` as a store auto-subscription to that variable instead of as the rune.
- **Solution / Workaround**: Don't name a component-level variable `state` in a component that uses `$state`. The animation-editor panels call the controller snapshot `editor` (`const editor = $derived(view.current)`). Older components that never use the rune, such as `ShotTimeline.svelte`, can keep `state`.

### [react|svelte/animation-editor] A Panel's Own Error Hides the Controller's Newer One

- **Issue / Symptom**: A panel showed "Effect needs a target…" (its own validation message) after a later edit was refused by the controller, so the newer, real reason never appeared.
- **Root Cause**: The panels show `localError ?? state.error`. A local message set before the refusal is never cleared, so it keeps winning.
- **Solution / Workaround**: Store the local message with the controller's `revision` at the time and show it only while `state.revision` is unchanged. Any change to the editor, including a refusal (which bumps the revision), hands the line back to `state.error`.

### [core/animation-editor] Flair Catalog Presets Hold Colours as `[r, g, b]` Arrays

- **Issue / Symptom**: Scenes imported from real Flair catalog effects (`checkbox`, `bookmark`…) had presets whose values were arrays like `[0.13, 0.7, 0.4]`, although `MotionPreset.values` expects colour strings.
- **Root Cause**: Flair's `EffectPreset.values` are `ControlValue`s. For colour controls these are channel arrays from 0 to 1, which Flair turns into hex with `rgbToHex`. The editor's mirror type assumed hex strings.
- **Solution / Workaround**: `fromFlairVectorEffect` converts arrays the same way Flair does: each channel is clamped to 0–1, multiplied by 255, rounded and written as hex. `FlairVectorEffect.presets` now types both forms.

### [core/agent-caret] Typing an Agent Edit Out Frame by Frame Breaks Undo Unless the Frames Stay Out of History

- **Issue / Symptom**: Dispatching an agent's text a few characters at a time left one undo step per frame, or merged the frames with whatever the user typed in the same half-second.
- **Root Cause**: `prosemirror-history` records every transaction unless it has `addToHistory: false`, and it groups adjacent ones by time (`newGroupDelay`, 500 ms). It has no way to group a set of transactions by their source.
- **Solution / Workaround**: `typeAgentText` dispatches frames with `addToHistory: false` (and `TRACK_CHANGES_SKIP_META`). At the end it rolls them back by applying the frames' inverted steps, then dispatches the whole edit once with history. Both dispatches happen in the same tick, so the screen never shows the rollback. If someone else edited while the agent typed (the plugin marks its span `foreign`), it replaces the typed span with the original slice instead. Also, a transaction holds only one meta per plugin key, so the typed span and the caret are set in separate transactions.

### [demo] An Agent Cursor Animated With `requestAnimationFrame` Hangs in a Hidden Tab

- **Issue / Symptom**: A scripted agent run (the demo's "Ask the agent" panel) stopped partway with its buttons disabled when the page was in a background tab or a hidden preview pane.
- **Root Cause**: The cursor glide awaited a promise resolved from a `requestAnimationFrame` loop, and browsers do not run animation frames for hidden documents, so the promise never settled and the next tool call never ran.
- **Solution / Workaround**: Jump straight to the target when `document.hidden`, and also resolve the glide from a `setTimeout` a little after its duration (as Ursula's director skips animation in hidden tabs). Never make agent tool calls wait on animation frames alone.

### [react|svelte/chart] Inline SVG Colours Must Use `var(--x, fallback)`, Not shadcn's `hsl(var(--x))`

- **Issue / Symptom**: A chart theme written as `hsl(var(--foreground))` drew black text and invisible grid lines in the demo.
- **Root Cause**: The demo (and the other components' inline styles) define `--foreground`, `--border`, `--primary`, … as full colours (`rgb(...)`) plus `--x-rgb` channels for Tailwind. Only shadcn's own CSS stores bare HSL channels, so `hsl(var(--x))` is invalid everywhere else. SVG presentation attributes also don't reliably resolve `var()`.
- **Solution / Workaround**: `CSS_VARIABLE_CHART_THEME` uses `var(--foreground, #0f172a)`-style values (as `SpreadsheetEditor` does), and the canvases put colours in `style`, not `fill=` / `stroke=` attributes. The demo defines `--muted-foreground` for it.

### [svelte] `bind:clientWidth` Throws in jsdom Tests

- **Issue / Symptom**: Every Svelte test mounting `ChartCanvas` failed with `ReferenceError: ResizeObserver is not defined`.
- **Root Cause**: Svelte implements `bind:clientWidth` with `ResizeObserver`, which jsdom does not provide, and the binding runs even when the measured width is unused.
- **Solution / Workaround**: Observe the element in an `$effect` guarded by `typeof ResizeObserver === "undefined"` (as the React canvas does) and fall back to the `width` prop.

### [core/chart] `load()` Keeps the Undo Stack, So Undo Can Bring Back the Old Chart

- **Issue / Symptom**: In the demo, loading a sample chart and pressing Undo replaced the sample with the previous chart from before an earlier drag.
- **Root Cause**: Edits record before / after snapshots of the whole spec; `load` swaps the spec without an undo step, so the next undo applies an older snapshot.
- **Solution / Workaround**: Call `load(spec, { clearHistory: true })` when it replaces the whole document (opening a file, switching samples). Without `clearHistory`, use it only to refresh the chart with equivalent data.

### [core/vector] `fill` / `stroke` Mirror the Top Layer of a Stack, and Code That Spreads a Node Edits That Layer

- **Issue / Symptom**: After paint stacks (`fills` / `strokes`) landed, a node copied with `{ ...node, fill: x }` or `{ ...rest, stroke: null }` either lost the change (the stack won and put the old paint back) or kept stale layers (Outline Stroke's outline node inherited every fill of the source).
- **Root Cause**: A stacked node stores its paint twice: the stacks are the truth and `fill`, `stroke` and the stroke settings mirror their top layers, so the dozens of places written for one fill and one stroke (booleans, blends, the gradient tool, the width tool, agent commands) keep reading and writing something sensible. A spread copies both, and only one side gets changed.
- **Solution / Workaround**: `normalizeVectorPaintStacks` reconciles the two. The controller runs it in `refreshed()` (every `notify` and `commit`) with `prefer: 'shorthand'`: a shorthand that no longer matches its top layer is an edit of that layer, and `null` clears the stack. Loading (`new VectorEditorController({ document })`, `setDocument`, SVG import) uses `prefer: 'stack'` instead. New code that rebuilds a node for a different purpose (an outline, a copy without strokes) must set the stacks explicitly with `withVectorFills` / `withVectorStrokes` rather than spreading, and code that edits a layer other than the top goes through `withVectorTargetPaint` or the `*PaintLayer` methods. Stacks of one plain layer are stored as the shorthand, so old documents stay byte-identical.

### [core|react|svelte/vector] Layer Blend Modes Only Mix Inside a Node That Has a Filter, Opacity or Blend Mode

- **Issue / Symptom**: A fill layer set to `multiply` darkened the artwork below the shape, until the shape got a drop shadow (or node opacity below 1, or its own blend mode); then it only darkened the shape's own lower fills.
- **Root Cause**: `mix-blend-mode` blends with everything painted before it inside the nearest isolated group. SVG `filter`, `opacity < 1` and `mix-blend-mode` on the node's `<g>` each make that group isolated, so the backdrop is no longer visible to the layers inside.
- **Solution / Workaround**: This matches how Figma and Illustrator treat layer blending inside an object with effects, so it is kept and documented (skill pitfalls). Don't wrap every node in a `<g>` "to be safe": the canvases and export only emit the group (`VectorRenderPath.layers`) when the node needs layers, and put a node's blend mode and filter on that element.

### [core/vector] Inner Shadows Need the Inverted Alpha Padded by the Filter Region, and Blur Radius Is Twice the Deviation

- **Issue / Symptom**: An inner shadow showed a hard line along one side of the shape, and a "4 px" blur looked twice as soft as in CSS or Figma.
- **Root Cause**: The inner shadow is the inverse of the silhouette (`feComponentTransfer` alpha `1 0`), offset, blurred and clipped back to the shape. The inverse only exists inside the filter region, so when the region ends close to the shape the offset pulls the region's transparent edge in. CSS `blur()` / `box-shadow` and Figma take a radius whose standard deviation is half of it; `feGaussianBlur` takes the deviation.
- **Solution / Workaround**: `vectorFilterSvg` uses `filterUnits="userSpaceOnUse"` with the region padded by `vectorFilterReach` (offset + 1.5 × blur + spread for every shadow and glow, inner ones included, plus layer blurs) around the node's paint bounds (`vectorNodeLocalPaintBounds`: geometry plus stroke reach), and writes `stdDeviation = blur / 2`. The region is in the node's own space, so it follows rigid transforms and zoom.

### [core/vector] SVG Filters Are Approximate Outside Browsers, and Background Blur Cannot Be Exported

- **Issue / Symptom**: Exported shadows look slightly different (or are missing) in some SVG tools, and there is no background blur filter.
- **Root Cause**: Renderers differ in filter support: `feMorphology` (spread, feather) and `color-interpolation-filters` are commonly ignored or approximated, and `mix-blend-mode: plus-lighter` (linear dodge) is newer than the other modes. A background blur needs the pixels behind the node; SVG's `BackgroundImage` input was never implemented by browsers, and CSS `backdrop-filter` does not apply to SVG elements.
- **Solution / Workaround**: Export writes the filter as drawn plus `data-vector-filters` (the stack as JSON) on the `<filter>`, so our own import is lossless; foreign imports read `feDropShadow` and a lone source `feGaussianBlur` back as filters and skip anything else. Background blur is left to the planned lens objects. Tell users (the skill does) to rasterize when a design must look identical everywhere.

### [core|react|svelte/vector] A Filter and a Clip on One SVG Element Clip the Shadow Away

- **Issue / Symptom**: A clip group with a drop shadow showed no shadow outside the clip, and an opacity-masked group's glow was cut to the mask.
- **Root Cause**: SVG applies an element's `filter` first, then `clip-path` / `mask`, then `opacity`. With the filter and the clip on the same `<g>`, the shadow is drawn and then clipped by the same shape that made it.
- **Solution / Workaround**: A mask group draws as two groups: the outer `<g>` carries the transform, opacity, blend mode and filter, and an inner `<g data-vector-masked>` carries `clip-path` / `mask` around the contents (`VectorRenderGroup.mask`, `VectorMaskedNodes`, `emitMaskGroup` in `svg.ts`). The filter region comes from the group's paint bounds, which include the unclipped contents, so it is big enough. Import of foreign SVG keeps the element's own filter on the inner node, which matches SVG's order.

### [core/vector] `<clipPath>` Holds Only Shapes, and an Inverted Clip Needs the Union of the Mask

- **Issue / Symptom**: A clip whose mask was a group (or had path effects) clipped everything away; an inverted clip of two overlapping circles left their overlap visible.
- **Root Cause**: A `<clipPath>` may contain shapes, text and `<use>`, not `<g>`; browsers ignore the group and the clip becomes empty. An even-odd "rectangle with the mask cut out" counts overlapping areas twice, so they flip back to shown, and a nonzero shape read even-odd loses its self-overlaps.
- **Solution / Workaround**: `vectorMaskRegionShapes` flattens the mask into one path per drawn shape in the group's space (each with its own `clip-rule`). The inverted clip (pdfcraft's `clip_out`) is one even-odd path: a rectangle round the contents plus the boolean union of those shapes (`vectorMaskRegionPath`), whose contours never overlap. For import, the mask itself is kept in a hidden `<g data-vector-part="mask-source">`, because the flattened `<clipPath>` loses its paint, effects and structure.

### [core/vector] Masks Render Differently Outside Browsers: `mask-type`, Luminance Space and Inverted Masks

- **Issue / Symptom**: An exported alpha mask hid everything (or showed a dark mask as transparent) in some SVG tools, gradient opacity masks faded at a different rate, and inverted opacity masks were missing.
- **Root Cause**: `mask-type="alpha"` is newer than `<mask>`; renderers that ignore it treat every mask as luminance, and a white-filled alpha mask is then fine but a dark one hides. Browsers compute luminance in sRGB but some renderers honour `color-interpolation="linearRGB"`, which changes how a gradient mask ramps. SVG has no inverted mask, so it is drawn through an `feColorMatrix` filter (`1 − alpha`, or brightness over black, inverted), and renderers with weak filter support drop it. A `<mask>` without `maskUnits="userSpaceOnUse"` only covers the masked element's bounding box plus 10 %, and an inverting filter only inverts inside its own region.
- **Solution / Workaround**: Masks and inverting filters use `userSpaceOnUse` regions over the contents' paint bounds plus a margin (`vectorMaskContentBounds`). Clipping masks are the portable choice; prefer luminance masks with white-to-black fills when an SVG must look right everywhere, and rasterize when it must be identical. Our own import is lossless either way (`data-vector-mask` carries the settings).

### [react/vector] Filter Primitives Built with `createElement` Need Camel-Cased Presentation Attributes

- **Issue / Symptom**: The console showed "Invalid DOM property `flood-color`. Did you mean `floodColor`?" for every drop shadow and inverted luminance mask, although they drew correctly.
- **Root Cause**: `VectorRenderFilter` primitives carry SVG attribute names (`flood-color`, `flood-opacity`) so Svelte and the SVG export can write them as they are. React maps SVG presentation attributes from camel-cased props and warns on the hyphenated spelling.
- **Solution / Workaround**: React's `VectorFilterDefs` camel-cases hyphenated keys before `createElement` (`flood-color` → `floodColor`); the core data keeps SVG names. A React test spies on `console.error` while rendering a filter. React reports each such warning once per page, so check with a fresh render, not by reloading a page whose console already showed it.

### [core/vector] The First Child Is the Mask, So Deleting or Reordering It Changes What Masks

- **Issue / Symptom**: Deleting a clip group's mask turned the bottom content shape into the new clip, and Send to Back inside a mask group swapped the mask.
- **Root Cause**: The model has no mask flag on the child: a mask group's first child is its mask (figcraft's `is_mask` masks the siblings above it instead).
- **Solution / Workaround**: `removeNodes` (delete, cut) clears `mask` on a group whose mask it removes, so the contents draw whole. Reordering inside a mask group is allowed and documented (it is how a different object becomes the mask); Make Clipping Mask moves the chosen mask to the bottom, and Release puts it back on top.

### [core/vector] Merging Faces by a Boolean Union of Their Outlines Leaves Seams

- **Issue / Symptom**: Shape Builder merges built by uniting the faces' own outlines can leave a hairline gap or a spur along the edge two faces shared, and a merged shape whose faces only touched at a corner could come out with a sliver.
- **Root Cause**: Each face's outline is rebuilt separately (pieces joined back into exact sub-curves), so two faces' copies of a shared edge or corner are not guaranteed to be bit-identical; the union then sees two nearly coincident edges instead of one.
- **Solution / Workaround**: `PlanarMap.merge` traces the union along the map's own half-edges: an edge whose two sides are both merged faces is skipped, so shared edges drop out exactly (vectorcraft's `Map::merge`). Covering shapes that lose faces are rebuilt the same way from the faces they keep, never by subtracting the merged shape. Pathfinder operations use one arrangement for all results (`pathBooleanSelect`) for the same reason.

### [core/vector] Islands Must Be Nested per Face, Not by an Even-Odd Rule Over the Network

- **Issue / Symptom**: With three nested squares, a fill of the outer ring that takes every island inside its loop as a hole (as cadcraft's `islands` does) also cuts out the innermost square, a hole inside a hole; figcraft's `faces` notes the same weakness for crossing networks.
- **Root Cause**: Taking every group of curves inside the traced loop as a hole (cadcraft's `islands`) or classifying faces with an even-odd test over the whole network ignores which face an island actually sits in.
- **Solution / Workaround**: The face walk gives each connected piece's outer boundary (a clockwise cycle); `PlanarMap` makes it a hole only of the smallest face of *another* piece around it. `regionAt` traces the loop from the ray as cadcraft does, then takes that face's holes. Adjacency lives in per-vertex angle-sorted lists with half-edge slots, so a walk step is O(1) instead of figcraft's scans over all segments.

### [react|svelte] Binding Tests Use the Built Core: Rebuild It After Changing Core State

- **Issue / Symptom**: After adding a field to `VectorOverlayRenderData`, every React and Svelte vector test failed with `Cannot read properties of undefined (reading 'map')`, including tests that never touched the new feature.
- **Root Cause**: The bindings import `@pixerate/editor/vector`, which resolves to `packages/core/dist`; the canvases read the new field from a stale build that does not produce it.
- **Solution / Workaround**: Run `pnpm --filter @pixerate/editor build` (or `pnpm build`) before running binding tests after core changes.

### [core/vector] Unioning a Variable-Width Stroke Piece by Piece Is Quadratic

- **Issue / Symptom**: Building a tapered stroke as effectcraft does — a trapezoid per flattened segment plus a wedge per bend, unioned non-zero — took 86 s for a 120-wiggle pencil line, and the polygon boolean's winding pass alone was O(edges²).
- **Root Cause**: Every piece overlaps its neighbours, so the overlay sees thousands of crossings, and `buildOverlay` cast each edge's ray against every other edge.
- **Solution / Workaround**: `variableStrokeRings` emits the boundary the pieces add up to (winding numbers add, so the non-zero fill is identical): offset sides, the join on the outer side, and on the inner side the point where the two offsets cross (that corner is covered by both trapezoids) or, when they don't cross, a detour through the centre point. Never normalise the orientation of those rings (a closed path's inner ring must stay reversed). `polygonBoolean` now bands edges along the ray axis. Very wide strokes on tight zig-zags still self-overlap heavily (seconds for extreme cases); render data is cached per node object (`vectorStrokeSvgParts`) so it is only rebuilt when the node changes.

### [core/vector] A Pen Reports Zero Pressure on `pointerup`

- **Issue / Symptom**: Pencil strokes drawn with a pen always ended in a pinched tip.
- **Root Cause**: `PointerEvent.pressure` is 0 on `pointerup` (and for buttons released), and `pointerUp` replays the last position through `pointerMove`.
- **Solution / Workaround**: `pointerUp` drops `pressure` from the input it replays, and the pencil keeps the last pressure for points without one. A mouse reports 0.5 while a button is down, so recording is limited to `pointerType === 'pen'` unless `pencilPressure: 'all'`.

### [core/vector] Width Profiles Must Follow Path Reversal and Mirroring

- **Issue / Symptom**: After Reverse Path or a flip, a one-sided or tapered stroke moved to the other end or the other side.
- **Root Cause**: Profile positions are fractions along the path and sides are relative to its direction; reversing changes both, mirroring swaps left and right.
- **Solution / Workaround**: `reversePaths` applies `reverseWidthProfile` (t → 1 − t, sides swapped) and `bakeIntoGeometry` applies `mirrorWidthProfile` when the matrix has a negative determinant.

### [core/vector] Knife Cuts: a Thin Strip Leaves Slits, and Gap-Free Chords Need Care Around Holes

- **Issue / Symptom**: Cutting a shape by subtracting a thin stroke of the knife line (as vectorcraft does with a 0.05 pt strip) leaves the pieces apart by that width, visible at high zoom and wrong for exact geometry; cutting a ring once with exact chords produced a stray "hole" piece, and the next cut started at the previous cut's end point.
- **Root Cause**: Any strip has width. With exact chords instead, a chord from the outline into a hole does not separate anything — it merges the two loops — and after a split both new loops contain the chord, so the knife's own segments lie on the boundary and its exit point is found again as a crossing.
- **Solution / Workaround**: `knifePath` (`vector/pathCut.ts`) splits one loop per chord into two loops that share it, or joins an outline and a hole into one loop with a zero-width slit; faces are regrouped by loop orientation, and holes are placed by a sample point *off* the chord segments (chords lie on two loops). Crossings are recomputed per face after each cut, only beyond the knife position of the last cut (a cursor), and collinear overlaps are not crossings, so the chord the knife just made is never hit again.

### [core/vector] Deleting a Point: Passing Through It Is a Worse Fit Than the Least-Error Cubic

- **Issue / Symptom**: Healing a deleted point with a curve forced through it (figcraft's `heal_handles`) kept the point but bulged away from the old outline — on an S-curve the new curve strayed 30 units against 2.6 for a least-squares fit.
- **Root Cause**: Two cubics meeting at a point rarely equal one cubic through that point; forcing the pass-through spends the curve's two degrees of freedom on one point instead of the whole outline.
- **Solution / Workaround**: `removeAnchorKeepingShape` samples both old segments and fits one cubic with the neighbours' tangents, searching (golden section) for the parameter where it passes the joint. `removeRedundantPoints` uses the same search: plain chord-length parameters with Newton steps could not get under 0.05 units even for two exact halves of one cubic.

### [core/vector] Snap Guides at 90° Need Exact Axis Directions

- **Issue / Symptom**: A pen point placed straight below the previous one landed at `x = -6.1e-15` instead of `0`, failing exact comparisons and leaving near-zero noise in the saved document.
- **Root Cause**: Construction guides are built from `cos` / `sin` of their angle, and `Math.cos(Math.PI / 2)` is `6.1e-17`, not 0. Projecting onto that "vertical" direction moved the point off its anchor's x by the residue times the distance.
- **Solution / Workaround**: `construction` in `vector/snap.ts` rounds direction components below `1e-12` to exactly 0, and slides compute the coordinate of the line they land on directly (`x: l.v`) instead of `at + dir * s`. Do the same for any angle-derived direction that should be axis-aligned.

### [core/vector] Gather Snap Targets Before the Gesture Changes the Document

- **Issue / Symptom**: A shape being drawn snapped to its own growing bounds, and Alt-duplicating during a move snapped the copy to nothing where the originals stood (or to itself).
- **Root Cause**: Targets are gathered once per gesture from a document snapshot. The shape tool adds the new node on press, and Alt-drag swaps the drag's base document for one with duplicates, so targets taken from the wrong snapshot include (or exclude) the wrong nodes.
- **Solution / Workaround**: The shape tool gathers drawing targets *before* inserting its node and keeps them on the drag; a move drops its targets when it duplicates, so the next move gathers them again excluding the new selection (the originals become targets). The anchor drag excludes the moving anchors and the segments through them, and the handle drag excludes its path's bounds and segments, which move with the pointer.

### [core/vector] The "Nearest Rotation" of a Mirrored Matrix Is Undefined

- **Issue / Symptom**: Flipping a rotated vector shape made its selection box snap back to axis-aligned (the rotation was lost and everything was baked into the anchors).
- **Root Cause**: Node transforms are kept rigid by splitting a matrix into a rotation and a residual. The rotation came from `atan2(b − c, a + d)`, which is the closest rotation only for matrices with a positive determinant. For a mirrored matrix such as `R(30°)·diag(−1, 1)` both terms are 0, so the angle came out as 0.
- **Solution / Workaround**: `matrixRotation` uses `atan2(−b − c, d − a)` when `det < 0` (the rotation left after undoing a horizontal flip) and lets the residual carry the reflection. Shapes keep their angle through flips.

### [svelte] A Local Variable Named `state` Breaks `$state()` in the Same Component

- **Issue / Symptom**: `svelte-check` reports `Cannot use 'state' as a store. 'state' needs to be an object with a subscribe method on it` on a line like `let svg = $state();`, in a component that also has `const state = $derived(...)`.
- **Root Cause**: In Svelte, `$name` is store auto-subscription syntax. When a binding called `state` exists in the component's scope, the compiler reads `$state(...)` as "subscribe to the store `state`" instead of the `$state` rune.
- **Solution / Workaround**: Never name a component-level binding `state` (or `derived`, `effect`, `props`). The vector components call the controller snapshot `view` (`const view = $derived(store.current)`).

### [core/vector] Gestures Applied Live Must Still Report the Change When Committed

- **Issue / Symptom**: `VectorEditorController`'s `onChange` did not fire for programmatic edits (`addShape`, `align`, …) even though the document changed and undo worked.
- **Root Cause**: Edits (and drags) update `this.doc` first and are then recorded with `history.execute(command)`, whose `execute()` restores the "after" snapshot. Because that snapshot is already the current document, the restore saw no difference and skipped `onChange`.
- **Solution / Workaround**: `commit()` sets a `committing` flag around `history.execute` so `restore()` reports the document change once. Any controller that applies a change before recording it needs the same care.

### [react/svelte vector] Wheel Zoom Needs a Non-Passive Native Listener

- **Issue / Symptom**: Ctrl/Cmd+wheel over the vector canvas zoomed the whole browser page (or scrolled it) instead of the drawing, and `preventDefault()` logged "Unable to preventDefault inside passive event listener".
- **Root Cause**: React registers `onWheel` as a passive listener, and browsers treat wheel listeners on the document as passive by default, so they cannot cancel scrolling or pinch-zoom.
- **Solution / Workaround**: Attach the wheel handler in an effect with `element.addEventListener('wheel', handler, { passive: false })` (React `useEffect`, Svelte `$effect`) and call `preventDefault()` there.

### [canvas/freehand] Freehand Stroke Endcaps Stripped on Node Creation & Single-Point Dot Disappearance

- **Issue / Symptom**: When drawing freehand strokes with pen or highlighter tools on the canvas, endcaps appear rounded/square during live drag preview, but become square/flat or completely disappear (for single-point clicks/dots) after releasing the mouse pointer.
- **Root Cause**: `CanvasDrawLayer` was rendering the live `<path>` with `strokeLinecap={draw.activeStroke.style.cap ?? 'round'}`. However, `strokeToShapeNode` in `@pixerate/editor` was not copying `strokeLinecap` or `strokeLinejoin` into `node.data.shape`. Additionally, `ShapeNode.tsx` (React) and `ShapeNode.svelte` (Svelte) were not passing `strokeLinecap` or `strokeLinejoin` down to the rendered `<path>`. In SVG, zero-length or micro-length paths (`M x y L x+0.01 y`) used for dots require round or square linecaps to have visible area.
- **Solution / Workaround**:
  1. In `strokeToShapeNode`, forward `strokeLinecap: stroke.style.cap ?? 'round'` and `strokeLinejoin: stroke.style.join ?? 'round'`.
  2. In `ShapeNode` (React and Svelte), bind `strokeLinecap={render.strokeLinecap}` and `strokeLinejoin={render.strokeLinejoin}` (or `stroke-linecap` / `stroke-linejoin`).

### [canvas/gradients] SVG Linear and Radial Gradient Rendering in Shape Nodes and Live Drawing Layers

- **Issue / Symptom**: Setting `fill` or `stroke` to a gradient definition (linear or radial) renders black or transparent if directly assigned to `fill` or `stroke` attributes in SVG.
- **Root Cause**: Unlike HTML/CSS background values, SVG `<path>` and `<rect>` elements do not accept raw CSS gradient functions in `fill` or `stroke`. They require `<defs>` containing `<linearGradient id="...">` or `<radialGradient id="...">` and reference them via `url(#id)`.
- **Solution / Workaround**:
  1. Add gradient models (`CanvasLinearGradient`, `CanvasRadialGradient`, `CanvasGradientDef`), parser (`parseCssGradient`), and SVG descriptor generator (`gradientToSvgDef`) in `@pixerate/editor`.
  2. In `getShapeRenderData`, resolve gradient fills and strokes to deterministic def IDs (`shape-fill-${id}`, `shape-stroke-${id}`) and output `fillGradient` / `strokeGradient` defs.
  3. In `ShapeNode` (React and Svelte), render `<defs>` with `<linearGradient>` / `<radialGradient>` before rendering shape paths.
  4. In `CanvasDrawLayer` (React and Svelte), resolve the active live stroke gradient to an inline `<defs>` definition (`draw-active-stroke-gradient`) so user strokes render with gradients live during dragging.

### [svelte/canvas] Svelte 5 Runes and .svelte Imports in Vitest

- **Issue / Symptom**: Running Vitest fails with `ReferenceError: $state is not defined` when executing tests against `.svelte.ts` files, or throws `TypeError: Unknown file extension ".svelte"` when importing `@xyflow/svelte`.
- **Root Cause**: Svelte 5 runes (`$state.raw`, `$derived`, etc.) and `.svelte` component distributions require compile-time transformation via `@sveltejs/vite-plugin-svelte` and a DOM environment (`jsdom`). In a monorepo, if the root Vitest config does not specify workspace project delegation, individual package configs are ignored.
- **Solution / Workaround**:
  1. Add `packages/svelte/vitest.config.ts` with `plugins: [svelte()]` from `@sveltejs/vite-plugin-svelte` and `test: { environment: 'jsdom' }`.
  2. Add root `vitest.config.ts` with `test: { projects: ['packages/*', 'apps/*'] }` so monorepo `pnpm test` delegates to package-level Vitest configurations.

### [svelte/canvas] Decoupling SvelteFlow via Optional Peer Dependencies and Subpath Exports

- **Issue / Symptom**: Adding canvas features to `@pixerate/editor-svelte` could unnecessarily bloat bundle sizes or require `@xyflow/svelte` for consumers who only need rich-text / TipTap editors.
- **Root Cause**: Putting `@xyflow/svelte` as a hard dependency in `dependencies` forces every consumer of `@pixerate/editor-svelte` to download SvelteFlow and its transitive dependencies.
- **Solution / Workaround**:
  1. Expose canvas features under the subpath export `./canvas` (`@pixerate/editor-svelte/canvas`) rather than the root entry.
  2. Define `@xyflow/svelte` under `peerDependencies` with `peerDependenciesMeta: { "@xyflow/svelte": { "optional": true } }`.
  3. Because `@pixerate/editor-svelte` ships uncompiled sources via `svelte-package`, imports of `@xyflow/svelte` and `@dagrejs/dagre` are left as-is and resolved by the consumer's bundler; never import `@xyflow/svelte` from the root entry.

### [svelte/canvas] Zero-Duration Transitions and Division by Zero in Multi-Node Animation

- **Issue / Symptom**: Running transitions with `duration: 0` (e.g. for instantaneous layout updates or synchronous unit testing) sets node positions to `{ x: NaN, y: NaN }` and stalls completion.
- **Root Cause**: Computing progress via `elapsed / item.duration` produces `0 / 0 = NaN`. Furthermore, if `staggerDelay > 0` is applied when duration is 0, subsequent items calculate negative elapsed times and get deferred to `requestAnimationFrame`.
- **Solution / Workaround**: Guard `rawProgress` with `item.duration <= 0 ? 1 : Math.min(elapsed / item.duration, 1)` and force `effectiveStagger = duration === 0 ? 0 : staggerDelay`.

### [history/react] `useSyncExternalStore` Snapshot Referential Equality

- **Issue / Symptom**: React throws `Maximum update depth exceeded` and logs `The result of getSnapshot should be cached to avoid an infinite loop` when using `useHistory`.
- **Root Cause**: In React 18/19, `useSyncExternalStore` compares the snapshot returned by `getSnapshot()` using `Object.is(prev, next)`. If `manager.getState()` computes and returns a new object literal on every call, React considers the store continuously dirty and loops infinitely.
- **Solution / Workaround**: Cache the state object (`cachedState`) in `HistoryManager` and only allocate a new snapshot reference when a mutation actually occurs (inside `notify()` or upon `execute`, `undo`, `redo`, `clear`).

### [history/shortcuts] Native Text Inputs and ContentEditable Hijacking

- **Issue / Symptom**: Registering a global window listener for Undo/Redo (`Cmd+Z`, `Ctrl+Z`) breaks normal typing, backspacing, or rich-text editing inside `<input>`, `<textarea>`, or TipTap/ProseMirror `contenteditable` nodes.
- **Root Cause**: Keyboard events bubble up to the window object where a naive shortcut handler calls `event.preventDefault()` and invokes app-level history instead of letting the browser/editor perform native or ProseMirror undo.
- **Solution / Workaround**: Guard shortcut handlers by inspecting `event.target` and `document.activeElement`. If the element is an `<input>`, `<textarea>`, or has `isContentEditable` / `contenteditable="true"`, ignore the event and do not call `preventDefault()`.

### [core/mentions] Markdown Code-Block Immunity and URL Immunity in Mention Extraction & Preprocessing

- **Issue / Symptom**: Markdown or HTML content containing code samples, terminal output, stack traces, markdown links (`[package](https://npmjs.com/@scope/package)`), or raw URLs mistakenly formats `@handle` into interactive TipTap mention nodes (`<span data-type="mention">`), or triggers false-positive mention notifications.
- **Root Cause**: Naive regex matching for `@handle` triggers inside fenced code blocks (`` ``` `` or `~~~`), inline backticks, HTML `<pre>`/`<code>` blocks, markdown URL targets `](...)`, and URL path segments.
- **Solution / Workaround**: Use `stripMarkdownCode()` prior to extraction, and in `preprocessMarkdownMentions()`, split content using `MARKDOWN_MENTION_SPLIT_REGEX` so that code blocks, inline code, existing mention spans, and URLs remain completely untouched.

### [core/mention] TipTap Suggestion onKeyDown Command Inaccessibility

- **Issue / Symptom**: When implementing a custom keyboard handler (e.g. `Enter` or `Tab`) in a TipTap suggestion popover, calling `props.command(item)` inside `onKeyDown(props)` throws `TypeError: props.command is not a function`.
- **Root Cause**: In `@tiptap/suggestion`, `onKeyDown` receives `SuggestionKeyDownProps` which only contains the `view`, `event`, and `range`. The `command(attrs)` callback is only supplied on `SuggestionProps` passed to `onStart` and `onUpdate`.
- **Solution / Workaround**: Cache the latest `suggestionProps` during `onStart` and `onUpdate`, and invoke `cachedSuggestionProps.command(item)` when executing suggestion selection from a keyboard event.

### [react/testing] React 19 Testing without `@testing-library/react`

- **Issue / Symptom**: Attempting to import `renderHook` or `act` from `@testing-library/react` in package test suites fails with `Cannot find package '@testing-library/react'`.
- **Root Cause**: `@testing-library/react` is not an installed dependency in `@pixerate/editor-react` to keep the dependency footprint light.
- **Solution / Workaround**: Use `act` directly from `react` (`import React, { act } from 'react'`) and mount test components into a JSDOM container via `createRoot(container)` from `react-dom/client`, setting `(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true`.

### [core/canvas] Incremental Dagre Layout Centroid Blending & Unplaced Nodes

- **Issue / Symptom**: When running incremental layout `ensureLayout`, nodes initialized at `{ x: 0, y: 0 }` are erroneously treated as placed nodes and kept at `(0, 0)` rather than flowed into position relative to existing nodes.
- **Root Cause**: `storedPositions` mapped all node IDs including unplaced nodes initialized with default coordinates `(0, 0)`.
- **Solution / Workaround**: Filter `storedPositions` to only include nodes with non-zero coordinates (`x !== 0 || y !== 0`) or explicitly stored positions, allowing newly spawned nodes to calculate centroid translation offsets $\Delta x$ and $\Delta y$ seamlessly.

### [react/canvas] Synthetic vs Native ClipboardEvent Handling

- **Issue / Symptom**: Calling clipboard copy/paste handlers in React tests throws `TypeError: event.preventDefault is not a function` or fails to extract text/JSON from `clipboardData`.
- **Root Cause**: In React 19 / JSDOM environments, `event` passed to clipboard handlers may either be a synthetic `React.ClipboardEvent` or a native `ClipboardEvent`.
- **Solution / Workaround**: Extract the native event via `const native = (event && 'nativeEvent' in event) ? (event as any).nativeEvent : event;` and guard `(event as any)?.preventDefault?.(); (native as any)?.preventDefault?.();`.

### [core/agent] Ephemeral Presence Artifacts in Multimodal Snapshots & Background Tab Throttling

- **Issue / Symptom**: Multimodal LLM agents executing visual snapshot tools (`view_editor`) inspect their own cursor trails and speech tags in a feedback loop, or frame animations freeze when the browser tab is hidden/backgrounded.
- **Root Cause**:
  1. Ephemeral cursor tags and narration bubbles rendered in the DOM are captured in canvas exports unless explicitly filtered out before rasterization.
  2. Browsers throttle or suspend `requestAnimationFrame` when `document.hidden` is true (background tabs, headless CI runners).
- **Solution / Workaround**:
  1. Add `EXPORT_EXCLUDED_SELECTORS` (`.pixerate-presence`, `.agent-presence`) to canvas export pipelines to strip presence DOM nodes before capturing images.
  2. Implement `Clock` with `pageHidden()` fallback to `setTimeout`, and provide `ManualClock` for step-by-step deterministic advancement in test suites and video capture runners.

### [core/tsup] TypeScript Union Distribution with `Omit<Union, Key>`

- **Issue / Symptom**: During `tsup` DTS type declaration generation, passing discriminated union objects (such as `Annotation` variants) to a function typed with `Omit<Annotation, 'id'>` throws `TS2353: Object literal may only specify known properties, and 'points' does not exist in type 'Omit<Annotation, "id">'`.
- **Root Cause**: In TypeScript, the standard `Omit<T, K>` utility is not distributive over unions (`T = A | B`). `Omit<A | B, 'id'>` evaluates to `{ [k in (keyof A & keyof B)]: ... }`, discarding member-specific properties such as `points` on `PenAnnotation` or `radiusX` on `CircleAnnotation`.
- **Solution / Workaround**: Define an explicit distributive union type (e.g. `export type CreateAnnotationPayload = Omit<PenAnnotation, 'id'> | Omit<RectAnnotation, 'id'> | ...`) or a distributive utility `type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never`.

### [image-editor/dom] Canvas Viewport Layout Feedback Loop Causing Zoom Drift on Every Action

- **Issue / Symptom**: In the image editor demo, performing any action (slider adjustment, rotate, annotation, crop preset, undo) caused the image to repeatedly zoom in.
- **Root Cause**:
  1. The `<canvas>` element was placed in normal document flow (`position: static`/`relative`) inside a flex container that had padding and no rigid height constraint (`min-h-[480px]`).
  2. On each action, the canvas resolution was updated to `canvas.width = container.clientWidth` and `canvas.height = container.clientHeight`. Because the canvas possessed intrinsic dimensions and the container had padding, the parent container expanded.
  3. On the subsequent action, `container.clientHeight` was measured larger, which increased `fitScale = Math.min((vpWidth * 0.85) / baseW, (vpHeight * 0.85) / baseH, 1)`, rendering the image larger and causing the parent container to expand further on every interaction.
  4. Additionally, when rotating 90° or 270°, the renderer did not transpose base dimensions `(cropW, cropH)` to `(cropH, cropW)`, clipping rotated images and distorting `fitScale`.
- **Solution / Workaround**:
  1. Position the canvas with `className="absolute inset-0 w-full h-full block cursor-crosshair"` within a `relative flex-1 h-full min-h-0 overflow-hidden` container. Absolute positioning removes the canvas from document flow, making it physically impossible for canvas pixel dimensions to alter or expand the parent container.
  2. Enforce explicit layout height on the editor outer frame (`h-[540px]`).

### [tailwind/monorepo] Missing Workspace Packages in Tailwind `content` Causes CSS Layout Collapse

- **Issue / Symptom**: In the demo app, the image editor canvas was centered floating over the sidebar controls, the sidebar took up 100% width below the canvas, and aspect ratio preset buttons stacked in single full-width vertical rows rather than a 3-column grid.
- **Root Cause**: `apps/demo/tailwind.config.js` only included `"./src/**/*.{js,ts,jsx,tsx}"` in its `content` array. Because `@pixerate/editor-react` and `@pixerate/editor-svelte` use Tailwind utility classes (e.g. `md:flex-row`, `md:w-80`, `grid-cols-3`, `h-[540px]`), Vite's Tailwind compiler purged all classes that were not also present in `apps/demo/src`. Without `md:flex-row` and `md:w-80`, the container stayed `flex-col`, the sidebar expanded to 100% width, and without `grid-cols-3`, the presets collapsed into a single column.
- **Solution / Workaround**:
  1. Add `"../../packages/*/src/**/*.{js,ts,jsx,tsx,svelte}"` to the `content` array in `apps/demo/tailwind.config.js`.
  2. Implement responsive heights (`h-[360px] md:h-full min-h-[320px]`) in [`ImageEditor.tsx`](file:///Users/jack/Development/editor/packages/react/src/image-editor/ImageEditor.tsx) and [`ImageEditor.svelte`](file:///Users/jack/Development/editor/packages/svelte/src/image-editor/ImageEditor.svelte) so viewport containers have a well-defined fallback layout even in single-column / mobile contexts.

### [image-editor] Crop Overlay Disappearing Outside of Drag Operations

- **Issue / Symptom**: The interactive crop rectangle, rule-of-thirds grid, and resize handles were only visible on the canvas while actively dragging a handle. When the user was not dragging (idle hover or initial tab selection), the crop overlay was completely invisible.
- **Root Cause**:
  1. The renderer condition evaluated `options.draftCrop !== undefined ? options.draftCrop : crop`. When idle, `draftCrop` was passed as `null` (since no draft drag was active). In JavaScript, `null !== undefined` is `true`, causing `activeCrop` to evaluate to `null` instead of falling back to the committed `state.crop`.
  2. Initially or upon reset, `state.crop` is `null`. Without a fallback to full natural image dimensions `{ x: 0, y: 0, width: naturalWidth, height: naturalHeight }`, no bounding box existed to render handles or hit-test against.
  3. The renderer also required `state.activeTool === 'crop'`. On initial component mount, `activeTab` defaulted to `'crop'` but `state.activeTool` was `'select'`, causing `isActivelyCropping` to evaluate to `false` and hiding the overlay until the user manually clicked the tab button.
- **Solution / Workaround**:
  1. In `renderer.ts`, determine active crop as `(options.draftCrop !== undefined && options.draftCrop !== null) ? options.draftCrop : (crop ?? (isCroppingActive ? { x: 0, y: 0, width: naturalWidth, height: naturalHeight } : null))`.
  2. In `geometry.ts`, resolve `cropOverride` similarly so `getViewportMetrics` generates a valid `cropRect` and handles can be hit-tested even before the first crop operation.
  3. In React and Svelte 5 components, synchronize `editor.setTool('crop')` with `activeTab` on mount, and provide full-image dimension fallbacks during hover cursor hit testing.

### [core/grammar] `String.prototype.replace` Interprets `$` Patterns in Replacement Strings

- **Issue / Symptom**: A template body containing `$&` (e.g. a price like `"costs $&"`) made `resolveTemplates` hang forever; bodies containing `` $` `` or `$'` produced garbled output such as `"A [A ] B"`.
- **Root Cause**: `result.replace(fullMatch, resolvedBody)` treats `$&`, `` $` ``, `$'`, `$$` and `$1` in the *replacement string* as special patterns. `$&` re-inserted the `{{tag}}` itself, and the resolver rescanned from index 0, so it looped.
- **Solution / Workaround**: Never pass user-controlled text as a string replacement. Use a function replacer (`text.replace(regex, () => body)`) or build the result by slicing at `match.index`. The resolver now uses a single-pass function replacer and recurses into each body, so no rescan is needed.

### [core/serializers] TipTap Nests Paragraphs Inside List Items, and Live-Document `innerHTML` Runs Handlers

- **Issue / Symptom**: `htmlToPlainText` returned `"one\none\ntwo\ntwo"` for a two-item list and silently dropped `<pre>` code blocks. Separately, extracting text from untrusted HTML could fire `<img onerror>` handlers.
- **Root Cause**: TipTap serializes list items as `<li><p>…</p></li>`. Collecting the `textContent` of every element matching `p, li, …` counts each item twice, and anything outside that selector list is lost. Assigning `innerHTML` on an element created by the live `document` starts loading resources (and running inline event handlers) even when the element is never attached.
- **Solution / Workaround**: Walk the DOM and emit one line per *innermost* block element, treating `<br>` as a newline. Parse untrusted HTML into a `<template>` element's `.content` (or `DOMParser`), which is inert. To insert literal text into TipTap, never pass a string to `insertContent` (it is parsed as HTML); use `tr.insertText` for single lines, or `tr.replace(from, to, Slice.maxOpen(paragraphs))` so newlines split paragraphs like the paste handler does.

### [core/markdown] Markdown Content Legitimately Contains HTML, So `html: false` Is Not an Option

- **Issue / Symptom**: `markdownToTipTapHtml` passed raw HTML (`<img onerror>`, `javascript:` links) straight through, which is an XSS risk when rendering LLM or user-supplied markdown. Turning off markdown-it's `html` option breaks mention round-trips and file-link preprocessing.
- **Root Cause**: `tiptap-markdown` serializes mention nodes as raw `<span data-type="mention">` HTML, and `preprocessMarkdownFileLinks` / `preprocessMarkdownMentions` inject HTML into the markdown before rendering. `markdown-it-task-lists` also emits its checkboxes as `html_inline` tokens.
- **Solution / Workaround**: Keep `html: true` but override markdown-it's `html_inline` and `html_block` renderer rules to run an allowlist sanitizer (tags, attributes, `data-*`, checkbox-only `<input>`, and `md.validateLink` on entity-decoded, control-character-stripped `href`/`src`). Escape every value interpolated into preprocessor HTML. `allowUnsafeHtml: true` (passed via the render `env`) opts out for trusted input.

### [svelte/packaging] Precompiled Svelte Components Break SSR, Styles and Version Compatibility

- **Issue / Symptom**: With the old `tsup` + `esbuild-svelte` build, rendering any component in SvelteKit SSR threw `document is not defined`; component `<style>` blocks (editor placeholder, spreadsheet resize handle) never reached consumers; and the hand-written `index.d.ts` files referenced unimported types and had drifted from the real exports.
- **Root Cause**: `esbuild-svelte` compiles components once, in client mode, importing private `svelte/internal/client` APIs that are not semver-stable. Scoped CSS was emitted to `dist/index.css`, which nothing imported and the `exports` map did not expose. `dts: false` meant types were maintained by hand.
- **Solution / Workaround**: Build with `svelte-package -i src -o dist` (`@sveltejs/package` v2; v3 requires TypeScript 6). It ships `.svelte` sources (compiled by the consumer for client *and* server, with styles intact) and generates `.d.ts` files with `svelte2tsx`. Requirements this imposes:
  1. Relative imports in `.ts` files must use the emitted extension: `./editor.svelte.js` for rune modules (`editor.svelte.ts`), `./history/index.js` for folders. Component imports keep `.svelte`.
  2. Keep tests out of `src/` (they live in `packages/svelte/tests/`), otherwise they are packaged.
  3. Type-check with `svelte-check`, not `tsc` (`tsc` cannot see `.svelte` files without an ambient shim, and a shim would hide real prop types).
  4. `tests/ssr.test.ts` renders components with `svelte/server` in a Node environment to guard against regressions.

### [core/tsup] `splitting: false` Duplicates Shared Modules Across Subpath Entries

- **Issue / Symptom**: Importing both `@pixerate/editor` and `@pixerate/editor/image-editor` (or any two subpaths) loaded two copies of shared modules: two `globalImageCache` instances, and `instanceof` checks failing across entries. The root entry also pulled in `@dagrejs/dagre` and the image renderer for consumers who only wanted the prompt editor.
- **Root Cause**: With `splitting: false`, tsup bundles every entry point independently, inlining all of its imports. The root barrel re-exported every module, including canvas, agent and image-editor.
- **Solution / Workaround**: Build with `splitting: true` so shared code lands in common chunks, and keep heavy or environment-specific modules (canvas, agent, image-editor) subpath-only. Framework packages must import them from the subpath (`@pixerate/editor/image-editor`), not the root.

### [monorepo/deps] TipTap Must Be a Peer Dependency to Avoid Duplicate ProseMirror Instances

- **Issue / Symptom**: Consumers could end up with two copies of `@tiptap/core` / `@tiptap/pm` (e.g. a v3 `@tiptap/react` from the app alongside core's v2), producing errors such as `Adding different instances of a keyed plugin`, `RangeError: Can not convert <> to a Fragment`, failed `instanceof` checks, or core extensions silently not applying.
- **Root Cause**: ProseMirror relies on module identity (plugin keys, `Node`/`Schema` classes). Listing `@tiptap/core` and `@tiptap/pm` under `dependencies` lets the package manager install a private copy per package when ranges differ; `@pixerate/editor-react` also advertised `^2 || ^3` while core only supported v2.
- **Solution / Workaround**: Declare `@tiptap/core`, `@tiptap/pm` (and `@tiptap/react` for React) as `peerDependencies` with one shared range, mirrored in `devDependencies` for local builds. Extension packages (`@tiptap/extension-*`, `@tiptap/starter-kit`, `@tiptap/suggestion`) can stay regular dependencies because they themselves peer-depend on `@tiptap/core`/`@tiptap/pm`. Only widen the range to a new TipTap major once it is installed and tested in CI. The demo app lists the peers explicitly.

### [react/tiptap] `useEditor` Dependency Arrays Destroy the Editor (and Loop on Inline Objects)

- **Issue / Symptom**: `usePromptEditor({ templateColorMap: new Map(...) })` threw "Maximum update depth exceeded"; toggling `isEditing` or changing `placeholder` lost undo history, focus and the caret.
- **Root Cause**: `@tiptap/react`'s `useEditor(options, deps)` destroys and recreates the editor whenever a dependency changes by identity. An inline `Map` is a new object every render, so each render created an editor, which triggered a re-render, which created another. Options such as `editable` were also listed as deps even though they can be applied to the live instance.
- **Solution / Workaround**: Only list options that are baked into extension configuration, and key object-valued options by value (e.g. `JSON.stringify(Array.from(map.entries()))`). Apply everything else in effects on the live editor: `editor.setEditable()`, `editor.setOptions({ editorProps })` for attributes, mutate `extension.options` and dispatch an empty transaction to refresh decorations (placeholder), and `setContent(…, false)` only when the incoming value differs from the editor's current text, so echoes of `onContentChange` never reset the caret.

### [svelte/testing] `mount()` Fails with `lifecycle_function_unavailable` in Vitest

- **Issue / Symptom**: Mounting a component with `mount()` from `svelte` in a jsdom test throws `Svelte error: lifecycle_function_unavailable` from `svelte/internal/server`.
- **Root Cause**: Vitest resolves package exports with Node conditions, so `svelte` resolves to its server runtime even in the jsdom environment.
- **Solution / Workaround**: Set `resolve: { conditions: ['browser'] }` in `packages/svelte/vitest.config.ts` (guarded by `process.env.VITEST`). Tests annotated with `// @vitest-environment node` (e.g. `tests/ssr.test.ts`) still use the server build.

### [core/spreadsheet] Recalculation Must Be Topological, and Structural Edits Must Rewrite References

- **Issue / Symptom**: Formulas computed from cells evaluated later showed 0 (`A1` = `=A2*2` loaded before `A2`); cycle markers vanished or turned into `NaN` after an insert or undo; inserting a row made formulas point at the wrong cells; column formulas using `[property]` showed the same value in every row.
- **Root Cause**: `recalculateAll` evaluated row by row and never cleared the dependency graph; cycle detection only flagged the edited cell; references are stored as A1 text, so moving cells without rewriting formulas changes what they point at; `[property]` resolved against the *selected* row.
- **Solution / Workaround**: `DependencyGraph.getEvaluationPlan()` runs an iterative Tarjan SCC pass (no recursion, so long chains don't overflow) that returns cells dependencies-first plus every member of a cycle. `recalculateAll` rebuilds the graph and follows the plan. Row/column insert/delete calls `shiftFormulaReferences()` on every formula *before* mutating the grid; growing the grid during a paste is not an insertion and must not shift references. Ranges (including whole columns `A:A`) are stored whole in an interval index, never as one key per cell (see the large-sheet entry below). The controller sets the evaluating row while evaluating so `[property]` is per-row. In formula code, never use `Math.max(...values)` or `push(...values)` on range values: large ranges overflow the stack.

### [core/canvas] Streaming Layout: Debounce Starves Layouts, and Current Positions Are Not Layout Targets

- **Issue / Symptom**: During an LLM stream, `StreamingLayoutManager` ran no layouts until the stream went quiet (updates every 20ms with `throttleMs: 50` resulted in zero layouts over 500ms). When a layout did run, nodes never glided; they stayed where they were.
- **Root Cause**: `pushStreamUpdate` cleared and re-armed a single timeout on every call. That is a *debounce*: the timer only fires after `throttleMs` of silence. Separately, the caller's `currentPositions` were passed to `ensureLayout` as `storedPositions`, which pins every known node to its current spot. So each target equalled the current position and no transition was created.
- **Solution / Workaround**: Use a real throttle. Lay out immediately on the leading edge and open a window. Inside the window, keep only the latest args, then run them on the trailing edge and re-open the window. Treat `currentPositions` only as the glide *origin*. Compute targets from the graph plus explicitly pinned `layoutOptions.storedPositions`. When re-targeting mid-glide, start from the in-flight animated positions so nodes don't jump. Test with `vi.useFakeTimers()` for the throttle and a `ManualClock` for the glide. Don't mix them: `ManualClock.advance` awaits a real `setTimeout(0)` and hangs under fake timers.

### [core/canvas] Node `style` Can Be a String (SvelteFlow) or an Object (React Flow)

- **Issue / Symptom**: `runMultiNodeTransition` with a fan-out trajectory threw `style.replace is not a function` for React Flow nodes. It also overwrote the caller's node objects, which breaks React's immutable state expectations.
- **Root Cause**: The opacity logic assumed CSS-string styles (`"opacity: 0.5;"`), which is SvelteFlow's convention. React Flow / xyflow uses `CSSProperties` objects. The runner also mutated `node.position`, `node.data` and `node.style` in place.
- **Solution / Workaround**: Use `withStyleOpacity(style, opacity, emptyFormat)`. It returns `{ ...style, opacity }` for objects, rewrites the `opacity` declaration for strings, and builds a new style in the requested format when `style` is empty. React passes `styleFormat: 'object'`. Transitions now emit updated **copies** through `onUpdate(nodes)` / `onComplete(nodes)`. Merge them into state by `id` instead of reading the input nodes.

### [core/history] Exceptions Inside `batch` / `undo` / `redo` Corrupt the Stacks

- **Issue / Symptom**: If a `batch` callback threw halfway, a partial compound entry was still pushed and could be undone. If a command's `undo` threw, the command disappeared from both stacks.
- **Root Cause**: `batch` pushed the collected commands in a `finally` block. `undo`/`redo` popped the command *before* calling its closure.
- **Solution / Workaround**: In `batch`, catch the error, undo the already-executed batch commands in reverse with `isApplying = true` so the undos are not recorded, push nothing, and rethrow. In `undo`/`redo`, peek at the top command, run its closure, and pop/push only after it succeeds.

### [core/agent] Planner Must Accept the MCP Tool Schema's Vocabulary

- **Issue / Symptom**: An agent calling `edit_canvas` with `side: 'top'` got the node placed *below* the anchor. `layout` without `incremental` discarded manual positions even though the schema says `incremental` defaults to `true`.
- **Root Cause**: The tool schema (`top | right | bottom | left`, `incremental` default true) and the planner/`placeBeside` vocabulary (`right | below | left | above`, falsy default) drifted apart. Unknown sides fell through to `placeBeside`'s `default: below` branch.
- **Solution / Workaround**: Normalize sides with `normalizeSide()` and use `command.incremental ?? true`. When changing `tools.ts`, update the planner and its tests in the same change. Validate `nearNodeId` against the snapshot before anchoring or adding an edge.

### [core/image-editor] One Canonical Coordinate Space for Crop, Annotations and Masks

- **Issue / Symptom**: At 90°/270° the crop overlay was drawn with the wrong size (the left half of an 800×600 image showed as 300×800 instead of 600×400). Crop drags went the wrong way on flipped images. The depth mask ignored rotate/flip. Inpainting masks were misaligned with the image. Undo after an AI edit could not restore the image.
- **Root Cause**: Every code path invented its own mapping. The crop box was stored in natural pixels but divided by unswapped width/height on a swapped base. `canvasToImagePoint` ignored rotation, flips and the crop offset. Annotations were stored in post-crop/post-rotate display space but rendered onto natural-size mask canvases. History snapshots left out the source image.
- **Solution / Workaround**:
  1. The crop box and **all** annotations are stored in natural pixels of the current source image. Rotation, flips, crop, fit, zoom and pan are view transforms only.
  2. `geometry.ts` owns the only mapping: `target = origin + scale · R(angle) · F(flipH, flipV) · (p − regionCenter)`, exposed as `projectImagePoint` / `unprojectCanvasPoint` (exact inverse) and `applyImageProjectionToContext` (the same transform for a 2D context). The renderer (viewport, base image, depth mask, annotations, export), `getViewportMetrics`, `hitTestCrop` and `canvas↔image` conversion all build on it. Never hand-roll `translate/rotate/scale` sequences or `x / naturalWidth * renderW` maths in new code.
  3. `hitTestCrop` returns image-space handles because that is what `calculateCropDrag` needs. Map them back with `getCropCursor(handle, transform)`. An on-screen aspect ratio is inverted in image space under a quarter turn.
  4. Annotations follow the image content: rotating or flipping the image rotates or mirrors existing annotations, text included, and they are clipped to the visible region.
  5. AI hooks get `toSourceDataURL()` (natural size, untransformed) together with `toMaskDataURL()` (same space), and the result replaces the source. History entries store the source URL, element and dimensions next to the serialized edits, so `applyInpaintedImage` / `applyBackgroundRemovedImage` are single undoable steps.
  6. Exact quarter-turn `cos`/`sin` values keep round trips free of float error. Any value that changes the base render, such as `depthMask.maskSource` or the source element, must be part of the renderer's cache key.

### [core/canvas] Layer Order: xyflow Stacks by `zIndex`, Then Array Order, and Parents Must Come First

- **Issue / Symptom**: "Bring to Front" implemented by moving a node to the end of the `nodes` array had no effect when other nodes had a `zIndex`, and moving a parent group after its children broke the sub-flow.
- **Root Cause**: SvelteFlow and React Flow render nodes with CSS `z-index` from `node.zIndex` (missing = 0, plus 1000 for selected nodes when `elevateNodesOnSelect` is on) and only fall back to array order for ties. xyflow also requires a parent to appear before its children in the array.
- **Solution / Workaround**: `reorderNodes` computes the effective order (`zIndex`, then array index) per sibling group (same `parentId`), applies the operation and returns `zIndex` rank updates. It never reorders the array. Nodes whose effective `zIndex` already equals their rank are left untouched, and a no-op operation returns no updates.

### [core/canvas] Option/Alt Shortcuts Must Match `KeyboardEvent.code`, Not `key`

- **Issue / Symptom**: Align shortcuts such as `Alt+A` never fired on macOS, and `Mod+Alt+]` (bring to front) did not match.
- **Root Cause**: On macOS, Option changes the produced character (`Alt+A` gives `key === 'å'`, `Alt+]` gives `'‘'`). Keyboard layouts also move `[`/`]`.
- **Solution / Workaround**: `matchArrangeShortcut` matches bindings by `event.code` (`KeyA`, `BracketRight`) and only derives a code from `key` when `code` is empty (synthetic events). It still bails out early through `isEventFromTextInput` so the shortcuts never hijack typing.

### [svelte/canvas] SvelteFlow `Node` Is Not Assignable to Core `CanvasNode`

- **Issue / Symptom**: `svelte-check` fails with `Types of property 'class' are incompatible` when a Svelte rune passes SvelteFlow nodes into a generic core helper such as `createCanvasArrangeController<TNode>`.
- **Root Cause**: Core's structural `CanvasNode` declares `class?: string`. SvelteFlow's `Node` declares `class?: ClassValue` (strings, arrays or objects).
- **Solution / Workaround**: Keep the public Svelte API typed with the Svelte `CanvasNode` from `./types.js` and call the core controller with a loose type parameter (`createCanvasArrangeController<any>`). The core helpers only read `id`, `position`, sizes, `style`, `parentId`, `zIndex`, `data` and the interaction flags.

### [canvas] Smart-Guide Snapping Hooks Differ Between SvelteFlow and React Flow

- **Issue / Symptom**: One snapping integration does not fit both libraries. In React Flow, a position rewritten in `onNodeDrag` is overwritten by the next `onNodesChange` batch, so the node does not stay snapped.
- **Root Cause**: React Flow is controlled through `onNodesChange`, so a position must be snapped *before* `applyNodeChanges` runs. SvelteFlow binds `nodes` and calls `onnodedrag` after it has written the dragged position. Both compute each drag frame from the pointer and the drag-start position, not from the previous frame, so writing a snapped position does not accumulate offsets.
- **Solution / Workaround**: React: `onNodesChange={(c) => setNodes((n) => applyNodeChanges(arrange.snapPositionChanges(c), n))}`. A batch with `dragging: false` ends the drag and clears the guides. Svelte: `onnodedragstart={() => arrange.beginDrag()}`, `onnodedrag={({ nodes }) => arrange.drag(nodes.map((n) => n.id))}`, `onnodedragstop={() => arrange.endDrag()}`. Snap targets are indexed once per drag (`createNodeGuideIndex`) and each frame is a binary search, so dragging stays fast with hundreds of nodes.

### [core/grammar] Escapes in `VARIABLE_REGEX` Can Backtrack Catastrophically, and Sections Are Scoped Per Body

- **Issue / Symptom**: A first attempt at allowing `\}` / `\|` inside `{name|default}` with `(?:\\.|[^{}])+` froze the tab on input such as `{` followed by thousands of backslashes and no closing brace. Separately, a `{?x}` opened inside a template body and closed in the prompt (or the other way round) behaved unpredictably once templates were expanded.
- **Root Cause**: In `(?:\\.|[^{}])+` a backslash can match either branch, so each run of backslashes can be split many ways, and a failing match tries all of them (exponential). Sections that cross template boundaries depend on expansion order, and a removed section would have to be known before its templates are expanded.
- **Solution / Workaround**: Keep the alternatives disjoint: `(?:\\[\s\S]|[^{}\\])*\\?` (a backslash is only ever an escape, except one trailing backslash, which keeps the old `{a\}` match). `tests/grammar.test.ts` has a timing guard. The resolver tokenizes each template body on its own: sections must open and close in the same body, unbalanced tags stay literal and are reported as diagnostics with `templateName`, and templates inside removed sections are never expanded. Unbalanced tags must never throw. Pair them with `matchConditionalTags()` (used by the tokenizer and by `GradientText`, which pairs across the whole document because sections may span paragraphs).

### [react/testing] Text Inputs Never Fire `onChange` When JSDOM Is Installed After `react-dom` Loads

- **Issue / Symptom**: In a React test that creates a `JSDOM` in `beforeAll` (see "React 19 Testing without `@testing-library/react`"), typing into an `<input>` (native value setter plus an `input` event) never called `onChange`. Checkbox `click()`s did work.
- **Root Cause**: `react-dom` checks once, at import time, whether the DOM exists and supports the `input` event. ES imports are hoisted above `beforeAll`, so the check runs with no `window`, and React falls back to key/selection-based change detection that synthetic `input` events never trigger.
- **Solution / Workaround**: For tests that type into inputs, put `// @vitest-environment jsdom` at the top of the file instead of creating a `JSDOM` manually, so the DOM exists before `react-dom` is imported (see `packages/react/tests/variables.test.tsx`). Then set the value with `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, v)` and dispatch `new Event("input", { bubbles: true })` inside `act`.

### [core/track-changes] Tracking Must Rewrite Transactions in `appendTransaction`, Not at the Input Layer

- **Issue / Symptom**: Intercepting keys (`handleKeyDown`, `handleTextInput`) to implement suggestion mode misses most edits: browsers delete single characters natively (ProseMirror reads the DOM change, so `editor.commands.keyboardShortcut("Backspace")` does nothing in jsdom), and cut, drag-and-drop, input rules and IME all bypass key handlers. Naive tracking also broke paragraph joins, re-tracked undo/redo, turned `setContent` into one giant deletion, and parsed `<del data-change-type="deletion">` as a Strike mark.
- **Root Cause**: Only the transaction stream sees every edit. `<del>` is also claimed by StarterKit's Strike `parseHTML` at the default priority. Undo/redo (`history$` meta), remote collaboration (`y-sync$`) and other plugins' appended transactions are replays or housekeeping, not user edits.
- **Solution / Workaround**: `TrackChanges` uses `appendTransaction`. For each `ReplaceStep` it marks the inserted range and re-inserts `tr.docs[i].slice(from, to)` at `rest.map(from, -1)` with the deletion mark (dropping text the same author inserted). Slices with no inline content (paragraph splits/joins) are left alone, as is content whose parent disallows marks (code blocks). It skips transactions with `history$`, `y-sync$`, `appendedTransaction` or `TRACK_CHANGES_SKIP_META` meta. While `view.composing` is true it buffers transactions and tracks them after `compositionend`, since rewriting the DOM around an active composition breaks IMEs. The appended transaction is merged into the same undo event by prosemirror-history. Parse rules use `priority: 100`. In tests, simulate Backspace with `editor.view.dispatch(state.tr.delete(from - 1, from))`.

### [core/comments] Comment Store Updates Must Not Dispatch Synchronously Inside Commands

- **Issue / Symptom**: Redrawing comment decorations by dispatching a transaction from the `CommentStore` listener can throw `Applying a mismatched transaction` or recurse when the store changes inside a command or a plugin view `update()`.
- **Root Cause**: Commands mutate the store before their own transaction is dispatched, and `syncAnchors` runs inside the plugin view update, so a synchronous dispatch from the listener interleaves with an in-flight transaction.
- **Solution / Workaround**: Commands set a refresh meta on their own `tr`, and `decorations(state)` reads the store snapshot (cached per doc + snapshot). External store changes (UI, `load()`) schedule one refresh with `queueMicrotask`, which is skipped when the decorations already reflect the snapshot. Deleted threads are kept off-snapshot so undoing "Delete Comment" can restore them when the mark reappears.

### [core/import] `plainTextToTipTapHtml` Passes `<p>…</p>` Text Through as HTML

- **Issue / Symptom**: Importing a `.txt` file whose content is `<p><img src=x onerror=…></p>` would insert live HTML instead of literal text.
- **Root Cause**: `plainTextToTipTapHtml` treats input that already looks like paragraph HTML as HTML (so it can round-trip TipTap output) and returns it unchanged.
- **Solution / Workaround**: For untrusted text (imported files, extracted RTF text) use `plainTextToParagraphHtml`, which always escapes. Import HTML with `sanitizeImportedHtml`, which drops `<script>`/`<style>`/`<head>` with their content, strips namespaced tags such as Word's `<o:p>`, and applies the markdown allowlist in `disallowedTags: "strip"` mode.

### [core/import] Parsed HTML Slices Are Open, and Drop Positions Can Fall Between Blocks

- **Issue / Symptom**: Dropping a file with `## Heading` into `<p>x</p>` produced `<h2>Headingx</h2>`. Dropping text into a prompt editor added an empty trailing paragraph.
- **Root Cause**: `DOMParser.parseSlice` returns a slice opened as far as possible, so its first/last blocks merge into the surrounding paragraph. `view.posAtCoords` often returns a position *between* blocks (e.g. `0`); inserting an open text slice there creates a new paragraph.
- **Solution / Workaround**: For imported HTML build a closed slice (`new Slice(parser.parse(body).content, 0, 0)`) and insert it with `tr.replaceRange`. For plain text, move the position into the nearest textblock with `Selection.near(doc.resolve(pos))` and use `tr.replace` with `plainTextToSlice`.

### [core/clipboard] ProseMirror's Copy Handler Clears Extra Clipboard Types

- **Issue / Symptom**: Writing a custom MIME type (`application/x.pixerate.document+json`) in a `copy` listener had no effect.
- **Root Cause**: ProseMirror's built-in copy/cut handler calls `clipboardData.clearData()` before writing `text/html` and `text/plain`, so anything a plugin wrote earlier is lost.
- **Solution / Workaround**: Take over the event: in `handleDOMEvents.copy`/`cut`, call `view.serializeForClipboard(slice)` (which still honours `clipboardTextSerializer`, e.g. markdown), write HTML, text and the custom type, `preventDefault()`, delete the selection for `cut`, and return `true`. Return `false` when there is no writable `clipboardData` so ProseMirror's handler runs. On paste, only accept the payload when its schema signature matches; otherwise fall back. Editor-level `editorProps.handlePaste` (e.g. `usePromptEditor`'s plain-text paste) runs before plugin handlers, so the plain-text invariant still wins there, and `EditorController` disables the rich paste path in `plainTextMode`.

### [svelte/tiptap] Passing `onUpdate: undefined` to TipTap Makes Every Update Throw

- **Issue / Symptom**: Any programmatic change in an `EditableTextNodeEditor` mounted without `onUpdate` (e.g. a file drop) threw `Cannot read properties of undefined (reading 'apply')` from `Editor.emit`.
- **Root Cause**: TipTap registers `options.onUpdate`/`onCreate` as event listeners with `this.on(...)`. Spreading an explicit `undefined` overrides TipTap's no-op defaults, so `emit` calls `undefined.apply`.
- **Solution / Workaround**: Only pass callbacks that are defined (`...(onUpdate ? { onUpdate } : {})`).

### [core/agent] Tool-List Notifications Must Be Coalesced and Compared

- **Issue / Symptom**: Registering one tool provider per mounted editor sends a burst of `tools/list_changed` notifications on page load, and React StrictMode's mount → unmount → mount announces changes that didn't happen.
- **Root Cause**: Every register/unregister/provider signal changes the registry, but MCP clients only care about the resulting list.
- **Solution / Workaround**: `ToolRegistry` schedules one check per `listChangedDelayMs` window and compares a JSON signature of `listTools()` with the last announced one, so remounts and content-only editor updates notify nothing. Register providers in effects and memoize them (`useMemo`) so they aren't re-registered on every render. Colliding names are namespaced per provider (`doc-1__get_text`) rather than "first wins", so names don't depend on mount order.

### [core/spreadsheet] Moving Cells (Sort, Transpose) Is Not an Insert/Delete, and Fill Is Not a Move

- **Issue / Symptom**: After sorting, `=A2*10` in a sorted row pointed at another row's value; a total row's `=SUM(B2:B5)` broke when ranges were rewritten cell by cell; autofilled formulas either all pointed at the source row or shifted `$A$1`.
- **Root Cause**: There are three different reference rewrites. Row/column insert/delete *shifts* references (`shiftFormulaReferences`). Sort and transpose *move* cells, so a reference must follow the cell it points at regardless of `$`, and a range can only be rewritten if its cells still form the same rectangle afterwards. Copy/paste and autofill *offset* a formula, so only relative parts change and `$` parts stay.
- **Solution / Workaround**: Use `remapFormulaReferences(formula, moveCell)` for sort/transpose (applied to every formula *before* moving cells, since rewriting only depends on old positions), and `offsetFormulaReferences(formula, dRow, dCol)` for paste/autofill. Ranges spanning a sorted block keep their text (they still cover the same cells); one-row ranges inside a sorted row follow the row. Sorting areas that contain merged cells is rejected, and merges (stored by index) are adjusted in `adjustTableForStructuralChange` on row/column insert/delete.

### [core/spreadsheet] Sort and Transpose Must Move Conditional Formats and Validations Too

- **Issue / Symptom**: After sorting, a highlight or a validation list set on one row's cells stayed on that row index and applied to whatever data landed there; after transposing, rules kept their old shape.
- **Root Cause**: Rule ranges (`table.conditionalFormats`, `table.dataValidations`) are stored by index and were only adjusted for row/column insert/delete. Rule formulas are written for the first range's top-left cell, so changing the ranges silently changes what relative references mean.
- **Solution / Workaround**: `sortRows` calls `sortRules` (Excel behaviour): the part of a rule range that spans every sorted row applies to the column and stays; parts covering only some sorted rows move row by row through the permutation (`sortRuleRanges`, re-merged with `mergeRuleRanges`). Whole-row sorts move rule cells past the last column too. When the first cell of a rule changes, its formulas are re-anchored (`reanchorRuleFormula`) so `$B2` keeps meaning "this row". `transposeRange` calls `transposeRules`: cells inside the block are transposed, rule cells under the transposed block are dropped (the block replaces them), and formulas are rewritten with `transposeFormulaReferences` (relative offsets and `$` flags swap axes; `$` parts outside the block keep their text). A rule with formulas that is only partly inside the block is split into two rules (the moved part gets a new id, right after it), since one formula can't serve both layouts. Rule formulas are not remapped like cell formulas on sort. Both run inside the sort/transpose snapshot (one undo step); the overlay is rebuilt because the change recalculates everything.

### [core/spreadsheet] Filters, Hidden Rows and Categories Belong in the View Model

- **Issue / Symptom**: Filtering by deleting/hiding rows in the document made undo, formulas (`SUM` over filtered rows) and data-source syncs inconsistent; keyboard navigation landed on hidden rows; merged-cell spans broke when part of a merge was hidden or grouped elsewhere.
- **Root Cause**: Filters, user-hidden rows/columns and collapsed groups are presentation, not data. Category groups also reorder rows on screen without reordering the document.
- **Solution / Workaround**: Keep every row in `document.rows`; store user hiding as `hidden: true` on rows/columns and filter/grouping/merge state in `document.table` (so the snapshot undo covers it). Render from `controller.getViewModel()`, which returns rows (with group headers) and columns in display order, sticky offsets and `getCellSpan(row, col)` (null for cells covered by a merge). `moveCursor` steps through `viewModel.rowOrder`/`columnOrder`. `DataSourceBinder.syncRows` rebuilds record rows, so it must carry `hidden` over. A sort of a data-bound sheet lasts until the next `syncWithDataSource()`, which restores the data source's record order.

### [react|svelte/spreadsheet] Copy/Paste Events Fire on `<body>`, Not the Focused Grid; `preventDefault` on Mod+C Suppresses Them

- **Issue / Symptom**: Writing `text/html` and the custom `application/x.pixerate.spreadsheet+json` clipboard formats never happened from the grid's `onCopy`, and the keydown handler's `navigator.clipboard.writeText` overwrote the rich data.
- **Root Cause**: The async Clipboard API cannot write arbitrary MIME types; only a `copy` event's `clipboardData` can. With no text selection, browsers dispatch `copy`/`paste` at `<body>`, not at a focused non-editable `div`. Calling `preventDefault()` on the Mod+C keydown cancels the copy event entirely. In jsdom no copy event follows a synthetic keydown.
- **Solution / Workaround**: Listen for `copy`/`paste` on `document` and act only when focus is inside the grid but not in a text input (cell editor, formula bar). On Mod+C, don't prevent default; schedule a `setTimeout(0)` fallback that writes TSV with `writeText` only if no copy event handled it (the copy event fires synchronously during the keydown's default action, before any task). Tests must dispatch a `copy`/`paste` `Event` with a stubbed `clipboardData`, or wait a tick for the fallback.

### [core/spreadsheet] Formula Ranges Arrive Flat and Column-Major

- **Issue / Symptom**: Lookup functions (INDEX, VLOOKUP, XLOOKUP) picked the wrong cells.
- **Root Cause**: `EvaluationContext.resolveRange` returns one flat array, column by column (the controller's loop order), with no row/column shape.
- **Solution / Workaround**: The evaluator records each range's shape (`withRangeShape`, a `WeakMap` keyed by the array, columns taken from the range reference) and functions read ranges through `ctx.range(i)` / `rangeGet(range, row, col)`. Never assume row-major order. Custom `resolveRange` implementations must return values column-major. Functions that would return a whole row/column return a shaped array: other functions can aggregate it, `evaluateWithDiagnostics` returns it as `array` (with the top-left value as `value`), and the controller spills it (see the dynamic-arrays entry).

### [core/spreadsheet] Typed Input Must Be Parsed, or `=B1>8` Treats a Typed `7` as Text

- **Issue / Symptom**: With typed cells stored as their raw text, a typed `7` was the string `"7"`, so `=B1>8` was TRUE (text ranks above numbers), `FILTER(A:A, A:A>8)` kept small numbers, `MATCH(5, …)` missed a typed `5`, and sort put `10` before `9`.
- **Root Cause**: `CellData.value` was set to `raw` for non-formula input, and the strict Excel comparison (`"1"=1` is FALSE) is correct only if typed numbers are numbers. Patching individual functions (`numericValue` / `normalizeValue` in lookups and criteria) hid the problem without fixing operators.
- **Solution / Workaround**: `setCellValue` (and so CSV/TSV import, `importRows`, paste and autofill) stores `parseCellInput(raw).value`: numbers (`1,234`, `$5`, `10%`, `(100)`, `1e3`, `1 1/2`), booleans, error literals, ISO dates and text; `raw` stays as typed and a leading `'` forces text. `loadDocument` and the constructor re-parse stored typed cells from `raw`, so old documents with `value: "7"` work. Bound columns are different: values read from the data source are never re-parsed, and writes are coerced only for `number`/`boolean`/`date` fields. Display through `formatCellDisplay(cell)`, which applies the automatic `numberFormat` (`10%` stays `10%`, not `0.1`). Comparisons go through `compareValues` (Excel order numbers < text < booleans < errors; numbers at 15 significant digits so `0.1+0.2=0.3`); sorting through `sortCompareValues` / `compareCellValues` (blanks last). `numericValue` still accepts numeric text for lookups, criteria and SUM-style functions, because data sources can supply numbers as strings.
- **Date representation**: dates stay ISO text (`3/4/2026` → `"2026-03-04"`, with a time `"2026-03-04 18:00:00"`), because date arithmetic, DATE/TODAY and existing documents all use ISO text. A time typed alone (`10:30`) becomes a day fraction (0.4375) like Excel, shown with its `h:mm` format. ISO text can't hold Excel's fictitious 1900-02-29, so typing it keeps text (as numeric text in a formula it is serial 60). `parseNumberText` turns date text into 1900-system serials (`serialFromYmd`); `dateToSerial` counts from 1899-12-30 and so differs by one for dates before 1900-03-01.

### [core/spreadsheet] `isFormulaError` Narrows `string` to `never`

- **Issue / Symptom**: After `if (isFormulaError(text)) return text;`, TypeScript reports `Property 'trim' does not exist on type 'never'` for a `string` variable.
- **Root Cause**: `isFormulaError(value): value is string` is a type guard. For a value already typed `string`, the false branch removes `string` entirely, even though most strings are not errors.
- **Solution / Workaround**: In formula function code, use `failed()` from `functions/helpers.ts`. Its overloads only narrow unions such as `number | string` and leave plain `string` results (`ctx.text(i)`) alone. In shared helpers, test `FORMULA_ERRORS.has(value)` instead of the guard.

### [react/svelte spreadsheet] Formula Autocomplete Keys and Clicks Must Not Reach the Grid or Blur the Editor

- **Issue / Symptom**: Pressing Tab or ArrowDown to pick a formula suggestion committed the cell and moved the selection. Clicking a suggestion committed the half-typed formula. The suggestion popup was clipped inside the cell.
- **Root Cause**: The grid handles Tab/arrows/Escape in a `keydown` handler that React and Svelte 5 both delegate to the root. The cell editor commits on `blur`, and clicking elsewhere blurs it. Cells use `overflow: hidden`.
- **Solution / Workaround**: `FormulaHints` adds a native `keydown` listener on the input element itself. It runs during the target phase, before the root-delegated handlers, and calls `stopPropagation()` only while suggestions are open. Enter is never intercepted, so it still commits. Suggestions accept on `mousedown` with `preventDefault()`, so focus stays in the input. The popup uses `position: fixed` from the input's bounding rect to escape cell clipping. In Svelte, update the caret state *before* calling `onAccept`. If you only update it after `tick()`, the hints are briefly computed from the new value and the old caret.

### [core/document-structure] Derived Node State Is Missing From the Initial Document

- **Issue / Symptom**: Headings created from initial `content` had no ids, a table of contents rendered empty and footnotes were unnumbered until the first edit, so `getHTML()` right after `new Editor(...)` (e.g. markdown → HTML conversion) produced incomplete output.
- **Root Cause**: Heading ids, TOC entries, footnote numbers and cross-reference labels are stored in node attributes and kept in sync by `appendTransaction`, which never runs for the document passed to `EditorState.create`. TipTap emits `create` (and so `onCreate`) from a `setTimeout`, so a fix-up dispatched there arrives a tick late.
- **Solution / Workaround**: `syncInitialContent` (in `extensions/document-structure/utils.ts`) runs the same sync pass in `onBeforeCreate`: it parses `editor.options.content`, applies the fix, and hands TipTap the resulting node. Those extensions use a priority below the Markdown extension's (50) so markdown has already been converted to HTML when they run, and `Outline` (45) runs before the extensions that read heading ids (40).

### [core/document-structure] Custom Parse Rules Lose to `listItem` and `Link` Without a Priority

- **Issue / Symptom**: Footnotes parsed from HTML or markdown came back empty, and a cross-reference (`<a data-type="cross-reference" href="#…">`) turned into plain linked text after `getHTML()` → `setContent()`.
- **Root Cause**: ProseMirror's `DOMParser.schemaRules` orders rules by priority (default 50), then lists **all mark rules before node rules**, then schema order. `li[data-type="footnote"]` lost to StarterKit's `li` rule, and the Link mark's `a[href]` rule matched before the cross-reference node rule.
- **Solution / Workaround**: Give specific parse rules `priority: 60` (done for the TOC, footnote, cross-reference and bookmark rules). Cover new nodes with an HTML round-trip test.

### [core/markdown] tiptap-markdown Re-runs `parse.setup` Before Every Parse

- **Issue / Symptom**: Custom markdown-it rules registered in an extension's `storage.markdown.parse.setup` would be added again on every `setContent`, and `[^1]: note` footnote definitions were swallowed as link reference definitions.
- **Root Cause**: `MarkdownParser.parse` calls every extension's `setup(md)` on the same markdown-it instance for each parse. markdown-it's `reference` block rule runs before most rules and accepts `[^1]: …` as a reference definition (label `^1`), and its `link` inline rule then consumes `[^1]`.
- **Solution / Workaround**: Guard plugins with a per-instance `WeakMap` (see `document-structure/markdown-it.ts`), and register footnote/TOC block rules `before("reference")` and the reference inline rule `before("link")`.

### [core/autocorrect] Input-Rule Replacements Cannot Be Undone Separately

- **Issue / Symptom**: With TipTap input rules (e.g. Typography's `--` → `—`), Mod-z after a replacement removed the replacement *and* the surrounding typing, unlike Word where undo restores exactly what was typed. With both Typography and `Autocorrect` installed, Typography's rules won for quotes and dashes.
- **Root Cause**: TipTap's input rules insert the typed character and the replacement in one transaction, which `prosemirror-history` merges into the current typing group. TipTap's input-rule plugin is registered before extension plugins, so its `handleTextInput` runs first.
- **Solution / Workaround**: `Autocorrect` handles `handleTextInput` itself and dispatches two transactions: the typed text (normal grouping) and the correction marked with `closeHistory`, so it is its own undo step; the next typed character is also `closeHistory`-ed so it does not join the correction. `createRichTextPreset({ autocorrect })` drops Typography; do not install both.

### [core/spreadsheet] `Date.now()` + Short Random Suffix Ids Collide When Growing the Grid

- **Issue / Symptom**: A 3,000-row chain of formulas imported with `importFromTsv` sometimes evaluated to `#CYCLE!`, and only under load (full test runs). Copy/paste tests flaked the same way.
- **Root Cause**: Row and column ids were `${prefix}_${Date.now()}_${4 random base-36 chars}`. Growing the grid creates thousands of rows within a few milliseconds, so two rows could get the same id (birthday collisions on ~1.7M values). Cells are stored by row id, so the two rows shared storage and the dependency chain appeared to loop.
- **Solution / Workaround**: Generated ids (rows, columns, filter rules) include a module-wide monotonic counter. Never build ids from time plus a short random suffix where many can be created in one tick. `spreadsheet-engine.test.ts` checks that 5,000 rows created in one burst have unique ids.

### [monorepo] Feature subpaths must not import the root `@pixerate/editor` entry

- **Issue / Symptom**: A spreadsheet-only consumer still bundles TipTap, markdown-it and ProseMirror, or must install `@dagrejs/dagre`, even though the spreadsheet code uses none of them.
- **Root Cause**: The root entry re-exports the TipTap extensions and serializers, so any binding that imports a spreadsheet helper from `@pixerate/editor` (instead of `@pixerate/editor/spreadsheet`) drags the whole rich-text graph in whenever the bundler cannot tree-shake (CJS, dev builds, `sideEffects` not honoured). Separately, anything in `dependencies` is installed for every consumer, whatever entry they use.
- **Solution / Workaround**:
  1. Inside `packages/react/src/{spreadsheet,image-editor}` and `packages/svelte/src/{spreadsheet,image-editor,history}`, import from the narrow core subpath (`@pixerate/editor/spreadsheet`, `/image-editor`, `/history`), never the root.
  2. Keep feature-only third-party packages (e.g. `@dagrejs/dagre`, `@xyflow/*`) in optional `peerDependencies` plus `devDependencies`, never `dependencies`.
  3. `tests/entry-isolation.test.ts` in each package walks the built entry's import graph and fails if a forbidden package becomes reachable. These tests read `dist/`, so run `pnpm build` first.

### [core/import] `DecompressionStream` Output Must Be Pulled Incrementally to Stop Zip Bombs

- **Issue / Symptom**: A 4 KiB deflate entry that declares a 100-byte size can inflate to gigabytes; checking sizes only after `new Response(stream).arrayBuffer()` lets it exhaust memory first. jsdom's `Blob` also has no `stream()`, so `blob.stream().pipeThrough(...)` helpers fail in React/Svelte tests.
- **Root Cause**: ZIP headers are untrusted; only the bytes actually produced by the inflater count. Buffering helpers (`Response.arrayBuffer`) read the whole stream before returning.
- **Solution / Workaround**: `readZip` feeds input in 64 KiB slices and reads output chunk by chunk, cancelling the reader and aborting the writer as soon as the output exceeds the entry's declared size (or the archive's remaining `maxTotalSize` budget), then verifies CRC-32. Swallow the writer's rejection (`.catch(() => {})`) after cancelling, or it surfaces as an unhandled rejection. In tests, drive `CompressionStream` through `getWriter()` / `getReader()` instead of `Blob.stream()`.

### [core/import] DOCX Attributes Are Namespaced, and Images Need a Schema With `image`

- **Issue / Symptom**: `el.getAttribute("val")` returns `null` for `<w:b w:val="0"/>`, so formatting toggles were ignored; DOCX images vanished in editors created with `image: false`.
- **Root Cause**: WordprocessingML attributes live in the `w:` / `r:` namespaces (and Strict OOXML uses different namespace URIs). Import adapters do not know the target schema, and ProseMirror's `DOMParser` drops `<img>` when there is no `image` node.
- **Solution / Workaround**: Read attributes by `localName` (the `attr()` helper in `import/docx.ts`) and accept both transitional and strict `w:` namespaces. The DOCX adapter always emits `<img>` data URLs (PNG / JPEG / GIF / WebP only — the sanitizer's `data:` allowlist) and lets the schema decide; pass `images: false` to skip reading media entirely.

### [core/canvas] Polygon Booleans Break on Shared Edges and Touching Vertices

- **Issue / Symptom**: Uniting two shapes that share an edge (e.g. snapped side by side) or touch at a corner produced figure-eight rings, leftover zero-width slivers, or dropped the result, and the result changed when one shape moved by `1e-12`.
- **Root Cause**: Classic clipping algorithms (Greiner–Hormann, naive Martinez) assume edges cross at isolated points. Shared and collinear edges, vertices lying on edges and floating-point intersections that land a hair off both segments break their in/out bookkeeping.
- **Solution / Workaround**: `polygonBoolean` builds a planar overlay instead: points closer than `epsilon` are merged through a grid-hashed pool, segments are split at crossings, T-junctions and collinear overlaps (repeated until stable, because snapping moves segments slightly), and coincident segments are merged with a signed count per operand. Each edge's sides are classified by a winding-number ray cast from its midpoint, with the ray crossing the edge rather than running along it. Rings are traced taking the sharpest left turn, so rings touching at a vertex stay separate simple rings. Test new cases with the area identity `|A∪B| = |A| + |B| − |A∩B|` and random point membership (see `canvas-shapes.test.ts`).

### [core/canvas] SVG Arc Flags Can Be Written Without Separators

- **Issue / Symptom**: `a5 5 0 0110 0` was parsed as the flags `0`, `110` (or, with a number tokenizer, lost its leading zero), so arcs went to the wrong point.
- **Root Cause**: In SVG path data, the large-arc and sweep flags are single characters `0` or `1` and need no separator, so `0110 0` means flags `0`, `1` and `x = 10`. A regex tokenizer reads `0110` as one number.
- **Solution / Workaround**: `parseSvgPath` uses a scanner that reads exactly one character for the two flag slots of `A` / `a` and normal numbers elsewhere.

### [core/spreadsheet] Dynamic Arrays: Spill Ranges Are Only Known After Evaluation

- **Issue / Symptom**: A formula reading a spilled cell (`=A2*10` next to `A1` = `=SEQUENCE(3)`) showed 0 after loading a document or the first time the array spilled, and stayed stale when the array changed size; typing into a spilled cell or clearing a blocking cell didn't update the anchor; `=SEQUENCE(2)+A2` in A1 oscillated between a value and `#CYCLE!`.
- **Root Cause**: The dependency graph is built from formula text, but which cells an array covers depends on its *result*. Before the anchor is evaluated nothing links `A2` to `A1`, so the topological plan can evaluate `A2`'s dependents first. Spilled cells have no formula, so editing one never reached its anchor, and a blocked anchor had no edge to the cells blocking it.
- **Solution / Workaround**: Spilled values are derived state kept in the controller (never written to `document.cells`; `getCell` overlays them with `raw: ''` and `spillAnchor`). After placing a spill the controller calls `DependencyGraph.setSpillEdges(anchor, spilledKeys, blockingKeys)`: spilled cells depend on the anchor, a `#SPILL!` anchor depends on its blockers. These edges live apart from formula edges (so `setCellFormula` doesn't drop them) and `recalculateAll` clears them. `recalculateKeys` runs the plan in passes: when a pass changes which cells are spilled, it re-plans from those cells with their dependents, until nothing changes (capped). A cyclic anchor clears its values but keeps its spill edges so the cycle is still found on the next pass. `A1#` depends on the anchor only. The grid never grows to fit an array (Excel doesn't either): past the edge is `#SPILL!`. Sorting, merging or transposing a range that touches a spill is refused (`false`), like Excel's "can't change part of an array".

### [core/track-changes] Code Blocks Reject Marks via `marks: ""`, and `extendNodeSchema` Cannot Override It

- **Issue / Symptom**: Insertions and deletions inside code blocks were silently untracked, and an extension's `extendNodeSchema(() => ({ marks: "insertion deletion" }))` had no effect.
- **Root Cause**: TipTap's `CodeBlock` sets `marks: ""`, and `getSchemaByResolvedExtensions` spreads `extendNodeSchema` fields *before* the node's own fields, so the node's `marks` always wins. `NodeType.allowsMarkType` reads `markSet`, which is computed once when the schema is built.
- **Solution / Workaround**: `TrackChanges` (`trackCodeBlocks`, default on) appends the insertion/deletion mark types to `markSet` of every `code` textblock in `onBeforeCreate`, which runs after the schema is created but before the document is parsed. Formatting marks stay disallowed. Schemas built headlessly with `getSchema(extensions)` do not get the patch, so tracked marks inside code blocks are dropped there.

### [core/track-changes] Formatting and Block Changes Need Per-Step Detection and Final-State Comparison

- **Issue / Symptom**: Comparing whole documents to find formatting or block changes is slow and ambiguous; comparing per step misattributes changes when one transaction changes the same text or block twice (toggle list = wrap + join; `setNode` copies attributes, including the `blockChange` record, to the new node).
- **Root Cause**: `AddMarkStep` / `RemoveMarkStep` (and `ReplaceStep`s whose content only differs in marks) say *where* formatting changed; `ReplaceAroundStep` (setBlockType, setNodeMarkup, wrap, lift) and `AttrStep` say *which* textblocks changed. Only the old document (`oldState.doc`, or the record already stored on the old node) knows the original state.
- **Solution / Workaround**: Steps only collect ranges/textblocks (mapped to the final document). Afterwards each text segment is mapped back with the inverted mapping to the old document and its original formatting (the old `formatChange.before`, or its marks) is compared with the current marks; textblocks compare the original snapshot (type, attrs minus ignored ones like outline `id`, wrapper types) with the final one. Equal → the record is removed (the change was reverted). Textblocks with no counterpart in the old document (splits) are skipped, and `blockChange` uses `keepOnSplit: false`. Restoring wrappers on reject ports prosemirror-schema-list's `sinkListItem` / `liftToOuterList` for list items and uses `lift` / `wrap` + `join` otherwise. Limitation: outdenting a nested item that has following siblings re-parents those siblings without changing their depth, so they get no record and rejecting the outdent nests them one level deeper. Paragraph splits/joins are not tracked at all. Converting to a code block drops incompatible marks, which reject cannot restore.

### [core/compare] Whole Paragraphs Have No Inline Representation, So Compare Records Them as `blockChange` Operations

- **Issue / Symptom**: Marking an inserted paragraph's text with `insertion` (and a deleted one's with `deletion`) is not enough: rejecting the insertion (or accepting the deletion) removes the text but leaves an empty paragraph, so "reject all" never reproduced the original document after `compareDocuments`.
- **Root Cause**: ProseMirror block boundaries are not characters (unlike Word's paragraph marks), and `TrackChanges` deliberately does not track paragraph splits/joins.
- **Solution / Workaround**: `compareDocuments` records wholly inserted/deleted blocks as `blockChange` records with `operation: "insert" | "delete"` on every textblock inside (one change id per run; the text itself is not marked). `applyDecision` removes accepted deletions / rejected insertions first (`removeBlocks`), taking along containers whose textblocks are all removed (list items, lists, quotes, rows), and replaces an emptied document with an empty paragraph. The tracker never rewrites or clears records that have an `operation`. `getEditorText` strips tracked text with `<ins>`/`<del>` regexes, which cannot see whole-block operations, so documents containing them are resolved with `resolveTrackedChanges` and re-serialized before the text is extracted. Limits: atom blocks (images, rules) and textblocks without the `blockChange` attribute cannot carry a record (reported in `summary.notHonoured`); `blockChange` is `keepOnSplit: false`, so pressing Enter inside an inserted block leaves the new half untracked. Container attribute changes (task `checked`, ordered-list `start`) are not tracked either.

### [core/compare] Word Tokens With Trailing White Space Misalign Before Punctuation

- **Issue / Symptom**: With "word + trailing space" tokens (as in wordcraft), `Old line.` → `New line here.` reported `Old line` deleted and `New line here` inserted, because `line` (before `.`) and `line ` are different tokens.
- **Root Cause**: The trailing white space is part of the token key, so the same word differs by position.
- **Solution / Workaround**: Words, white-space runs and symbols are separate tokens; equal runs that are only white space between two changes are absorbed into one replacement (`stretches()`), so `a b c` → `x y z` stays a single deletion + insertion instead of alternating. Note that `ignoreCase`/`ignoreWhitespace` keep the revised text without a change, so reject-all cannot restore those differences (by design), and code blocks in a headless `getSchema()` schema (no tracked marks, see the code-block entry above) are compared as whole-block replacements.

### [react/spreadsheet] Cell Editor Drafts Must Reach the Controller

- **Issue / Symptom**: In the React `SpreadsheetEditor`, text typed into a cell was thrown away on Enter, Tab or blur (the cell kept its old value). Only the formula bar worked. Found in the demo; no jsdom test typed into the cell input.
- **Root Cause**: `useSpreadsheetEditor` returned React's own state setter as `setDraftValue`, but `commitEditing()` (called without an argument) commits `controller.draftValue`, which never changed. Svelte's `draftValue` setter already wrote through to the controller.
- **Solution / Workaround**: `setDraftValue` writes `controller.draftValue` and the React state. Any binding that keeps its own copy of the draft must keep the controller's copy in sync.

### [react|svelte/spreadsheet] Type-to-Edit Doubled the Key, and Focus Was Lost After Enter

- **Issue / Symptom**: Typing `1` on a selected cell produced `11` (React). After Enter, the next keys went nowhere because focus fell to `<body>`. In Svelte the cell input was never focused, so only the first key landed.
- **Root Cause**: The grid's keydown handler starts editing with `e.key` as the draft but did not `preventDefault()`, so the browser also typed the key into the newly focused input. When the cell input unmounts on commit, the browser moves focus to `<body>`.
- **Solution / Workaround**: Call `preventDefault()` when a printable key starts editing, focus the cell input with the caret at the end (React `autoFocus` + `onFocus`, Svelte `$effect`), and refocus the grid after Enter / Tab / Escape. In Svelte, typing in the formula bar also opens the cell editor, so only focus the cell input when no other input has focus. Browser automation that "types" with `Input.insertText` sends no keydown, so drive type-to-edit with key presses.

### [react|svelte/spreadsheet] Sticky Headers Need Opaque Backgrounds, and Fixed Menus Must Be Clamped

- **Issue / Symptom**: Scrolled cells showed through the sticky column-header row and the row numbers. The right-click menu opened near the bottom of the window ran off-screen, leaving its last items unreachable.
- **Root Cause**: The sticky cells used translucent `bg-muted/60`, `/50` and `/90`. The menu is `position: fixed` at the pointer with no viewport check, and fixed elements do not scroll with the page.
- **Solution / Workaround**: Use an opaque `bg-muted` on sticky cells. Measure the menu after render and place it with `clampMenuPosition` (core): flip above / left of the pointer, or slide back into the viewport, plus `max-height` and `overflow-y: auto`.

### [core/canvas] React Flow's Drag-Stop Change Undoes the Last Snap, and `NodeChange` Has Id-less Members

- **Issue / Symptom**: Smart guides snapped nodes while dragging, but on release the node jumped back a few pixels to the raw pointer position. Separately, `applyNodeChanges(arrange.snapPositionChanges(changes), nodes)` did not type-check with React Flow's `NodeChange[]`.
- **Root Cause**: xyflow keeps its own drag positions computed from the pointer and reports them again in the final `dragging: false` change (SvelteFlow writes them into `nodes` before `onnodedragstop`). React Flow's `NodeChange` union includes `{ type: 'add', item }`, which has no `id`, so it was not assignable to `PositionChangeLike`.
- **Solution / Workaround**: The arrange controller remembers the last snapped positions: `snapPositionChanges` rewrites the drag-stop change with them, and `endDrag()` writes them back after a SvelteFlow drop. `PositionChangeLike.id` is optional.

### [demo/theme] Library Components Read Theme Tokens Both as Tailwind Colors and as Raw CSS Variables

- **Issue / Symptom**: Without theme tokens, the spreadsheet, review panel and menus rendered unstyled in the demo (transparent popovers, invisible borders and selection).
- **Root Cause**: Components use shadcn classes (`bg-background`, `bg-primary/10`, `border-border`) and also inline styles such as `var(--primary, #6366f1)` and `var(--popover, …)`. shadcn's usual HSL-triple variables (`--primary: 240 5% 26%`) are invalid when used directly as a color, and Tailwind colors defined as plain `var(--x)` lose opacity modifiers.
- **Solution / Workaround**: The demo defines `--x-rgb` channels for Tailwind (`rgb(var(--x-rgb) / <alpha-value>)` in `apps/demo/tailwind.config.js`) and full colors `--x: rgb(var(--x-rgb))` for inline styles (`apps/demo/src/index.css`). Hosts using shadcn HSL triples should also define full-color `--primary`, `--background`, `--muted` and `--popover`.

### [core/image-editor] Changing How Saved Adjustments Render Needs a New Process Version

- **Issue / Symptom**: Improving the adjustment maths (linear-light exposure, Bradford white balance, tone LUTs) changed how every saved edit looked; `{ ...DEFAULT_ADJUSTMENTS, ...saved }` silently moved old edits to the new rendering. The old 8-bit path also clamped after each step, so exposure up then contrast down turned distinct highlights into one flat grey.
- **Root Cause**: Adjustment values have no meaning without the algorithm that interprets them, and a default spread fills a missing field with the *new* default.
- **Solution / Workaround**:
  1. `ImageAdjustments.process` selects the rendering. A missing or damaged value is process 1 (`normalizeProcessVersion`), which `applyLegacyAdjustments` renders unchanged (frozen; `tint` is ignored there). New edits and Reset get `LATEST_PROCESS_VERSION` (2). Load stored adjustments through `normalizeStoredAdjustments`, never `{ ...DEFAULT_ADJUSTMENTS, ...stored }`.
  2. Process 1 is serialized without `process` (and without a zero `tint`), so old documents round-trip byte for byte. `upgradeProcess()` is the one explicit, undoable way to move an edit forward.
  3. A future look change adds process 3 and a new branch in `applyAdjustments`; never edit process 1 or 2 output in place (bug fixes for broken output excepted). The legacy pixel snapshot in `tests/image-editor-color.test.ts` guards this.
  4. Process 2 is identity at neutral within ±1 only because the tone LUT's highlight shoulder degenerates to the identity when headroom is 1 and the encode LUT has 65 536 entries. Keep `headroom = max(1, reach)` per channel; a fixed shoulder would shift unedited highlights.
  5. The renderer's base-canvas cache key must include every field that affects pixels (`tint`, normalised `process`), or switching process shows a stale image.

### [core/image-editor] Adjustment Layers Must Not Change How Layer-Free Edits Load, Save or Render

- **Issue / Symptom**: Adding `layers` to the editor state risked re-serializing every old document (a new schema version, an empty `layers: []`), a stale preview after editing a layer, and a different look for edits that never used layers.
- **Root Cause**: Saved documents are compared and diffed as JSON; the renderer caches the adjusted base canvas by a key of the fields that affect pixels; and layer maths that ran on every pixel (even as an identity) would round values differently.
- **Solution / Workaround**:
  1. Layers live in `adjustments.layers` and are **absent** (not `[]`) when there are none: `normalizeStoredAdjustments`, `setAdjustments` and the layer methods delete the key for an empty list. Only states with layers serialize as `version: 2`; layer-free states stay `version: 1`, byte for byte. Load through `migrateSerializedImageEditorState` / `normalizeAdjustmentLayers`, which clean and clamp stored layers.
  2. `applyAdjustmentLayers` runs after the base process (1 or 2) and before blur, on the encoded 8-bit result, and skips neutral, disabled and zero-opacity layers entirely (`compileAdjustmentLayer` returns `null` for the identity), so no layers means no extra pass.
  3. The renderer's base key includes `adjustmentLayersKey(layers)`. Per-layer LUTs are cached by `kind + JSON(params)`, so slider drags only recompile the layer that changed.
  4. Levels work on whole levels (quantum 255) like Photoshop's 8-bit documents; Curves and Levels apply each channel's record before the master.

### [core/image-editor] Canvas `soft-light` Is Not Photoshop's Soft Light; Scalar Blend Fallback Must Stay Inside the Clip

- **Issue / Symptom**: Annotations drawn with `globalCompositeOperation = 'soft-light'` looked different from adjustment layers in Soft Light, and modes such as Linear Burn, Pin Light, Hard Mix, Subtract and Divide have no canvas operation at all.
- **Root Cause**: Canvas implements the W3C Compositing soft light; Photoshop's uses a different formula for a light source (`cs > 0.5`: `2·cb·(1 − cs) + √cb·(2·cs − 1)`). The other modes simply do not exist in Canvas 2D.
- **Solution / Workaround**: `BLEND_MODES[].canvas` lists an operation only where the maths match (`soft-light` is `null`). For the rest, `drawAnnotation` draws the annotation on a same-size layer with the same transform, blends it into a copy of the target pixels with `blendImageData`, and draws the result back with `globalCompositeOperation = 'copy'` under an identity transform: `copy` only replaces pixels inside the current clip, so the image-region clip still holds. Without pixel access (tainted or headless canvas) it falls back to a normal draw.

### [svelte/image-editor] Subscribing to a Controller Inside `$effect` Loops Forever

- **Issue / Symptom**: Mounting the Svelte `AdjustmentLayersPanel` threw `effect_update_depth_exceeded`, and the existing image editor test took 9 s before failing.
- **Root Cause**: `controller.subscribe(listener)` calls the listener synchronously; a listener doing `tick++` reads and writes `tick` inside the effect, so the effect depends on the state it writes.
- **Solution / Workaround**: Subscribe inside `untrack(() => controller.subscribe(...))` and return the unsubscribe function. Keep large per-render objects such as the histogram in `$state.raw`, so they are not deep-proxied on every render.

### [core/history] Keyed Gestures Merge Commands, so Commands Must Be Absolute or Untagged

- **Issue / Symptom**: A held gesture (`beginGesture`) that drags two parameters (volume and pan) into one undo step would redo only the last one, and undo would restore only one of them, if the merge kept "first undo + last redo" as the time-window `executeMerged` does.
- **Root Cause**: "Keep the first undo, take the last redo" is only correct when every merged command sets the *same* thing to an absolute value. Different parameters (or relative commands like "increment") need every command's undo and redo.
- **Solution / Workaround**: A keyed step keeps a list of parts. A merged command whose `tag` equals the last part's `tag` replaces that part's redo (absolute-command assumption, as before); anything else is appended, and undo runs the parts in reverse. Give absolute "set" commands a `tag` so long drags stay one small part; leave relative commands untagged. Gestures end on any other recorded command, undo, redo, `revertTo`, `goTo`, `clear` or `endGesture()`; reads, marks and empty batches do not end them.

### [core/history] Undo Marks Must Detect a Lost Start, Not Just a Lost Top

- **Issue / Symptom**: `revertTo(mark)` for a mark taken on an empty history (Escape on the first drag) would undo steps that existed before the drag once `maxDepth` / `maxBytes` had dropped the bottom of the stack, and a naive mark would survive `clear()`.
- **Root Cause**: A mark that points at "no top step" cannot be found in the stack, so "undo until the top is the marked step" runs to the bottom of whatever is left.
- **Solution / Workaround**: Marks carry the marked step's id plus a `dropped` counter and an `epoch` (bumped by `clear`). An empty-history mark is valid only while nothing has been dropped; any mark from an older epoch is a no-op returning 0. Reverted steps are removed outright (and undone steps made after the mark are filtered out of redo), so redo never brings a cancelled drag back.

### [core/dirty] Dirty Tracking Must Compare Values, Not Count History Steps

- **Issue / Symptom**: Navigation guards kept prompting after undoing back to the saved state, selecting text or zooming marked the document modified, and loading a file marked it dirty before the user typed anything.
- **Root Cause**: A "changed since save" boolean set by every edit never goes back to false on undo; whole-state comparison counts view state (selection, viewport); programmatic loads go through the same change paths as user edits.
- **Solution / Workaround**: Use `bindDirtyToHistory({ history, getValue, normalize })` (React `useHistoryDirty`, Svelte `createHistoryDirty`): every history change re-compares `normalize(value)` with the saved baseline (cached per `history.getRevision()`), so undo-to-saved is clean. Strip view state in `normalize`. Wrap loads/restores in `suppress(fn)`: it is re-entrant (depth counter), lasts until a returned promise settles, and rebaselines to the loaded value even if the load bypassed the history. Changes made outside the history (e.g. selection) need `refresh()`, which ignores the revision cache.

### [core/canvas] xyflow Resizers Report Raw Sizes, and SvelteFlow Writes Them After `onResize`

- **Issue / Symptom**: Resize snapping flickered back to the unsnapped size when the pointer was released (React Flow), or did nothing at all (SvelteFlow `onResize`).
- **Root Cause**: `XYResizer` keeps its own raw `prevValues`; React Flow's end change (`type: 'dimensions'`, `resizing: false`) carries those raw values, undoing the last snap. SvelteFlow's `ResizeControl` calls `onResize` *before* writing the raw `x` / `y` / `width` / `height` to `store.nodes`, so anything written from `onResize` is overwritten. The changes also do not say which handle is dragged.
- **Solution / Workaround**: React: `snapResizeChanges` remembers the last snapped size and rewrites the `resizing: false` change. Svelte: `resizerHandlers(id)` defers `resize(id)` / `endResize()` with `queueMicrotask`, after the resizer has written the raw size. The handle is inferred from the edges that moved since `beginResize` (`inferResizeHandle`). While resizing, read `width` / `height` before `measured` (`getResizingNodeRect`): `measured` is stale until xyflow re-measures.

### [core/canvas] Corner Detection on Polylines Breaks on Noisy or Coarsely Flattened Input

- **Issue / Symptom**: Curve fitting a freehand stroke produced dozens of tiny segments; fitted boolean results of small ellipses stayed polylines.
- **Root Cause**: A turning-angle test between adjacent edges reads sample jitter as corners (alternating ±0.3 px noise on 2 px steps turns ~33° per vertex), and a coarsely flattened small circle (radius ≲ 5 at tolerance 0.25) really does turn more than 30° per vertex.
- **Solution / Workaround**: `fitCubics` measures each vertex's turn to the nearest neighbours at least 4 × `tolerance` away and keeps only the sharpest vertex in that neighbourhood. For very coarse polygons raise `cornerAngleDeg`, or flatten with a smaller `tolerance`. `fitPathData` falls back to the original polyline when fitting would not remove vertices.

### [core/commands] Shortcut Handlers Must Not `preventDefault` Disabled Commands, and Mod Differs Per Platform

- **Issue / Symptom**: A global shortcut listener that calls `preventDefault()` on every bound chord blocks the browser and focused editors even when the command can't run (e.g. `Mod+Z` with nothing to undo). Separately, `Mod+Y` (redo) and an app binding on `Ctrl+Y` look different in the keymap but collide on Windows and Linux, and the collision is invisible when tests only run on macOS.
- **Root Cause**: Whether a chord should be consumed depends on the command's enablement at that moment, not only on the binding. `Mod` is ⌘ on macOS and Ctrl elsewhere, so whether two chords collide depends on the platform.
- **Solution / Workaround**: `CommandRegistry.handleKeyDown` resolves the command, checks `isEnabled`, and only then calls `preventDefault()` and runs it. `ShortcutMap.findConflicts(platform)` compares effective chords (with `Mod` resolved for that platform), and `commands.test.ts` asserts that the default keymaps have no conflicts on mac, windows and linux. Bindings that only make sense on some platforms use `platforms` (e.g. `Mod+Y` redo off macOS). Keys match by `event.code` (see "Option/Alt Shortcuts Must Match `KeyboardEvent.code`"). The one exception is `shortcutCode`: a letter key that produces a different Latin letter without Alt uses that letter, so `Mod+Z` follows the Z label on AZERTY, QWERTZ and Dvorak, as browsers do. Matching both the code and the key would fire `Mod+Z` from two different physical keys.

### [core/commands] Agent `listChanged` Only Fires When Tool Definitions Change

- **Issue / Symptom**: Registering or removing commands did not send `tools/list_changed` to agents using the command tool provider.
- **Root Cause**: `ToolRegistry` compares a JSON signature of `listTools()` (see "Tool-List Notifications Must Be Coalesced and Compared"). The three command tools (`list_commands`, `run_command`, `run_commands`) never changed, so their signature never changed either.
- **Solution / Workaround**: `run_command`'s `id` schema carries an `enum` of the visible command ids. The tool definition now changes when commands are added or removed, but not when they run or their enablement changes. `run_commands` keeps a free `id` string so that each step can report `unknown_command` on its own instead of the whole batch being rejected.

### [svelte/packaging] `Foo.svelte` and `foo.svelte.ts` Collide in `dist` on Case-Insensitive File Systems

- **Issue / Symptom**: `svelte-check` warned `Cannot write file '.../dist/commands/CommandPalette.svelte.js' because it would be overwritten by multiple input files` after adding `CommandPalette.svelte` next to a rune file `commandPalette.svelte.ts`.
- **Root Cause**: Both compile to `…alette.svelte.js` / `.d.ts`. On macOS and Windows file systems, which are case-insensitive, these are the same path, so one output silently replaces the other.
- **Solution / Workaround**: Give rune modules names that differ from component names by more than case (`palette.svelte.ts` next to `CommandPalette.svelte`).

### [monorepo/licensing] Ported Code Needs Its Notice in the Published Package, Not Just in Source

- **Issue / Symptom**: Files ported from the MIT/Apache ArtCraft apps carry a header comment and a root `THIRD_PARTY_NOTICES.md`, but neither reached npm: tsup strips comments from `dist`, and `@pixerate/editor` publishes only `dist`.
- **Root Cause**: MIT requires the copyright and permission notice in every copy, including the published package. A root-level file is outside the package's `files`.
- **Solution / Workaround**: `packages/core/THIRD_PARTY_NOTICES.md` is a copy listed in `files`. `tests/third-party-notices.test.ts` fails if it drifts from the root file. When porting more code, add a section to the root file and copy it into the package (and into `packages/react` / `packages/svelte` too if ported code lands there).

### [core/persistence] Autosave Must Not Overwrite the Previous Session's Snapshot Before the User Decides

- **Issue / Symptom**: After a crash, reopening the app showed the "Restore unsaved changes?" prompt, but the snapshot it offered was already replaced by the freshly loaded (unchanged) document, or by a clean meta written when the new session "saved".
- **Root Cause**: Autosave started as soon as the editor mounted: loading the document counted as a change, and a save in the new session retired whatever snapshot was in storage, including one this session never wrote.
- **Solution / Workaround**: `createAutosaveController` writes nothing until `ready()` (the hydration gate); `useAutosave` / `createAutosave` call it only after the recovery check found nothing or the user chose Restore / Discard. `markClean()` only writes a clean meta for a snapshot this session wrote (`createRecoveryPolicy().ownsSnapshot`), so a clean start never consumes an earlier session's snapshot. The snapshot is written before its dirty meta, so the meta never points at a missing snapshot.

### [core/persistence] Revision Listeners Can Run Before the Dirty Binding Updates

- **Issue / Symptom**: With `bindDirtyToHistory` and an autosave both subscribed to the same `HistoryManager`, undoing back to the saved state still wrote a snapshot (or a save was not noticed) depending on subscription order.
- **Root Cause**: `HistoryManager` notifies listeners in subscription order. If the autosave's listener runs first, the binding's `dirty` flag is still stale when it is read.
- **Solution / Workaround**: `createRevisionTracker` reads the dirty flag lazily in `savedRevision()`, and `AutosaveController.notify()` never ticks synchronously (it schedules a timer), so every history listener has run before the policy looks at the revisions. A stale clean read heals itself: when the binding then flips to dirty, the tracker bumps the revision.

### [core/persistence] OPFS Writes: `createWritable` and `move` Are Not Everywhere

- **Issue / Symptom**: An OPFS adapter that works in Chromium rejects every write in some Safari versions, or a crash mid-write leaves a truncated file.
- **Root Cause**: `FileSystemFileHandle.createWritable()` is missing on Safari's main thread in older versions (only `createSyncAccessHandle` in workers), and `FileSystemHandle.move()` (rename) is not universally available. Writing a file in place is not atomic.
- **Solution / Workaround**: `createOpfsAdapter` writes `<file>.tmp` and renames it over `<file>` where `move` exists, and otherwise alternates two slots (`.a` / `.b`) and swaps a `.ptr` file only after the slot is complete. Without `createWritable`, `set` rejects with `StorageUnavailableError`; feature-detect with `isOpfsAvailable()` and fall back to `createIndexedDbAdapter` or `createLocalStorageAdapter`. Only localStorage writes are synchronous, so on `pagehide` it is the only backend guaranteed to finish; `flushNow()` still starts the async write for the others.

### [core/generation] Prompt Limits Count Resolved Text, So the Planner Cannot Truncate Them

- **Issue / Symptom**: A 40-character prompt such as `{{style}} portrait` passed a model's 1000-character limit in the UI, but the provider rejected it: the template expanded to 1,400 characters. Truncating `request.prompt` to fix it cut the raw template text, which did not shorten the resolved prompt and could break a `{{tag}}` in half.
- **Root Cause**: Models limit what they receive (the resolved prompt), but the request carries the raw template. The length that counts and the text you can edit are different strings.
- **Solution / Workaround**: `prompt.countResolved` defaults to `true`. Pass the resolved text as `planGenerationRequest(…, { resolvedPrompt })`. When the resolved text is over the limit, the planner reports an error under every strategy and leaves the prompt alone. It only truncates when it measured the same string it would edit. `capabilitiesToJsonSchema` puts `maxLength` on `prompt` only when `countResolved: false`; otherwise the limit appears only in the description, so schema validation of a raw template does not give false passes or failures.

### [core/generation] Retried `generate` Calls Need Idempotency Keys That Compare Arguments and Forget Failures

- **Issue / Symptom**: An agent that timed out waiting for `generate` retried and was billed for two generations. A naive "seen this key" cache then made things worse: a call that failed upstream could never be retried, and reusing a key with a different prompt silently returned the old result.
- **Root Cause**: MCP clients retry on transport errors without knowing whether the first call ran. A key on its own does not say whether the retry is the same request.
- **Solution / Workaround**: `createGenerationToolProvider` stores `key → { signature, promise }`. The signature is a stable (sorted-key) JSON of the other arguments. A retry with the same key and arguments while the call is still running joins the same promise; once it has finished, the retry returns the cached result marked `deduplicated: true`. The same key with different arguments is an error. A rejected call removes its key so it can be retried. Keys are evicted oldest-first past `maxIdempotencyKeys`. The tool keeps `destructiveHint: true` together with `idempotentHint: true`, because repeating it with the same arguments has no further effect.

### [core/generation] Nearest-Option Snapping Hits Exact Ties on Log Scales

- **Issue / Symptom**: Snapping `720p` to `["480p", "1080p"]` or `1:1` to `["9:16", "16:9"]` returned whichever option came first, which changed when the server reordered its options.
- **Root Cause**: Resolutions and aspect ratios are compared on a log scale (pixel count, width/height). Common presets form geometric series, so 720p lies exactly between 480p and 1080p (both ratios are 1.5), and 1:1 lies exactly between 9:16 and 16:9.
- **Solution / Workaround**: `snapToOption` compares distances with an epsilon and breaks ties by rank, never by option order: `downgrade` picks the lower option, while `upgrade` and `nearest` pick the higher one. Integer and step rounding use the same rule (`count: 3` against `[2, 4]`). Tests for snapping should include an exact tie.

### [core/generation] Batch Resolvers Must Resolve Each Batch's Own Promises When the Cache Is Cleared Mid-Flight

- **Issue / Symptom**: After `resolver.clear()` was called while a batch was still fetching, the `load()` promises waiting on that batch never settled.
- **Root Cause**: The batch looked up waiters in the shared in-flight map when the fetch returned, but `clear()` had already emptied that map.
- **Solution / Workaround**: `createBatchResolver` captures each batch's pending entries when the fetch starts and always resolves them. It only writes the result to the cache if the in-flight entry is still the same object, so values from before a `clear()` do not come back. A failed batch resolves its keys to `undefined` and records them as failed (`failed(key)`), so a bad response does not cause a retry storm. `clear(key)` allows a retry.

### [core/grammar] New Syntax Inside `{?…}` Collides With Names That Were Already Valid

- **Issue / Symptom**: Adding comparison conditions as `{?amount>100}…{/amount>100}` (or any new syntax inside `{?…}`) would have silently changed prompts that already used `=`, `<` or `>` in a section name, and `JSX` attribute strings like `defaultSource="a\nb"` in tests kept a literal backslash-n instead of a newline.
- **Root Cause**: A section name was "anything but `|` and `\`", so every candidate syntax inside the braces (`{?a>1}`, `{?=a>1}`, even `{?a|>1}`, which is a variable) already meant something. JSX attribute strings are not JavaScript string literals and do not process escapes.
- **Solution / Workaround**: The comparison is recognised only when the open tag is closed by its bare subject (`{?amount>100}…{/amount}`), a pairing the old grammar always reported as unbalanced; `{?a>1}…{/a>1}` keeps its old meaning. `matchConditionalTags` searches for an exact name or a comparison subject, which picks the same partner as before for every diagnostic-free prompt. `grammar.test.ts` proves this by swapping `= < >` for neutral symbols and comparing old and new results on random prompts. Record-level directives (`{!next}`) were rejected for the same reason: `{!next}` is already an "unless" section. In JSX tests, pass multi-line strings as `{"a\nb"}`.

### [core/canvas] Auto Layout Must See Flow Changes Before They Are Applied, and Must Not Ping-Pong With Measuring

- **Issue / Symptom**: Deleting a child of an auto layout frame left the frame at its old (hugging) size, and relayout after every measured `dimensions` change could keep re-writing node sizes.
- **Root Cause**: A React Flow `remove` change only carries the id; once `applyNodeChanges` has run, the node and its `parentId` are gone, so the frame to relayout is unknown. SvelteFlow calls `ondelete` after removing the nodes. Writing `width` / `height` makes xyflow re-measure the node, which emits another `dimensions` change.
- **Solution / Workaround**: Pass each `onNodesChange` batch through `autoLayout.noteChanges(changes)` *before* applying it (it records the parents of removed nodes) and flush after the nodes update (`useCanvasAutoLayout` flushes in a layout effect, the Svelte rune on a microtask; Svelte's `nodesDeleted(nodes)` reads `parentId` from the deleted node objects). Layout passes only return updates that differ by more than 1e-6 and `flush` writes nothing when there are none, so a re-measure with the same size ends the loop.

### [core/canvas] Child Order in Auto Layout Frames Is the Node Array, Which Must Keep Parents First

- **Issue / Symptom**: Moving a flow child to a new slot by splicing the node array made xyflow warn about (or misplace) the moved node's own children.
- **Root Cause**: xyflow requires every parent to come before its children in the array. Moving a node later than its descendants breaks that, and moving it earlier than its parent too.
- **Solution / Workaround**: `moveLayoutChild` puts the siblings back into the array slots they already occupied (in the new order) and then runs a stable parents-first pass. Use it (or `autoLayout.moveChild`) instead of splicing; `zIndex` stays independent of layout order.

### [react/svelte] Spreading a Controller Object Snapshots Its Getters

- **Issue / Symptom**: `useCanvasAutoLayout(...).hasPending` (and `guides` before it was re-declared) never changed after the first render.
- **Root Cause**: `{ ...controller }` copies the *value* a getter returns at spread time, not the getter.
- **Solution / Workaround**: Re-declare live properties as getters (or state) on the object the hook / rune returns after the spread, as `useCanvasAutoLayout` and `createCanvasAutoLayout` do for `hasPending` and `guides`.

### [core/spreadsheet] Number Formats Must Round the 15-Digit Decimal String, Not the Binary Value

- **Issue / Symptom**: `(2.675).toFixed(2)` is `"2.67"` and `(1.005).toFixed(2)` is `"1.00"`, but Excel shows `2.68` and `1.01` with `0.00`. Porting Rust's `format!("{:.*e}")` to `toExponential` also differs on exact ties (Rust rounds half to even, JS picks the larger digit), and `toExponential` stops at 100 digits, too few for the exact expansion of a double (up to 767 digits).
- **Root Cause**: Excel first writes a number with 15 significant digits, then rounds that decimal string half away from zero. An exact tie at the 16th digit (`1234567890123455`) goes toward zero.
- **Solution / Workaround**: Always format through `numfmt/decimal.ts` (`decimalDigits` → `fixedFromDigits`), never `toFixed`. It takes 16 digits from `toExponential(15)`; only when the 16th digit is a 5 does it check for an exact tie, using the exact decimal expansion computed with `BigInt` from the double's bits. The tie rules are covered by `tests/number-format.test.ts`.

### [core/spreadsheet] Number Formats See Dates as ISO Text, and the 1900 Leap Day

- **Issue / Symptom**: A date cell (`"2026-03-04"`) formatted with `0.00` or `dddd` must behave like Excel's serial 46085; `dateToSerial` gives serials one too low before 1900-03-01, and serial 60 (the fictitious 1900-02-29) has no ISO text.
- **Root Cause**: Our engine stores dates as ISO text and times as day fractions, while format codes work on 1900-system serial numbers.
- **Solution / Workaround**: `dateValueToSerial` (used by `NumberFormat.format`, `formatCellForDisplay` and `TEXT()`) converts ISO text with `serialFromYmd`, which counts the fictitious leap day; `renderDate` maps serial 60 to 2/29/1900 and serial 0 to 1/0/1900, as Excel does. Only ISO text is converted in cell display: other numeric-looking text stays text (Excel shows text through the `@` section). Only the 1900 date system is supported.

### [svelte/spreadsheet] Mutating a Cell Object in Place Does Not Re-Render It

- **Issue / Symptom**: Setting `cell.numberFormat` on the stored cell object and calling `notifyChange()` updated the controller, but the Svelte grid kept showing the old text (React happened to re-render).
- **Root Cause**: The Svelte grid reads cells through `{@const cell = sheetState.getCell(...)}`; Svelte deriveds compare with `===`, so the same object means nothing downstream re-runs.
- **Solution / Workaround**: Controller operations replace cell objects (`cells[colId] = { ...cell, numberFormat }`) instead of mutating them. Do the same for spilled display cells (`spillCells.set(id, {...})`).

### [core/spreadsheet] A Format-Only Blank Cell Over a Bound or Column-Formula Value

- **Issue / Symptom**: `setCellNumberFormat` on a bound record cell or a column-formula cell has nowhere to put the format: those cells are derived, and a stored blank cell normally hides the derived value (it means "cleared").
- **Root Cause**: `getCell` returns a stored cell with empty `raw` before looking at derived values.
- **Solution / Workaround**: A stored blank cell with `explicitNumberFormat` is treated as format-only: `getCell` returns the derived value with that format (`{ ...derived, numberFormat }`). Known limitation: a cleared column-formula cell that also has an explicit format therefore shows the column value again.

### [core/find-replace] JavaScript `RegExp` Backtracks, So Word Wildcards Cannot Be Translated to a `RegExp`

- **Issue / Symptom**: Translating Word's wildcard patterns to a `RegExp` (as WordCraft does for Rust's linear-time `regex` crate) freezes the tab on patterns such as `(a@)@b` (`(a+)+b`) or `*a*a*b` (`.*?a.*?a.*?b`) against a long paragraph without a match: exponential or high-polynomial backtracking inside a single `exec`, which cannot be interrupted.
- **Root Cause**: V8's irregexp is a backtracking engine. Rejecting nested quantifiers is not enough: several adjacent lazy `*` runs are polynomial (O(n^k)), and a time check between `exec` calls never runs while one call is stuck.
- **Solution / Workaround**: Special-character and wildcard patterns compile to a small program run by a Pike VM (`packages/core/src/extensions/find-replace/pattern.ts`), which is O(text × program) for any pattern; counted repeats are expanded and the program is capped at 20 000 instructions (`too_complex`), the Find text at 1 024 characters (`too_long`), and every search has a shared budget (VM steps, wall-clock `timeLimitMs`, `maxMatches`) reported as `truncated`. Only the raw `regex` option uses `RegExp`: it rejects a repeated group containing a repeat (`(a+)+`, `(\w*)*`) and checks the deadline before each `exec`, but cannot stop a single runaway call; leave regex mode out of your UI if users can search very large documents. Also: in a VM thread loop, when no thread is alive at a position (an assertion like `<` failed), advance and bump the list generation instead of stopping, or later matches are missed.

### [core/find-replace] Search Text Must Skip Tracked Deletions but Keep Their Neighbours as Context

- **Issue / Symptom**: With Track Changes on, Replace found its own struck-through text again and never advanced; `catfish` was found across a deleted space; or `fish` (whole word) was found right after a deleted space although the live text reads `catfish`.
- **Root Cause**: Tracked deletions stay in the document with a `deletion` mark, and replacing while tracking re-inserts the found text as a deletion. Simply concatenating all text nodes searches deleted text; searching each live run separately loses the neighbouring live characters that word-boundary assertions need.
- **Solution / Workaround**: Build one search string per textblock from the non-deleted runs (with a per-character map back to document positions), record a "cut" wherever deleted text was skipped, and search each cut segment with the whole string as context (the Pike VM checks assertions against the full string; the regex path searches a prefix with `lastIndex`). Paragraphs are only joined (with `\r`) when the pattern can match `^p`. Replacements go through ordinary `replaceWith`, so the `TrackChanges` `appendTransaction` turns them into tracked deletions and insertions in the same undo step.

### [core/serializers] Lazy and `[^>]*` Regexes Are Quadratic (or Cubic) on Malformed HTML

- **Issue / Symptom**: `extractMentions` took 227 s on 4,000 repetitions of `<span data-type='mention' ` (no `>`), and `htmlToPlainText` grew 4× per doubling of such input. A "linear time" test only passed because its input was small enough to stay under an absolute 1 s budget, and it flaked once the suite grew.
- **Root Cause**: `/<span\b[^>]*\b(?:a|b)[^>]*>/` backtracks over every split of the two `[^>]*` runs (cubic) when no `>` follows; `/<[^>]+>/g`, `/<pre[\s\S]*?<\/pre>/g`, ```` /```[\s\S]*?```/g ```` and `/\]\([^)]*\)/g` rescan to the end of the input from every opener that has no closer (quadratic).
- **Solution / Workaround**: Use the scanners in `packages/core/src/serializers/html-scan.ts` (`findTagSpans`, `replaceTagSpans`, `stripTags`, `replaceDelimited`). They find each closer once, reuse it until the scan passes it, and stop when none is left. `tests/html-scan.test.ts` checks they match the old regexes on random input and that time grows linearly. When testing performance, assert growth between two sizes rather than an absolute time, which depends on machine load. `preprocessMarkdownMentions` had the same problem through `MARKDOWN_MENTION_SPLIT_REGEX` (219 s on 4,000 unclosed mention spans); it now splits with `splitMarkdownMentionParts`, a single forward scan with cached closers. The regex stays exported as the reference definition only, so don't use it on untrusted input.

### [core/canvas] Token-Bound Properties Are Materialised Into the Nodes, Not Resolved at Render Time

- **Issue / Symptom**: Resolving token bindings inside node renderers would leave auto layout, measuring, exports and copy / paste seeing stale literals (a bound `gap` would never move children), and a node whose variable was deleted would show nothing.
- **Root Cause**: Auto layout, arrange, clipboard and xyflow itself read ordinary node fields (`data.layout.gap`, `style`, `data.shape.fill`); only a renderer knew about the binding. Deleted variables no longer resolve, so a render-time lookup has no value to show.
- **Solution / Workaround**: `resolveCanvasTokens` writes each resolved value into the node field it drives and returns the same array when nothing changed, so it can run after every token or node change without looping (`useCanvasTokens` / `createCanvasTokens` do this). A binding that does not resolve keeps the last written value; on delete, detach with `detachTokenBindings(nodes, event.previous, event.deletedVariableIds)` using the state from *before* the delete. Canvas undo is separate from token undo: undoing a token delete brings the variable back but not the detached bindings.

### [core/tokens] Alias Cycles Must Be Checked Across Every Mode, and W3C Names Cannot Be Both Token and Group

- **Issue / Symptom**: `a → b` in Light and `b → a` in Dark looked acyclic per mode, but resolving `a` with a context of another collection (or after the default mode moved) looped; exporting `color` and `color/bg` produced invalid DTCG JSON (a token with children).
- **Root Cause**: Aliases are resolved with the target's own collection mode, so a chain can switch modes part-way; DTCG distinguishes tokens (`$value`) from groups, and names map onto paths.
- **Solution / Workaround**: `checkTokenAlias` searches alias edges of all modes (refusing any cycle), `resolveToken` still guards with a visited set and reports `cycle`. Variable names refuse `.`, `{`, `}` and a leading `$` per group, and a name that is a prefix group of another (`color` vs `color/bg`) is refused with `name-conflict`.

### [core/import] PDF Column Gutters: One Stray Line Hides a Table's Column Gap, and Tolerating It Lets the Gap Leak Into a Column

- **Issue / Symptom**: An unruled table under a paragraph lost its columns (the paragraph's short last line crossed every column gap), and after tolerating a few crossing lines the header cell `Unit` was read as a separate full-width line, splitting `Meter` off the table.
- **Root Cause**: Gutters were the strips no narrow fragment covers. A strict "no coverage" rule fails on any stray crossing line; a coverage depth tolerance (`≤ 8 %` of narrow fragments) also accepts strips where one fragment merely *ends* or *starts* inside, so the strip starts inside a column and that fragment "crosses" it.
- **Solution / Workaround**: `readingOrder` in `packages/core/src/import/pdf-layout.ts` sweeps coverage depth with the tolerance, then shrinks each strip to the last fragment end and first fragment start inside it, so only fragments spanning the whole strip count as strays, and keeps it only when the strays are fewer than the fragments on either side (otherwise the "gutter" is the ragged end of one long line next to a short one). Short lines crossing gutters right above or below a grid are pulled into it (spanning header / totals rows) and peeled back to the neighbouring paragraph by `alignedTable` when they don't start on a column edge.

### [core/import] pdf.js: Bold Is Only Known After the Operator List, `constructPath` Changed in v5, and Clip Paths Look Like Rules

- **Issue / Symptom**: Every text item looked regular-weight (item `fontName` is an id like `g_d0_f2`, `styles[...].fontFamily` is usually `sans-serif`); rule extraction found nothing on pdf.js 5; every clipped cell (`re W n`) became a table border.
- **Root Cause**: `page.commonObjs.get(fontName)` (with `name`, `bold`, `black`, `italic`) only resolves once fonts are loaded, which `getOperatorList()` does; `get` throws for unresolved ids. pdf.js ≤ 4 encodes `constructPath` as `[ops, args, minMax]` followed by a paint operator; pdf.js 5 as `[paintOp, [Float32Array path], minMax]` with its own path codes. Clipping paths end with `endPath`, not a paint operator.
- **Solution / Workaround**: The adapter calls `getOperatorList()` before `getTextContent()`, checks `commonObjs.has(id)` before `get` (inside `try`), and `pdfOperatorListToRules` handles both `constructPath` forms, keeps path pieces only until a stroke/fill operator paints them (dropping them on `endPath`), and keeps filled rectangles only when they are thin bars. Pass `rulingLines: false` to skip the operator list.

### [core/import] PDF Running-Header Detection Normalises Digits, So Synthetic Fixtures Must Vary Words

- **Issue / Symptom**: A three-page test fixture lost its first body line on every page as a "running header".
- **Root Cause**: Edge rows are compared with digits replaced by `#` so `Page 3 of 9` matches `Page 4 of 9`; generated prose like `p1w0 p1w1 …` / `p2w0 p2w1 …` then normalises to the same text on every page.
- **Solution / Workaround**: Build multi-page fixtures from different words per page (not just different numbers). Real body text practically never repeats at the same page edge across half the pages. Separately, use loop-based `minOf` / `maxOf` instead of `Math.min(...values)` on per-page arrays: spreading tens of thousands of fragments overflows the call stack.

### [core/track-changes] A Move Is a Cut and a Later Paste, So It Must Be Linked Across Transactions

- **Issue / Symptom**: Cutting a paragraph and pasting it elsewhere with tracking on produced an unrelated deletion and insertion (two changes to accept or reject separately), and accepting the deletion of a whole paragraph left an empty paragraph behind. Typing right after moved text joined the move.
- **Root Cause**: ProseMirror's cut is one transaction (`uiEvent: "cut"`) and the paste another (`uiEvent: "paste"`); nothing in the paste says where the text came from, and `transformPasted` strips review marks from the pasted slice. Only a drag (`uiEvent: "drop"`) deletes and inserts in one transaction. Block boundaries are not characters, so removing a paragraph's text leaves the block. `adjacentAttributes` reuses a neighbouring change's attributes, including `moveId`.
- **Solution / Workaround**: The tracker gives a tracked cut a change of its own and remembers it (id, normalized text, author) in the plugin closure; the next user transaction clears it unless it is a paste by the same author of the same text (white space ignored) whose deletion is still in the document. Then the deletion marks get `moveId` = the cut's change id and the pasted text an insertion with the same `moveId`. A drop links its own deletion and insertion when their texts match. Both are gated by `isMove` (default `isMoveSized`: a paragraph or a sentence of two or more words, as in Word). `adjacentAttributes` skips marks with a `moveId`. When a move is resolved, a removed end that fills a whole top-level textblock deletes the block (`deleteWholeBlock`); nested blocks (list items, quotes) keep their emptied paragraph. `getEditorText` resolves documents with moves through `resolveTrackedChanges` for the same reason; `htmlToPlainText` on HTML alone cannot remove the emptied block. Limitation: moving text that is itself the destination of an earlier move by the same author really deletes it (own insertion), leaving the earlier move with only its source.

### [core/paragraph-styles] Style CSS Loses to Inline Attributes, `onCreate` Is Deferred, and Enter Handlers Race

- **Issue / Symptom**: (1) A style's alignment from the injected stylesheet did not show on paragraphs with direct alignment, and with `TextAlign.configure({ defaultAlignment: "left" })` it never showed. (2) The `<style>` element added in `onCreate` was missing right after `new Editor(...)`. (3) Implementing next-style as an Enter keymap makes it depend on extension order: it either never runs (core keymap's `splitBlock` first) or pre-empts other Enter handlers (lists, suggestion popups). (4) Heading 5 applied in an editor configured with `levels: [1, 2, 3, 4]` rendered as `<h1>`.
- **Root Cause**: (1) TextAlign renders `style="text-align: …"` inline, which beats any stylesheet rule; with a non-null default every paragraph has it. (2) TipTap emits `create` in a `setTimeout`. (3) TipTap orders keymaps by priority and then reversed extension order. (4) Heading's `renderHTML` falls back to the first configured level.
- **Solution / Workaround**: (1) Applying a style resets `textAlign` to its default (`null`), so the stylesheet's alignment shows; when the default is not `null`, the style's alignment is written to the attribute instead. (2) CSS is injected in `onBeforeCreate` and removed in `onDestroy`. (3) Next-style runs in `appendTransaction`: when a single transaction turned an empty-selection caret at the end of a styled textblock into a new empty sibling block, the new block gets the style's `next` (merged into the same undo step). Splitting mid-paragraph keeps the style (`keepOnSplit: true`). (4) `isParagraphStyleAvailable` checks the heading extension's `levels`; `setParagraphStyle` refuses and the gallery hides unavailable styles. Style values are sanitized (`safeCSSValue`) and ids restricted to `[A-Za-z][A-Za-z0-9_-]*` because both end up in a stylesheet.

### [core/mentions] A Mention Role Attribute Named `role` Would Capture Existing Entity Fields

- **Issue / Symptom**: Adding a `role` node attribute to the Mention extension made `data-role="admin"` appear on user mentions. Apps pass their whole entity (with a job-title `role` field) as suggestion props, and TipTap keeps every prop that matches a declared attribute.
- **Root Cause**: TipTap's mention `command` inserts `{ type, attrs: props }`, so any attribute name you declare picks up a same-named field from existing entity objects. Before, undeclared attributes were dropped.
- **Solution / Workaround**: The node attribute is `assetRole` (rendered as `data-role`). `extractMentionsFromDoc` reports it as `role`. Text syntax (`@fox:style`) is opt-in (`{ roles }`), because `@john:hi` already meant "mention john, then `:hi`". Only `preprocessMarkdownMentions` and `extractMentions` with `roles` set, and `findTextMentions`, read it.

### [core/generation] `generation` Must Not Import the Mention Serializers, and Recreate Must Not Re-Plan Twice

- **Issue / Symptom**: Re-exporting `findTextMentions` from `@pixerate/editor/generation` broke the entry-isolation test, which pulled ProseMirror into the generation bundle. Separately, recreating a record by re-planning the original settings in `exact` mode changed values the user never saw change: a record planned when `4k` snapped to `2k` re-snapped to `4k` once the model gained `4k`.
- **Root Cause**: `serializers/mentions.ts` imports `escapeHtml` from `plain-text.ts`, which imports ProseMirror. An exact reproduction has to start from what was sent (the planned request), not from what the user asked for.
- **Solution / Workaround**: The text-only mention helpers live in the dependency-free `serializers/mention-text.ts`, and both entries re-export them. `exact` plans the recorded planned request (any change is `setting-unsupported`). `latest` plans the recorded original settings (differences are `setting-changed`). Mentions are kept in `record.mentions` so `latest` can rebuild them. Capability hashes leave out presentation fields and `timing`, so renaming a model is not drift.

### [svelte/packaging] `import type` in a `.svelte` File Still Counts as an Entry Dependency

- **Issue / Symptom**: The Svelte entry-isolation test failed for `generation/index.js` with `@pixerate/editor/grammar` after `GenerationHistory.svelte` gained `import type { Template } from '@pixerate/editor/grammar'`. The React build of the same import passed.
- **Root Cause**: `svelte-package` ships `.svelte` sources as they are, so type-only imports stay in the published file (tsup erases them from React's JS).
- **Solution / Workaround**: In Svelte components, take types only from the entry's own core subpath. Derive the rest when needed (`type Template = NonNullable<RecreateOptions['templates']>[number]`).

### [core/image-editor] Iterated Box Blurs Must Run on Padded Lines, or a Zero-Edge Feather Loses Mass

- **Issue / Symptom**: Feathering a selection with a large radius (the three-box-pass Gaussian used above σ 8) was up to 0.18 off a direct Gaussian next to the image border; the direct kernel below σ 8 matched to 1/255.
- **Root Cause**: "Zero beyond the image" means one convolution of the zero-padded signal. Running each box pass on the clipped line throws away the coverage the previous pass spread outside the image, so every pass loses more of it at the edges.
- **Solution / Workaround**: `gaussianBlur` (`selection/modify.ts`) runs the three passes on a line padded by the passes' total radius (zeros, or replicated ends for `clamp`) and only crops at the end. The remaining difference (≤ 0.03) is the box approximation itself; `tests/image-editor-selection.test.ts` checks both regimes against a direct Gaussian and that the cost does not grow with the radius.

### [core/image-editor] Selections Are Immutable Masks Shared by History; Layer Masks Are RLE Strings

- **Issue / Symptom**: Encoding the selection into every undo snapshot made each slider commit cost O(pixels); a `Uint8Array` inside an adjustment layer did not survive the `JSON.parse(JSON.stringify(...))` copies the controller makes of layers; adding a `selection: null` or `mask: undefined` key would have changed how every existing document serializes.
- **Root Cause**: History entries are built from `serializeState()` on every recorded change, layers are deep-copied as JSON everywhere, and saved documents are compared as JSON.
- **Solution / Workaround**:
  1. `SelectionMask` objects are never mutated; every operation returns a new one, and history entries keep a reference next to the serialized state (`HistoryEntry.selection`). Only `toJSON()` run-length encodes it, and only when something is selected.
  2. `AdjustmentLayer.mask` stores the RLE string (`{ width, height, rle, density?, feather?, enabled? }`); `decodeLayerMask` / `layerMaskCoverage` decode on render behind a small LRU keyed by the string. `normalizeAdjustmentLayer` only sets `mask` when it is usable and leaves default density / feather / enabled out.
  3. The renderer's base key includes a hash of the mask (`layerMaskKey`), and `buildLayerMaskPlanes` returns `undefined` for mask-free stacks so they take the old code path.
  4. Layer masks live in natural pixels like annotations: `projectMaskCoverage` unprojects each base pixel through the same `ImageProjection` as the image (crop, rotation, flips), so never draw a mask with hand-rolled transforms.

### [react/image-editor] `useImageEditor({ image })` Reloads Whenever `image` Is a New Object

- **Issue / Symptom**: A test host doing `useImageEditor({ image: fakeImage(20, 10) })` hung the render (the test timed out on the first `act`).
- **Root Cause**: The hook reloads the source when `options.image` changes identity; `loadImage` notifies, the host re-renders, builds a new image object, and the cycle repeats.
- **Solution / Workaround**: Pass a stable `image` (a string, or an element created once outside the render). Selection tools also need pixels: a new source clears the sampled pixels, so call `controller.setSamplePixels(...)` after loading when there is no canvas (tests, workers, cross-origin images).

### [core/spreadsheet] Multiple Sheets: `document` Is the Sheet Being Worked On, and Dependency Keys Must Name Their Sheet

- **Issue / Symptom**: With several sheets, `A1` in the dependency graph meant a different cell on every sheet, so editing `Data!A1` recalculated the wrong formulas (or none), and cross-sheet cycles went undetected. Rewriting the whole controller to take a sheet argument would have touched every method.
- **Root Cause**: The controller was written for one `document` (`getCell`, spills, `evalSingleCellByKey`, table operations all read `this.document`), and graph keys were bare A1 text.
- **Solution / Workaround**: Each sheet is a runtime (`doc` plus its spill maps and saved selection). `document` and the spill maps are getters on the *current* runtime, which is the active sheet except inside `withSheet(rt, fn)`: cross-sheet reads (`resolveCell(col, row, sheet)`), recalculation and imports into another sheet switch to that sheet's runtime and back (in `finally`). Graph keys are always `SHEETID!A1` (`qualify` / `unqualify`, upper-cased, so whole-column keys become `SHEETID!A:`); spill maps keep bare keys because they are per sheet. One workbook-wide graph keeps recalculation topological across sheets. Notify bindings with the *active* sheet (`this.active.doc`), not the current one. Use sheet ids, not names, for keys, name scopes and undo entries: names change.

### [core/spreadsheet] Sheet Prefixes in Formulas: `Sheet1` Looks Like a Cell, `!=` Is an Operator

- **Issue / Symptom**: Rewriting `Sheet1:Sheet3!A1` after a rename produced `'Sheet1:End'!A1`; `=A1!=B1` and `='text'!=1` stopped parsing once `X!` became a sheet prefix; a quoted-prefix look-ahead could rescan the rest of a formula full of apostrophes from every quote.
- **Root Cause**: The lexer's cell pattern (`[A-Za-z]+\d+`) has no column limit, so it calls `Sheet1` a cell reference; Excel only quotes names that are cells within its grid (columns up to `XFD`). `!=` is this engine's alias for `<>`. `'` also starts this engine's single-quoted strings.
- **Solution / Workaround**: `sheetNameNeedsQuotes` uses a bounded cell test (1–3 letters ≤ XFD, row ≤ 1048576) plus R1C1 and boolean look-alikes. The lexer treats `X!` as a prefix only when `!` is not followed by `=`, and looks for `'name'!` at most 64 characters ahead (31-character names with doubled quotes), falling back to a string; the workbook test checks the growth ratio. Tokens carry `sheet`, `sheetEnd`, `refStart` and `end`, so `mapFormulaReferences` rewrites only the reference text after the prefix and keeps the prefix unless the result is `#REF!`.

### [core/spreadsheet] LAMBDA Needs Environment Chains, Not a Scope Stack, and Names Must Not See the Caller's Variables

- **Issue / Symptom**: With LET's scope stack, a lambda created in one LET and called inside another saw the caller's variables (`LET(k,10,f,LAMBDA(x,x+k),LET(k,1000,f(1)))` gave 1001), a defined name `=Rate*2` could pick up a LET variable named `Rate`, and runaway recursion (`Loop = LAMBDA(n, Loop(n+1))`) overflowed the JavaScript stack.
- **Root Cause**: Closures capture the environment where they are created; a stack only knows where they are called. A defined name is evaluated where it is used, but its formula belongs to the name's scope.
- **Solution / Workaround**: Variables live in linked `FormulaEnvironment`s; `FormulaLambda` keeps its creation environment (and, for sheet-scoped names, the sheet unqualified references mean), and calls install `{ params, parent: lambda.env }`. Defined names evaluate with `env = null` and a name stack that reports self-reference as `#CYCLE!`. Calls deeper than `MAX_LAMBDA_DEPTH` return `#NUM!`, and a `RangeError` from a smaller stack is caught in `evaluateWithDiagnostics` and reported as `#NUM!` too, so every save/restore of evaluator state must be in `finally`. Omitted arguments bind `''` but are recorded per environment, so `ISOMITTED(x)` is FALSE for an explicitly passed blank cell. Dependencies through names are expanded when a formula is registered (the cells a name refers to become the formula's dependencies), and any name change runs `recalculateAll`, because a new sheet-scoped name can shadow a workbook one.

### [core/spreadsheet] Defined Names Lived Only in `getWorkbook()`, So Apps Saving `onDocumentChange` Lost Them

- **Issue / Symptom**: An app that saves only the document from `onDocumentChange` (the single-sheet API, `useSpreadsheetEditor`, `createReactiveSpreadsheet`) lost every defined name on reload, and formulas using them showed `#NAME?`. `new SpreadsheetController({ document })` had nowhere to read names from.
- **Root Cause**: Names were kept in the controller's workbook-wide `this.names`, and only `getWorkbook().names` saved them. A sheet document had no field for them.
- **Solution / Workaround**: `SpreadsheetDocument.names` holds the names a sheet uses: all workbook-scoped names plus its own sheet-scoped names. `this.names` stays the source of truth. `notifyChange` (and the constructor) rewrites every live sheet document's `names` with copies (`syncDocumentNames`), so the document passed to `onDocumentChange`, `controller.document` and the bindings' copies are always current, after undo and redo too. When names are loaded from a document, any `sheetId` means "this sheet", because the sheet's id can change on load. `loadDocument` replaces that sheet's names, and also the workbook names when it is the only sheet. With several sheets, it merges the workbook names instead (the document's names win). `addSheet({ document })` only adds names that are missing. When a workbook is loaded, `workbook.names` wins and names found only in `sheets[*].names` are added (first sheet wins), so a workbook rebuilt from saved documents works. To avoid duplicating names in every sheet, `getWorkbook()` and workbook undo snapshots leave out the per-sheet copies (`withoutNames`). If they kept them, an undo could bring back stale names. The constructor makes shallow copies of `options.workbook.sheets`, so `names` is never written into the caller's objects. Without these copies, reusing those objects later (for example in `loadWorkbook`) brought back names the caller had dropped.

### [core/spreadsheet] One Edit Can Change the Conditional Look of Cells It Does Not Touch

- **Issue / Symptom**: Re-evaluating conditional formats only at the edited cell left colour scales, data bars, top-N, above-average and duplicate highlights stale in the rest of the range, and missed formula rules (`=$A1>B$1`) and cells whose formulas depend on the edited cell.
- **Root Cause**: Scales, bars, icons, top/bottom, averages and duplicates are computed from statistics over the whole applies-to range; formula rules can read any cell; and a typed value changes every dependent formula's value.
- **Solution / Workaround**: The controller records every cell key its evaluation plan visits (the edited cell, its dependents and their spilled cells) and `ConditionalFormatEngine.update(rules, changed)` re-evaluates: the whole range of statistical rules whose range contains a changed cell (dropping their cached statistics), the whole range of rules that use formulas, and only the changed cells for local rules (cell value with constants, text, blanks, errors, dates). Any other document change (structural edits, sort, undo, rule edits) re-evaluates everything. A test compares incremental and full results.

### [core/spreadsheet] Custom Validation Formulas Must See the Value Being Entered

- **Issue / Symptom**: `=COUNTIF($A$1:$A$9,A1)=1` (no duplicates) accepted a duplicate, and `=A1>10` checked the cell's old value.
- **Root Cause**: Validation runs before the input is committed, so evaluating the rule formula against the sheet reads the cell's current value.
- **Solution / Workaround**: `DataValidationSheet.evaluateFormula(formula, row, col, entered)` receives the parsed input; the controller sets a temporary `valueOverride` that `resolveCellByCoord` and `resolveRangeByCoords` return for that cell, restored in `finally`. Rule formulas (validation and conditional formatting) are written for the top-left cell of the first range and offset with `offsetFormulaReferences` for other cells, so `$` parts stay put.

### [react|svelte/spreadsheet] The Validation Alert Steals Focus, Which Blurs (and Re-commits) the Cell Editor

- **Issue / Symptom**: After a rejected Enter, the dialog took focus, the cell input's `onBlur` called `commitEditing()` again and the alert re-opened in a loop; Enter also moved the cursor down although nothing was committed.
- **Root Cause**: The cell editor commits on blur, and the grid's Enter/Tab handler always called `moveCursor` after `commitEditing`.
- **Solution / Workaround**: While `controller.validationPrompt` is set, `commitEditing` / `commitCellInput` return `{ status: 'pending' }` without doing anything. Enter/Tab only move when the result is `committed`. The dialog backdrop calls `preventDefault()` on `mousedown` so clicks don't move focus, and after `resolveValidationPrompt` the editors refocus the cell input (retry) or the grid. Unchanged input is not validated, so blurring an untouched editor never alerts.

### [svelte/spreadsheet] `{@const}` Calling a Controller Method Does Not Re-run on Controller State

- **Issue / Symptom**: Turning on "Circle invalid data" drew no circles in Svelte (React re-renders everything and showed them).
- **Root Cause**: `{@const circled = sheetState.controller.isInvalidDataCircled(r, c)}` reads only non-reactive controller state, so Svelte never re-evaluates it when the document state changes.
- **Solution / Workaround**: Compute such values in a `$derived.by` that reads `sheetState.document` first (`void sheetState.document`), e.g. the set of circled cells, and look cells up in it. The conditional-format overlay is exposed the same way (`sheetState.conditionalFormatOverlay`).

### [core/canvas] Tangent Curves Look Like Ties (or Clusters of Hits) to a Curve Boolean Engine

- **Issue / Symptom**: Uniting two externally tangent circles, or a circle touching another from inside, traced a figure-eight ring or split curves into dozens of tiny pieces; repeated split passes kept finding "new" intersections next to the touch point.
- **Root Cause**: Near a tangency the two curves stay within `epsilon` of each other over an arc of length about `√(ε·R)`, far longer than `ε`. Subdivision reports a hit for every flat sub-curve pair along it, and the vertex where they meet sits anywhere in that stretch, so the tangent directions there differ by numerical noise (`√(ε/R)` radians) and ordering the edges around the vertex by tangent angle picks an arbitrary one.
- **Solution / Workaround**: In `packages/core/src/canvas/pathops/boolean.ts`, consecutive hits of one pair between which the curves never separate by more than a few `ε` are one contact (shared end points take part in the clustering, so hits next to an existing vertex are dropped). When tangent angles at a vertex tie within `1e-3` rad, edges are ordered by the chord to a point a short way along each curve, which separates them by curvature.

### [core/canvas] Stroking With a Width Larger Than the Curvature Radius Leaves Spurious Holes

- **Issue / Symptom**: Outline Stroke of a small circle with a thick stroke (or Offset Path growing a small curved shape) left a hole in the middle that the stroke really covers.
- **Root Cause**: The inner offset of a curve turns inside out where the offset distance exceeds its radius of curvature; its loops wind the other way, so the non-zero fill of the raw outline cancels to 0 there.
- **Solution / Workaround**: After normalising, drop a face (and its descendants) when a point deep inside it is closer to the source path than the offset distance: holes when growing or stroking, islands when insetting (`dropSpurious` in `packages/core/src/canvas/pathops/stroke.ts`). The deep point must be taken in the face (the ring minus its direct children); a ring's own interior can lie inside a legitimate hole, e.g. the middle of a stroked square.

### [core/canvas] Gauss–Legendre Areas Need Both Halves

- **Issue / Symptom**: Exact Bézier areas (lines and curves) came out twice too large next to the shoelace formula.
- **Root Cause**: The area is `½ ∫ (x y′ − y x′) dt`, and mapping Gauss–Legendre nodes from `[-1, 1]` onto `[0, 1]` contributes another `½`. A line's term `x0 y1 − x1 y0` is already the integral, so it needs only the first `½`.
- **Solution / Workaround**: `segmentAreaTerm` divides the 3-point Gauss–Legendre sum (exact for the degree-5 integrand of a cubic) by 4 and the line term by 2; tests compare `bezierPathSignedArea` of rectangles and quadratics with closed forms.

### [core/extensions] TipTap Command Typings Vanish From the Published Declarations

- **Issue / Symptom**: `editor.chain().focus().toggleBold().run()` (and `toggleHeading`, `toggleBulletList`, `toggleTaskList`, `setTextAlign`, …) failed to typecheck with "Property 'toggleBold' does not exist on type 'ChainedCommands'" in the demo, and in any app that uses `createRichTextPreset` without depending on the TipTap extension packages itself. The Vite build doesn't typecheck, so it went unnoticed.
- **Root Cause**: Each extension package adds its commands by augmenting `@tiptap/core`'s `Commands` interface in its own `.d.ts`. That augmentation only applies when the consumer's TypeScript program loads that file. Core imports the extensions as runtime values, which leave no trace in the emitted declarations, and tsup's declaration bundler drops `/// <reference types="…" />` directives, so nothing pulled the packages in.
- **Solution / Workaround**: `rich-text-preset.ts` exports `RichTextPresetCommandPackages`, a type naming `typeof import("@tiptap/…")` for every package whose commands the preset installs; the bundled `.d.ts`/`.d.cts` then import those packages (resolved from core's own dependencies). Add a package there when the preset gains an extension with commands. `apps/demo` now has a `typecheck` script, so `pnpm typecheck` (run in CI) catches regressions.

### [tests] Timing Tests Flake in the Release Run Unless They Use `measureGrowth`

- **Issue / Symptom**: Release runs failed (so nothing was published) on "grows linearly" tests whose code was fine, e.g. `pdf-layout` at 10.4× against a limit of 10, `html-scan` at 31×, `mention-roles` at 20×.
- **Root Cause**: Each test timed its own sizes once or best-of-three, often for well under a millisecond. On a loaded CI runner (or with many test files in parallel) a single GC pause or descheduling dominates such a sample, so a linear function can look quadratic.
- **Solution / Workaround**: Use `measureGrowth(small, large, { limit })` (or `growthRatio(unit, run)` for repeated strings) from `packages/core/tests/helpers/growth.ts`: it repeats each sample until it takes at least 10 ms, alternates small and large, keeps the best of several runs, and retries while the ratio is at or above the limit. `tests/growth-helper.test.ts` checks it still fails real quadratic work. Prefer 4× size steps (linear ≈ 4×, quadratic ≈ 16×) and keep absolute-time limits at least 20× above the measured local time.

### [core/canvas] Animated Nodes: Render the Evaluated Frame, but Send Edits Back Through `applyDisplayChanges`

- **Issue / Symptom**: Dragging an animated node in React Flow snapped it back on the next frame. Writing the evaluated values into the stored nodes baked one frame's values into the base, so scrubbing showed wrong values afterwards. Rotating a node through `style.transform` moved it to the flow origin.
- **Root Cause**: The canvas shows `applyAnimation(nodes, time)`, but xyflow reports changes against the nodes it renders. Applying those changes to the stored nodes either loses them (the animated value wins on the next frame) or stores evaluated values. xyflow positions nodes with `transform: translate(…)` on the same element as `node.style`, so a `transform` in the style replaces it.
- **Solution / Workaround**:
  - Render `display()` / `displayNodes` and pass edits through `applyDisplayChanges(applyNodeChanges(changes, displayNodes))`. It calls `recordAnimationChanges`, which keys animated properties at the playhead (all changed properties in record mode) and restores their stored values; other changes pass through.
  - The keying is one undo step that only restores `data.animation`, merged by tag while a drag continues.
  - Rotation and scale are written to the CSS individual transform properties `style.rotate` / `style.scale`, which compose with xyflow's `transform`.
  - Run `applyAnimation` after `resolveCanvasTokens`, never before.

### [core/canvas] Keyframe Caches Keyed by Array Identity Go Stale When the Array Is Edited in Place

- **Issue / Symptom**: After `keys[0] = { ...keys[0], easing: 'hold' }`, `evaluateTrack(keys, t)` kept interpolating linearly.
- **Root Cause**: `normalizeKeyframes` (sort, drop invalid, merge duplicate times) is cached in a `WeakMap` keyed by the keyframe array so every frame does not re-sort. An in-place edit keeps the same array.
- **Solution / Workaround**: The cache stores a shallow copy of the elements and is reused only while every element is still the same object (an O(n) identity check, no sort). Editing functions always write new arrays and keyframe objects. Treat keyframe objects as immutable: mutating `k.time` in place is still not detected.

### [core/canvas] Frame Times Are Not Exact, and Keying at the Playhead Must Not Snap

- **Issue / Symptom**: A keyframe recorded at 500 ms was stored as `500.00000000000006`, so it no longer matched refs at 500. Pressing "Add keyframe" with the playhead at 250 ms keyed 233.333 ms.
- **Root Cause**: `Math.round(t / (1000 / fps)) * (1000 / fps)` is not exact in binary floating point. Snapping every keyed time to a frame moves keys the user placed deliberately.
- **Solution / Workaround**: `snapTimeToFrame` rounds its result to a microsecond, and refs compare times with `ANIMATION_TIME_EPSILON`. Only keyframe drags snap to frames, when no other target is in range. Keys at the playhead use the playhead time unchanged.

### [core/canvas] CSS Cannot Reproduce OKLab Colour Tweens or Split `x` / `y` Timing

- **Issue / Symptom**: Exported CSS animations faded colours through a different (muddier) midpoint than the canvas. When `x` and `y` had different easings, one of them followed the wrong curve.
- **Root Cause**: CSS keyframes interpolate colours in sRGB and cannot choose a space. `translate` takes both axes, and a keyframe block has one `animation-timing-function` for every property in it.
- **Solution / Workaround**: Export one `@keyframes` per CSS property, so each track keeps its own per-segment easing. Use `rotate` / `scale` / `translate` instead of a combined `transform`. Colour segments between different colours, `x` / `y` pairs whose key times or easings differ, and motion paths are sampled at `sampleFps` with linear timing and reported as `exact: false`.

### [svelte/canvas] Timeline Rows Do Not Refresh After Undo When the Nodes Are Not `$state`

- **Issue / Symptom**: In tests (and apps that keep nodes in a plain variable or store), undoing a keyframe move left the Svelte timeline showing the moved diamonds.
- **Root Cause**: The rows are a `$derived` of `animation.timelineRows()`, which reads the nodes through `getNodes()`. Undo changes the nodes without changing the controller's state snapshot (time, selection and duration are equal), so nothing reactive was read.
- **Solution / Workaround**: `createCanvasAnimation` bumps a `revision` `$state` whenever it writes the nodes (edits, undo and redo all go through its `setNodes`). `<AnimationTimeline>` and `displayNodes` read `revision`. Changes made outside the rune need a `revision` prop bump or `refresh()`.

### [react/svelte] `ReturnType` of a Generic Hook Fixes the Default Type Parameter

- **Issue / Symptom**: The demo's `useCanvasAnimation<DemoNode>(…)` result could not be passed to `<AnimationTimeline animation>`: "Two different types with this name exist, but they are unrelated."
- **Root Cause**: `type CanvasAnimation = ReturnType<typeof useCanvasAnimation>` instantiates the hook with `TNode = CanvasNode`. Methods taking or returning `TNode[]` make the result invariant in `TNode`.
- **Solution / Workaround**: Make the alias generic (`CanvasAnimation<TNode> = ReturnType<typeof useCanvasAnimation<TNode>>`, likewise `SvelteCanvasAnimation<TNode>`), and have components accept `CanvasAnimation<any>`.

### [core/tables] prosemirror-tables `deleteRow` / `deleteColumn` Say They Can Run on the Whole Table

- **Issue / Symptom**: `editor.can().deleteRow()` returned `true` in a one-row table, so the toolbar enabled "Delete row", but running it did nothing (`runTableAction` returned `false`, the command registry reported a failure).
- **Root Cause**: prosemirror-tables only checks "the selection covers every row/column" inside its `if (dispatch)` branch, so a dry run (`can()`, no `dispatch`) never sees it. `mergeCells` / `splitCell` / `goToNextCell` do check without dispatching.
- **Solution / Workaround**: `getTableActionState` checks `selectedRect(state)` itself for `deleteRow` / `deleteColumn` and returns "These are all the rows: delete the table instead." Don't trust `can()` alone for prosemirror-tables commands; test enablement by running the action, not only by asking.

### [core/tables] Table Cells Accept `block+`, So Pastes and Imports Nested Tables Inside Cells

- **Issue / Symptom**: Pasting HTML or markdown that contained a table plus other blocks, pasting a table through the rich clipboard, or importing a DOCX / PDF / HTML file while the cursor was in a table cell put a `table` inside the `tableCell`, although `insertTable` refuses to nest.
- **Root Cause**: TipTap's cell content is `block+` and `table` is in the `block` group, so the schema allows nesting. prosemirror-tables' `handlePaste` only takes over for cell selections and for slices that are nothing but a table (`pastedCells`); everything else falls through to the default paste. `RichClipboard`'s `handlePaste` runs before the table plugins and called `replaceSelection` directly, and `insertImportedDocument` used `replaceRange` at the cursor. ProseMirror content expressions cannot say "any block except table", and narrowing the schema would make existing documents with nested tables fail to load or be restructured by the parser.
- **Solution / Workaround**: `packages/core/src/extensions/table/nesting.ts`. `handleTablePasteWithoutNesting` (the `Table` extension's `tableNesting` plugin and `RichClipboard`) hands cell selections and table-only slices to prosemirror-tables' `handlePaste` (fills cells from the cursor, growing the table), and inserts other slices that contain a table after the outermost table (`insertSliceAfterTable`). `insertImportedDocument` always inserts after the table (an import never overwrites cells). The plugin's `appendTransaction` moves any table a local edit puts into a cell to after its outermost table, checking only tables that start inside the ranges the transaction changed. It skips whole-document replacements (`setContent`), undo/redo, `y-sync$`, other plugins' appended transactions (Track Changes re-inserts a deleted nested table for review) and `ALLOW_NESTED_TABLES_META`, so existing nested tables are kept. Map changed ranges with `assoc` pointing inwards and drop empty ranges: otherwise a pure deletion's empty range grows over content a later transaction re-inserts at the same position.

### [core/track-changes] Deleted Table Rows and Columns Have No Inline Text to Mark, So They Are Whole-Block Changes

- **Issue / Symptom**: With tracking on, Delete Row put the row back with its text struck through, but accepting left an empty row; Delete Column really deleted the empty cells of the column and restored only the cells with text, leaving a ragged table that `fixTables` then padded in the wrong place. Inserted rows (empty paragraphs) were not tracked at all.
- **Root Cause**: The tracker only restores deleted slices that contain inline content and only marks inserted inline content; rows, cells and tables are structure, like paragraph boundaries (see "Whole Paragraphs Have No Inline Representation").
- **Solution / Workaround**: Closed slices made only of `tableRole` nodes (table, row, cell, header cell) are tracked as whole-block operations: a deletion is re-inserted unchanged and every textblock inside gets `blockChange: { operation: "delete" }`; inserted tables/rows/cells (found by walking the step's slice, skipping open edge nodes) get `operation: "insert"`, with any insertion marks inside removed. `removeBlocks` already removes containers whose textblocks are all removed, so accepting/rejecting removes whole rows, cells or the table. Rows the same author inserted are really deleted. Merging/splitting cells (span changes plus cell deletions in one step) cannot be represented and is refused while tracking; cell attribute changes (`setCellAttribute`, column widths) are `ReplaceAroundStep`s that leave the textblocks' wrapper types unchanged, so they stay untracked. Header toggles change the wrapper type and are tracked as ordinary block changes (rejecting restores the cell type via `restoreWrappers`).

### [core/markdown] tiptap-markdown's Table Serializer Does Not Escape `|`, and Its HTML Fallback Was Escaped by Our Sanitizer

- **Issue / Symptom**: A cell containing `A|B` exported as `| A|B | 3 |`, which reads back as three cells. Tables with spans were exported as HTML containing `<colgroup><col>`, which `markdownToTipTapHtml` turned into literal `&lt;colgroup&gt;` text. Header alignment was lost.
- **Root Cause**: tiptap-markdown 0.8 writes cells with `renderInline` and its text serializer escapes markdown characters but not the pipe; it always writes `---` delimiters. TipTap's `table` `renderHTML` emits a `<colgroup>`, and `colgroup` / `col` were missing from the embedded-HTML allowlist.
- **Solution / Workaround**: The `Table` extension provides `storage.markdown.serialize` (tiptap-markdown merges it over its default and keeps the default parser): cells are rendered in place mid-line and their output is rewritten with `|` → `\|` and newlines → spaces; delimiters come from the header cells' `align`. Non-GFM tables are written as HTML (a block that parses back). `colgroup`, `col` and `colwidth` are in the sanitizer allowlist; `style` is still dropped.

### [react|svelte/tables] Toolbar Tests: `focus()` Needs `requestAnimationFrame`, and the Bubble Menu Element Is Detached

- **Issue / Symptom**: Table commands run through the command registry failed in jsdom with "requestAnimationFrame is not defined"; `document.querySelector` could not find a `TableBubbleMenu`'s toolbar; a table store test started "inside a table" before any selection was made.
- **Root Cause**: `chain().focus()` schedules with `requestAnimationFrame`, which plain JSDOM setups don't define. TipTap's `BubbleMenuView` removes its element from the DOM until tippy shows it, so a React portal or Svelte child rendered into it is not in the document. A document that starts with a table puts the initial selection in its first cell.
- **Solution / Workaround**: Polyfill `requestAnimationFrame` in tests that focus. Find bubble menu content through `editor.view.pluginViews` (`view.element`). Move the selection out of the table before asserting the "outside" state.

### [core/export] DOCX Round Trips: `<ins>` Was Not in the Sanitizer Allowlist, the Hyperlink Style Underlines, and Word Has No Change or Thread Ids

- **Issue / Symptom**: Tracked insertions imported from Word vanished as marks (only their text stayed); exported links came back underlined; one tracked change became several after export and re-import; comment threads and moves lost their link to each other.
- **Root Cause**: `sanitizeImportedHtml` stripped `<ins>` (not in `ALLOWED_HTML_TAGS`), so `ins[data-change-type]` never reached the `insertion` mark. Word marks links with the `Hyperlink` character style, whose underline the importer applied as formatting. WordprocessingML gives every `w:ins` / `w:del` element its own `w:id` and has no thread or change id: replies point at the `w14:paraId` of their parent comment's last paragraph (`commentsExtended.xml`), moves are paired only by the `w:name` of their `w:moveFromRangeStart` / `w:moveToRangeStart`, and author ids exist only in `people.xml`.
- **Solution / Workaround**: `ins` is now allowed (attributes still go through the allowlist; this also means `<ins>` in markdown renders instead of being escaped). The importer ignores the `Hyperlink` style's formatting inside hyperlinks, merges adjacent changes with the same kind, author, date and move into one change id, maps move range names to fresh move ids, attaches replies to the root of their chain, and reads author ids from `people.xml` (the export writes it unless `privacy: "strip-authors"`). Ids are regenerated on import (`createReviewId`), so comparing round trips must use bodies, authors and texts, not ids. Other limits: `Title` paragraphs come back as `<h1>` (existing import rule), headings with custom styles lose `data-style`, block-change wrappers (lists, quotes) are not exported, and dates keep whole seconds only.

### [core/export] Word Needs a Paragraph Between and After Tables, and `w:delText` Is Only for Real Deletions

- **Issue / Symptom**: Two adjacent tables merged into one in Word; a document or cell ending in a table was reported as damaged; moved-away text showed as missing.
- **Root Cause**: Word joins consecutive `w:tbl` elements, requires every `w:tc` to end with a `w:p`, and expects a paragraph before the final `w:sectPr`. Moved-away text (`w:moveFrom`) must stay in `w:t` (ECMA-376 §17.13.5.22); only `w:del` content uses `w:delText`.
- **Solution / Workaround**: The exporter writes an empty `w:p` between adjacent tables, at the end of cells that are empty or end with a table, and after a final table (which the importer reads back as an empty paragraph), and writes `w:delText` only for deletions without a `moveId`.

### [core/canvas] Component Sync Needs the Nodes From Before the Edit, and No-Op Rebuilds Must Keep Node Identity

- **Issue / Symptom**: Deciding overrides by comparing an instance layer with its main layer recorded the main's *old* value as an override whenever the main was edited before its instances were rebuilt (the instance simply had not caught up). Separately, rebuilding instances on every React Flow change re-rendered forever.
- **Root Cause**: "Differs from the main" is ambiguous on its own: it means either "the user changed the instance" or "the user changed the main". Rebuilding an instance creates new node objects even when nothing changed, so a hook that sets nodes after a sync triggers another change, and another sync.
- **Solution / Workaround**: `syncCanvasComponents(before, after)` diffs each node against its version *before the edit*: only groups that changed on an instance layer become overrides (and only while they differ from the main), while changes inside a main rebuild its instances. Rebuilt nodes that deep-equal their previous version keep their identity, so a no-op sync returns `after` itself. The controller keeps the last synced array and syncs against it; its own actions and undo / redo set that snapshot, so changes made by a rebuild are never re-read as edits.

### [core/canvas] Token-Bound Values and Component Property Values Look Like Overrides

- **Issue / Symptom**: An instance in Dark mode (its own `data.tokenModes`) would show every bound fill as overridden; binding another variable inside an instance recorded both `token.fill` and `shape.fill`. Conversely, filtering out every group a component property drives meant that typing over a property-driven label, or swapping a nested instance whose main an instance-swap property drives, recorded no override at all.
- **Root Cause**: Bound values are materialised into the nodes (see the token entry above), so a layer resolved in another mode really does differ from its main. Property values are written by the rebuild, not by the user, so they never need filtering out of user edits.
- **Solution / Workaround**: Value groups written by a node's token bindings are never overrides (found by probing `property.write` with a different value and diffing); a different binding is the override (`token.<key>`). Property values are applied during the rebuild, which the sync never re-reads as an edit, so a user edit to a property-driven layer is an override that wins over the property, as in Figma. Only `rebaseInstance` (detach, paste, restore), which compares values rather than edits, skips property-driven groups.

### [core/canvas] Variant Switches Match Layers by Name, and Text Layers Are Often Named by Their Content

- **Issue / Symptom**: Switching an instance from `State=Default` to `State=Hover` lost the text override on its label and gave the label a new id.
- **Root Cause**: Layers of two variants are different nodes, so the rebuild matches old copies to the new variant's layers by their name path (`Frame/Label`). `getLayerName` falls back to `data.label`, which for text nodes is the text itself, and that differs between variants ("Default" / "Hover").
- **Solution / Workaround**: Give layers that must match across variants (or swaps) a stable `data.name`; it wins over `data.label` for matching. Matching inside one main uses the source id first, so plain main edits never depend on names.

### [core/canvas] Removing a Variant Must Re-Point Its Instances Before Deleting It

- **Issue / Symptom**: Deleting a variant and re-pointing its instances to another variant in the same edit kept every override of the instances, including ones the two variants disagreed on (a fill that only made sense on the removed variant stuck).
- **Root Cause**: A variant switch filters overrides by diffing the old source layer (`data.componentSource`, in the old variant) against the new one. When the old variant is already gone, the source can't be found, so nothing is filtered.
- **Solution / Workaround**: `removeCanvasVariant` syncs twice: first it re-points the instances (and instance swap values) while the variant still exists, then deletes the variant's subtree. Likewise, when editing variant values (`setCanvasVariantProperties`, renames), write the explicit `data.component.variant` and the formatted name together, since a variant without `variant` falls back to parsing its name.

### [core/spreadsheet] Large Sheets: Ranges Expanded per Cell, Whole-Sheet Undo Snapshots and Quadratic Id Lookups

- **Issue / Symptom**: On a 50k-row sheet a CSV import took 23 s, loading 100 formulas over `$A$1:$A$50000` took 3.2 s and editing one of their inputs 0.8 s, and even an edit nothing depended on took ~25 ms.
- **Root Cause**: The dependency graph expanded every range into one key per cell (100 × 50k set entries), and planning scanned those lists; `rows.find((r) => r.id === …)` in `getCell` / `setCellValue` / `getCellKey` made imports O(n²) (and range reads over blank cells too); every single-cell edit serialised the whole sheet (`JSON.stringify`) for undo.
- **Solution / Workaround**: `DependencyGraph` keeps ranges whole (`SHEETID!A1:A50000`) in a per-column interval index (ported from gridcraft's `Intervals`: sorted starts plus a max-end segment tree, insertions/removals merged lazily on the next query) and a per-sheet index for ranges wider than 64 columns; `getDependents` is O(log n + k). Planning turns each distinct range into one virtual node whose edges are the planned cells inside it (binary search), so ranges shared by many formulas cost once. `getDependencies` now returns range keys (`A1:A3`, `A:`) instead of expanded cells; use `dependsOn(formula, cell)` to ask about one cell. Rows and columns are found through a validated `PositionCache` (never `find` in a per-cell path). Single-cell edits push a `cells` undo entry (the cell's previous state); `getRecalculationStats()` gives deterministic work counts for tests. Paste/import inside the grid recalculates the written cells with their dependents in one plan; when the grid grows (or for `loadWorkbook`), `recalculateAll` evaluates everything once.

### [core/spreadsheet] Spill Edges Can Close False Cycles: Blockers Don't Order, and New Input Makes Old Edges Stale

- **Issue / Symptom**: Random edit sequences left `#CYCLE!` (or skipped spills) that a full recalculation of the same workbook didn't show, e.g. an anchor blocked by a cell whose formula (indirectly) read the anchor, `A1` = `=SEQUENCE(4)` then pasting `=MAX(A2:A9)*2` into A1 and `=SEQUENCE(3)` into A2, or replacing an anchor's formula with one reading the cells it used to spill into. The old graph had the same bugs.
- **Root Cause**: A blocked anchor's edges to its blockers were ordering edges, but whether a cell blocks depends on its input, not its value. Spilled-cell → anchor edges outlive the input that made them true (a cell that now has its own formula, an anchor with a new formula) until the anchor is evaluated again, so the plan made before that sees cycles that no longer exist, and a cyclic anchor keeps its edges.
- **Solution / Workaround**: Blocker edges are only followed for propagation (`getDependents`), never for ordering or cycle detection. Writing a cell drops the spill edges it anchored and its edge to the anchor whose values it held (`dropStaleSpillEdges`). Because dropped edges lose ordering, `placeSpill` reports every spilled cell not previously linked to the anchor as a spill change, so its dependents are recalculated in the next pass. `tests/spreadsheet-recalc.test.ts` compares incremental and full recalculation on random sheets with ranges, spills, cross-sheet, 3-D and name references, pastes, undo and redo: run more seeds after changing recalculation.

### [core/spreadsheet] Per-Plan Range Cache and Blank-Skipping Ranges Are Only Safe in Narrow Cases

- **Issue / Symptom**: Caching a range's values for a whole recalculation, or leaving blank cells out of ranges, can return stale or wrong results.
- **Root Cause**: Formulas evaluated later in the same plan (or spills re-placed) change cells inside a cached range; `COUNTBLANK`, `COUNTIF(…,"")`, `INDEX`, `MATCH` and array results depend on blank positions.
- **Solution / Workaround**: The controller caches only ranges of 256+ cells, only while `runEvaluationPlan` runs and no `valueOverride` (validation) is set; evaluating a cell drops cached ranges covering its column, and any spill change drops the sheet's entries; hits return a copy. Blanks are skipped only for direct `Range` arguments of `SUM`, `PRODUCT`, `AVERAGE`, `COUNT`, `COUNTA`, `MIN` and `MAX` (`RangeResolveOptions.skipBlanks`, a hint resolvers may ignore). Keep document order: floating-point sums depend on it.

### [react|svelte/spreadsheet] Virtualised Grid: jsdom Has No Layout, Merges Cross the Window, and Scroll-Into-View Must Not Track Scrolling

- **Issue / Symptom**: In jsdom the window computed from `clientHeight` (0) rendered no rows and `scroll` events never fired after programmatic scrolling; a merged cell whose top-left row was above the window vanished (or its `rowspan` covered the spacer); an effect that scrolled the active cell into view snapped back whenever the user scrolled away.
- **Root Cause**: jsdom does no layout (sizes are 0, no `ResizeObserver`), but it stores `scrollTop`. A merge is rendered from its top-left cell. An effect reading the viewport state re-runs on every scroll.
- **Solution / Workaround**: The core helpers (`getSpreadsheetViewWindow`, `getSpreadsheetScrollToCell`) assume a 1200×600 viewport when the size is 0, and widen the window until no merge crosses its edges. The bindings update their viewport state directly after scrolling to the active cell, and only re-render when the window changes. The scroll-into-view effect depends only on the active cell and the mode (`untrack` in Svelte, refs in React). Frozen rows/columns are rendered before the spacers so sticky offsets still work; group rows get the same spacer cells as body rows (`leadingColumns`, `leftSpace`, `rightSpace`). Small sheets (≤ 200 rows, ≤ 60 columns) render every cell, so existing DOM tests are unchanged. Browser automation must press keys (not `insertText`) to type into the grid.

### [react/svelte spreadsheet] Scrolled Rows Show Through Frozen Rows in a Collapsed-Border Table

- **Issue / Symptom**: With frozen rows and a sheet scrolled far down (e.g. the demo's 10,000-row "Large" sheet), thin slivers of the scrolling rows' text appeared along the top of every frozen row. Hit-testing showed no gap; hiding the scrolled rows made the slivers disappear.
- **Root Cause**: The grid `<table>` used `border-collapse: collapse` with the row separator on the `<tr>` (`border-b`). In the collapsing border model the shared borders belong to the table grid, not the cells, so when frozen cells are `position: sticky` their backgrounds don't cover the border band and the browser paints the rows scrolled underneath through it.
- **Solution / Workaround**: The table uses `border-separate border-spacing-0`, and the row separator is drawn on the cells (`[&>*>tr:not([data-spacer])>*]:border-b`; spacer rows get none so the virtual-scroll heights stay exact). Don't switch the grid back to `border-collapse` while frozen panes are sticky cells. Consumers' Tailwind must scan the package sources (as for every other class the components use) for the arbitrary variant to compile.

### [core/tools] The Tool Registry Lives in `/tools` So Non-Text Hosts Don't Need TipTap

- **Issue / Symptom**: A host that only wanted `ToolRegistry` (an effect editor exposing `createCommandToolProvider`, a canvas-only or spreadsheet-only app) had to install `@tiptap/core`, `@tiptap/pm` and `@dagrejs/dagre`, because importing `@pixerate/editor/agent` loads them. Consumers worked around it by copying `callTool` / `toolDefinitions` helpers or importing the tool types from `/generation`.
- **Root Cause**: `/agent` re-exports `providers.ts`, which imports `@tiptap/core` and `@tiptap/pm/state` at load time for `createRichTextToolProvider`, and `planner.ts`, which imports `canvas/layout.ts` (dagre). The registry itself depends on none of them.
- **Solution / Workaround**: The registry, the JSON Schema validator and the static MCP tool definitions live in `src/tools/` and ship as `@pixerate/editor/tools`; `/agent` re-exports `../tools/index.js` so existing imports keep working. Dependency-free modules (`commands`, `generation`, `image-editor`) import from `../tools/*.js`, never from `../agent/*`. Anything that needs TipTap or the planner (including `createEditorMcpToolProvider`, whose `layout` operation runs dagre) stays in `/agent`. `tests/entry-isolation.test.ts` fails if `tools/index.js` or `tools/index.cjs` reaches any third-party package.

### [core/animation] The `/animation` Entry Must Not Reach Canvas Code, and tsup Chunks Can Pull It In Silently

- **Issue / Symptom**: Keyframe evaluation used to live under `src/canvas/animation/`, so the only way to get `evaluateTrack` or `AnimationPlayer` was `@pixerate/editor/canvas`, which statically imports the optional `@dagrejs/dagre` peer.
- **Root Cause**: The node-independent parts (easing, OKLab colour, keyframes, `evaluateTrack`, player, clock) shared files with node code (`model.ts` / `evaluate.ts` import `CanvasNode`, `arrange`, `tokenBindings`). With `splitting: true`, one stray import from `src/animation/` into `src/canvas/` would put canvas code (and dagre) into a chunk the `/animation` entry loads, with no type error.
- **Solution / Workaround**: The node-independent code lives in `src/animation/` and imports nothing from `src/canvas/` (only `src/tokens/color.ts`). `src/canvas/clock.ts` and `src/canvas/animation/{easing,color,player}.ts` are one-line re-exports, and the canvas `model.ts` / `evaluate.ts` re-export the keyframe types and `evaluateTrack`, so `/canvas` still exports the same bindings. `tests/entry-isolation.test.ts` checks the built `dist/animation/index.js` reaches no packages; `tests/animation-entry.test.ts` checks `/canvas` re-exports the same functions and that nothing node-specific leaked into `/animation`. Add new node-independent helpers to `src/animation/`, never the other way round.

### [svelte] A Variable Named `state` Turns `$state(...)` Into a Store Subscription

- **Issue / Symptom**: `svelte-check` reports `Block-scoped variable '$state' used before its declaration` and `Cannot use 'state' as a store` in a component that declares `let state = $state.raw(...)` (for example a `ParametersState` snapshot).
- **Root Cause**: In a `.svelte` file, `$name` means "subscribe to the store `name`" whenever a variable called `name` is in scope. Declaring `state` makes the compiler read `$state` as a store reference instead of the rune.
- **Solution / Workaround**: Never name a component-level variable `state` (or `derived`, `effect`, `props`). The parameters panel keeps its snapshot in `view`. Props named `state` are fine only in components that use no `$state` rune.

### [core/commands] A Command's `params` Can Be a Getter, but Only While the Spec Is Not Spread

- **Issue / Symptom**: The JSON Schema agents see for `parameters.set` must follow the parameter schema, which changes with `ParametersController.setSchema`, but `CommandSpec.params` is a plain property read by `list()` and validated on every `execute()`.
- **Root Cause**: `CommandRegistry` stores the spec object as given and reads `spec.params` each time, so a getter works. Spreading the spec (`{ ...spec, scope }`) evaluates the getter once and freezes the schema.
- **Solution / Workaround**: Define `params` with `get params() { … }` on the object literal that is registered, and add shared fields (`group`, `scope`) by spreading them *into* that literal, not by spreading the spec into a new object. Note the registry validates params against this schema before `run`, so range and enum errors come back as `invalid_params` with `validateJsonSchema` wording (`/values/speed Must be <= 4.`); only checks the JSON Schema cannot express (vector component bounds, text patterns) reach the controller's sentence errors.

### [core/parameters] Command `execute` Runs Before `HistoryManager` Records the Step

- **Issue / Symptom**: A store that rebuilds its snapshot inside a history command's `execute` / `undo` reports stale `canUndo` / `canRedo` / `undoLabel` (the undo button stays disabled after the first edit).
- **Root Cause**: `HistoryManager.execute` calls `command.execute()` first and only then pushes the step and notifies; `undo` / `redo` likewise notify after the closure ran.
- **Solution / Workaround**: Notify from the command (so values update immediately) and also subscribe to the history, re-notifying only when the undo / redo fields actually changed. `ParametersController` does both, which keeps one snapshot per edit in the common case and never leaves the history fields stale.

### [core/animation] Parametric Elastic Easing Boundary Guarantees and Sampling

- **Issue / Symptom**: Parametric damped harmonic oscillators ($e^{-\lambda t} \cos(\omega t)$) used for elastic animations can drift from boundary conditions due to floating point inaccuracies, resulting in jumps at $t = 0$ or $t = 1$. Furthermore, CSS transitions cannot natively parse parameterised spring/elastic curves like `cubic-bezier`.
- **Root Cause**: When computing $t = 0$ or $t = 1$, damped sine/cosine equations evaluate to fractional residuals ($1 \pm \epsilon$) unless strictly bounded. Additionally, CSS transitions require standard cubic beziers or modern CSS `linear(...)` piecewise approximations.
- **Solution / Workaround**: In `elasticAt`, clamp boundary evaluations explicitly ($t \le 0 \to 0$, $t \ge 1 \to 1$). In `easingToCss`, sample elastic curves over discrete intervals (e.g. 20 samples) to generate a standards-compliant CSS `linear(...)` function for performant GPU rendering.

### [core/parameters] Range Mapper Degenerate Interval Safeguards

- **Issue / Symptom**: Passing identical bounds for the input range (`from: [v, v]`) to `createRangeMapper` or `mapRange` produces `NaN` or `Infinity` upon interpolation.
- **Root Cause**: The domain normalization formula $(value - inMin) / (inMax - inMin)$ results in division by zero ($0 / 0 = NaN$) when $inMin == inMax$.
- **Solution / Workaround**: Check for degenerate intervals (`inSpan === 0`). When degenerate, bypass division and return the lower target bound (`toMin`), preserving safety and avoiding cascading `NaN`s in downstream transform math.

### [react/dependencies] Peer Dependency Range Alignment with Sibling Pixerate Packages

- **Issue / Symptom**: Installing `@pixerate/editor-react` alongside `@pixerate/flair@0.13.0` or sibling ecosystem packages triggers `npm ERR! code ERESOLVE` peer dependency collision errors on clean `npm install`.
- **Root Cause**: `@pixerate/flair@0.13.0` declares `peerDependencies: { "@pixerate/editor": ">=0.29.0 <1" }`, while `@pixerate/editor-react` previously kept `@pixerate/editor` under direct `dependencies` pinned to an exact version (`workspace:*` resolving to `0.27.0` or `0.29.0`), causing npm's strict peer dependency resolver to detect conflicting version constraints.
- **Solution / Workaround**: Move `@pixerate/editor` to `peerDependencies` with the ecosystem-aligned range `">=0.29.0 <1"` in `@pixerate/editor-react` (paired with `devDependencies: { "@pixerate/editor": "workspace:*" }` for local monorepo builds and tests) and omit it from direct `dependencies`.

### [core/canvas] Freehand Eraser Gesture Undo Snapshot Preservation

- **Issue / Symptom**: Dragging an eraser across multiple nodes and subsequently executing undo either restored erased strokes out of order (distorting z-index ordering) or failed to restore earlier nodes in the same drag stroke when batching deletions.
- **Root Cause**: If each node erasure removes the node dynamically or splices indices step-by-step without a baseline snapshot, undoing the compound command by re-inserting elements or reversing individual removals drifts relative to remaining nodes or fails to preserve original sibling ordering.
- **Solution / Workaround**: In `createCanvasDrawController`, capture `dragStartNodes = [...options.getNodes()]` upon `startStroke` when `tool === 'eraser'`. During `endStroke`, if any nodes were deleted, register a single history command whose `undo` action restores the exact pre-drag snapshot (`options.setNodes(dragStartNodes)`), ensuring absolute fidelity of node list order, layer hierarchy, and z-indexes across continuous eraser sweeps.

### [changesets/release] Peer Dependency Range Assertions in Package Tests

- **Issue / Symptom**: The `Release` workflow fails at the `pnpm test` step after `pnpm version-packages` (`changeset version`), with an assertion error such as `expected '>=0.30.0 <1.0.0-0' to be '>=0.29.0 <1'`.
- **Root Cause**: `@changesets/cli` automatically synchronizes and bumps `peerDependencies` across monorepo workspace packages when a core package version increments. Any unit tests asserting strict exact string equality against a static version string fail as soon as Changeset bumps the package in the release pipeline.
- **Solution / Workaround**: Test package.json `peerDependencies` using regex patterns that accommodate dynamic minor/patch version increases (e.g. `expect(pkg.peerDependencies["@pixerate/editor"]).toMatch(/^>=0\.\d+\.0.*<1/)`) while still enforcing exclusion from direct `dependencies`.

### [react|svelte/canvas] Pointer-Events and Spacebar Panning in Freehand Drawing Overlays

- **Issue / Symptom**: When an interactive SVG drawing overlay (`CanvasDrawLayer`) covers the canvas, standard xyflow panning, node dragging, and canvas selection are blocked. Conversely, if pointer events are disabled, drawing gestures cannot be captured. Furthermore, users cannot pan the canvas without first switching away from the drawing tool.
- **Root Cause**: An overlay with `pointer-events: auto` intercepts all pointer gestures before they reach React Flow or Svelte Flow's pane and node layers.
- **Solution / Workaround**:
  1. Set `pointer-events: auto` on `CanvasDrawLayer` only when `tool !== 'select'`. When `tool === 'select'`, set `pointer-events: none` to let xyflow handle selection, dragging, and box selection natively.
  2. Implement spacebar hold detection (`isSpacePressed` via `keydown` / `keyup`). While spacebar is held down, toggle the overlay's pointer events to `none` and switch the cursor to `grab`, allowing users to hold Space and drag to pan the xyflow canvas seamlessly without changing their active drawing tool.

### [core/vector] Live Corners Vanish When an Anchor Is Copied Field by Field

- **Issue / Symptom**: A rounded corner turns sharp after moving, scaling, reversing or pasting a path, with no error.
- **Root Cause**: The radius lives on the anchor (`anchor.corner`), and several helpers build anchor copies by hand (`{ x, y, in, out, type }`), so any copy that lists the fields drops it.
- **Solution / Workaround**: Copy anchors with `cloneAnchor`, or add `...(a.corner ? { corner: { ...a.corner } } : {})` to hand-built copies (`bakeIntoGeometry`, `reverseSubpath`, `curvatureMoveAnchor`, `subpathsIn` do). Tests in `vector-corners-strokes.test.ts` move, scale, rotate and paste a rounded path.

### [core/vector] `subpathsToBezier` Draws Live Corners, So Its Segments No Longer Match the Anchors

- **Issue / Symptom**: Code that walks the Bézier commands of a path and maps segment `i` back to anchor `i` gets the wrong segment (or one too many) on a path with corner radii.
- **Root Cause**: `subpathsToBezier` runs `expandVectorCorners`, the one place live corners are cut; a cut corner adds an anchor and trims both neighbouring segments.
- **Solution / Workaround**: Use `subpathSegment(sp, i)` / `nearestSegment` for anchor-indexed segments, or `subpathsToBezier(subpaths, { corners: false })` for the sharp outline. `expandVectorCornersOf` also returns `sources`, the stored anchor each drawn anchor came from.

### [core/vector] One Cubic per Corner Cut Loses Accuracy at Sharp Angles

- **Issue / Symptom**: The round cut of a very acute corner (a star's tip) is visibly not quite circular when zoomed far in.
- **Root Cause**: A cubic arc's radial error grows with roughly the sixth power of the angle it turns through: about 0.03 % of the radius for a 90° turn, about 0.6 % for the 150° turn of a 30° corner.
- **Solution / Workaround**: Acceptable for drawing (figcraft does the same); the tests assert < 1 % at 30°. If an exact arc ever matters, split cuts turning more than 90° into two cubics in `cutCorner`.

### [core|react|svelte/vector] Clip Paths and Masks for Aligned Strokes Need Node-Local Coordinates and Explicit Mask Bounds

- **Issue / Symptom**: An inside / outside stroke is clipped in the wrong place on rotated nodes, or an outside stroke (and its arrowheads) is cropped at the shape's bounding box.
- **Root Cause**: `clipPathUnits` / `maskContentUnits` default to `userSpaceOnUse`, which is the user space of the *referencing* element, transform included, so the clip shape must use the node's own coordinates (the same `d` as the fill), not document ones. A `<mask>` without `maskUnits="userSpaceOnUse"` and a box covers only the object's bounding box plus 10 %, which cuts a wide outside stroke.
- **Solution / Workaround**: `vectorStrokeSvgParts` returns `clip.bounds` (the outline's bounds padded by `vectorStrokeReach`) and both canvases and the SVG export write `<mask maskUnits="userSpaceOnUse" x y width height>` with a white rect and the shape in black, inside the node's own `<g transform>`. Ids come from the canvas `idPrefix`, so two canvases on a page don't share clips.

### [core/vector] `render.ts` and `svg.ts` Import Each Other's Module Graph

- **Issue / Symptom**: Moving a render helper that the SVG exporter needs into `render.ts` creates an import cycle (`svg.ts → render.ts → controller.ts → svg.ts`).
- **Root Cause**: `render.ts` already imports `vectorPaintToSvg` from `svg.ts`, and the controller imports `svg.ts` for `toSvg` / `loadSvg`.
- **Solution / Workaround**: Keep helpers both need in `svg.ts` (or lower: `stroke.ts`, `corners.ts`, `geometry.ts`), e.g. `vectorStrokeSvgParts` and the `VectorRenderStrokeParts` type, and import them into `render.ts`. `stroke.ts` and `corners.ts` import only path ops and types, so `geometry.ts` can use them.

### [core/vector] Width Handles Only Hit-Test on Paths the Overlay Already Shows

- **Issue / Symptom**: A width-tool press or double-click on a width point added a new point (or opened the editor on a stroke spot) instead of grabbing the existing one, when no pointer move had hovered the path first (tests, touch, a double-click straight after a tool switch).
- **Root Cause**: `getVectorWidthHandles` lists the points of the hovered, selected and dragged paths only, and `hitWidthHandle` searched that list.
- **Solution / Workaround**: `hitWidthHandle` falls back to the points of the stroke under the pointer (`strokeSpotAt`) when the shown ones miss. Keep any new width gesture going through it rather than `getVectorWidthHandles(state)` directly.

### [core/vector] Moving Several Width Points Re-Sorts the Profile and Renumbers Them

- **Issue / Symptom**: After a multi-point move (or a copy, or `setWidthPoint` with a new `t`) the selection pointed at the wrong points, or a step's two halves swapped.
- **Root Cause**: Width points are addressed by index into a profile kept sorted by `t`; a group move or a copy can pass other points. `setWidthPoint` from `width.ts` clamps a single point between its neighbours to keep indices stable, but group moves and the numeric editor deliberately don't.
- **Solution / Workaround**: Sort stably with the old index as the tie-break and carry an old → new map (`shiftWidthPoints` in `controller.ts`, `drag.renumber`); insert copies and moved points with `insertWidthPoint(…, { step: true })` and use the returned index. Undo restores the profile but not the selection, so `restore` drops selected refs whose index no longer exists and closes the width-point editor.

### [react|svelte/vector] HTML Inside the Canvas `<svg>` Must Stop Its Events

- **Issue / Symptom**: Typing Delete in the width-point editor deleted width points, clicking it started a width drag, and copying from its inputs copied the drawing.
- **Root Cause**: The editor lives in a `<foreignObject>` inside the canvas `<svg>`, whose `pointerdown` (focus + pointer capture), `keydown`, `dblclick` and clipboard handlers see every bubbling event. `isVectorTextTarget` only covers keys typed into text fields, not buttons.
- **Solution / Workaround**: `VectorWidthPointEditor` stops propagation of pointer, double-click, key and clipboard events on its `<form>` (Svelte's delegated handlers honour `stopPropagation` too) and hands focus back to the closest `<svg>` when it closes.

### [core/vector] Shape Builder Edges Run Between Junctions, Not Anchors, and Cutting One Flattens Live Corners

- **Issue / Symptom**: Alt-erasing what looks like one side of a rectangle can take two sides (and the corner between them); a cut path loses its live corner radii; and a filled open path's erased edge can bring back its invisible closing segment.
- **Root Cause**: `PlanarMap.chains()` only breaks a run where other paths meet it (or it ends), so a corner inside another shape is mid-edge. The edges are cut out of the document-space outline from `vectorPathWorldBezier`, which already has live corners cut into curves. A filled open subpath that encloses an area is closed in the map, so its edges may run over the closing segment.
- **Solution / Workaround**: Pick test points and expectations by junctions, not anchors. `cutOutPiece` treats filled open subpaths as rings with an invisible closing span (`real..len`) and stops kept runs at it, so it never becomes a visible segment. The cut result is mapped back through the inverse of the node's matrix and written with `bezierToSubpaths`, keeping the node's transform; the corner radii are not kept. `VectorShapeBuilderMap.edges` is a lazy getter: spreading the map evaluates it, so pass the map itself around.

### [tests] `randomize()` Tests Flake When the Random Value Lands on the Default

- **Issue / Symptom**: The React and Svelte parameters binding tests occasionally failed in CI at `expect(state.modified).toBe(true)` right after `randomize(["speed"])`.
- **Root Cause**: The controller used `Math.random`, and the field snaps to its step: any draw in about [0.2375, 0.2625) gives back the default `speed` of 1, so nothing is modified (about a 1 in 40 chance).
- **Solution / Workaround**: Give the controller a fixed source in tests (`new ParametersController({ schema, random: () => 0.75 })`) or call `randomize({ seed })`, and assert the value it picks. Never assert a change after an unseeded randomize.

### [core/vector] Picking a Morph's Start Anchor by Position Squashes Turned Shapes

- **Issue / Symptom**: Blending a horizontal bar into the same bar turned 90° gave a middle step that was a fat square (area up a third) instead of the bar half turned, even with the Procrustes in-between.
- **Root Cause**: effectcraft's `correspond` scores each cyclic start by how far corresponding anchors are apart once both shapes are centred and scaled. That cost is not rotation-invariant: the start that pairs each corner with the nearest one (a squash) beats the one that pairs it with the turned corner, and Procrustes then finds no rotation to follow. Its absolute-angle shape-context histograms push the same way.
- **Solution / Workaround**: `bestStart` in `vector/blend.ts` scores what is left after the best-fit rotation and scale (`1 − (dot² + cross²) / n²` on unit-RMS point sets, O(n) per start), plus `0.1 · (1 − cos θ)` so the least turning wins among equal fits (circles, squares), plus shape contexts whose angles are measured from the contour's direction (rotation-invariant).

### [core/vector] Largest-Remainder Anchor Allocation Must Treat Rounding Noise as a Tie

- **Issue / Symptom**: A star and the same star turned did not keep their area through a blend: the in-betweens came out slightly distorted.
- **Root Cause**: When a contour's segments all have the same length, the fractional parts of their anchor shares differ only by floating-point noise, and that noise — different for the turned copy — decided which segments got the extra anchors. The two shapes were refined differently, so no start lined them up exactly.
- **Solution / Workaround**: `refineMorphContour` sorts remainders with a 1e-9 tolerance and breaks ties by segment index, so congruent shapes are split alike.

### [core/vector] `mapTree` Visits the Node It Just Returned

- **Issue / Symptom**: Adding a shape to a blend with `mapTree(nodes, (n) => n.id === key ? null : n.id === blend ? { ...blend, children: [...children, key] } : n)` reported success, but the key vanished from the document.
- **Root Cause**: The controller's `mapTree` recurses into the children of whatever the callback returns, so the moved key was found inside the new group and removed again.
- **Solution / Workaround**: Remove first, then insert with `spliceTree` (or any pass that does not re-run the callback on its own output).

### [core/vector] Blend Steps Are Rebuilt in `notify()` and `commit()`, Keyed by Key Identity

- **Issue / Symptom**: A live blend has to follow every edit of its keys (drags included) without each tool knowing about blends, and undo must restore steps that match the keys.
- **Root Cause**: Steps are derived data stored in the document (so the scene, bounds, hit-tests and SVG export see them), and the controller mutates `this.doc` in many places.
- **Solution / Workaround**: `refreshVectorBlends` runs on the document in `notify()` (live during drags) and at the start of `commit()` (so history snapshots hold the refreshed document). It returns the same objects when nothing changed: generated children are cached per first key and reused while the keys are the same objects and the blend options serialise the same, and morph correspondences are cached per key pair. Steps are locked (`locked: true`) so the select tool picks the blend group and the direct tool only reaches keys; transforms of the group bake its replaced spine with the children (`bakeIntoGeometry`).

### [core/vector] Expanded Appearance Paths Have Ids That Are Not in the Document

- **Issue / Symptom**: After path effects and live booleans were routed through `vectorPathEntries`, the Pathfinder and `booleanOp` failed to put their result back: `findVectorNode([root], entry.node.id)` found nothing, so the result replaced no node.
- **Root Cause**: `expandVectorAppearance` turns a node drawing several shapes (a repeater, a live group) into a group of paths with ids `<id>~fx<n>`. Those are derived nodes, never stored; only the top node keeps its stored id.
- **Solution / Workaround**: Look entries up through the expanded tree as well (`controller.holds(rootId, id)` checks `findVectorNode` on the node and on `expandVectorAppearance(node)`), drop the roots by their stored ids, and give derived nodes fresh ids before storing them (Expand Appearance does). Code that edits the shapes it reads (the Shape Builder) must ask for the stored geometry with `vectorPathEntries(doc, roots, { expand: false })`.

### [core/vector] Merged Undo Steps Need the Command's `tag` Equal to Its Gesture Key

- **Issue / Symptom**: A slider drag committed with `history.executeMerged(command, { key })` folded into one undo step, but the step kept growing: every move added another undo / redo part.
- **Root Cause**: `HistoryManager.executeMerged` only replaces the top step's last part ("the same absolute command again") when the new command's `tag` equals that part's tag; otherwise it appends a part.
- **Solution / Workaround**: The controller's `commit(name, before, merge)` sets `tag: merge` on the snapshot command, so the step keeps the pre-drag `before` and only the latest `after`. Ending the drag calls `endMergedEdit()` (`history.endGesture()`) so the next drag of the same control starts a new step.

### [core/vector] Wiggle's Hash Needs Exact 64-bit Arithmetic

- **Issue / Symptom**: A wiggle ported with JavaScript numbers gave different (and less random) noise than the source, and lost precision past 2⁵³.
- **Root Cause**: effectcraft's `splitmix` / `hash` rely on wrapping `u64` multiplication and shifts; `Math.imul` is 32-bit and doubles lose the low bits.
- **Solution / Workaround**: `pathEffects.ts` runs `splitmix` on `BigInt`s masked to 64 bits (`BigInt.asUintN(64, …)` for negative lattice indices) and converts only the final `h >> 11` to a number. It is called a few thousand times per wiggle, which is cheap; results are cached per node anyway.

### [core|react/vector] StrictMode's Double Effect Destroys the Controller `useVectorEditorController` Keeps

- **Issue / Symptom**: In the dev demo (React StrictMode) the toolbar's History buttons lagged one step: after an edit Undo stayed disabled, after an undo Redo stayed disabled — though `controller.getState()` was right whenever it was next read.
- **Root Cause**: `useVectorEditorController` creates the controller once in a ref and calls `controller.destroy()` in an effect cleanup. StrictMode runs effects, cleans them up and runs them again, so `destroy()` dropped the controller's history subscription while the same controller stayed in use. History-only changes (labels, `canUndo`/`canRedo`) then reached the UI only with the next document change.
- **Solution / Workaround**: The controller's history connection is idempotent (`connect()`), made in the constructor and again on every `subscribe()`, catching up on history changes missed while disconnected. StrictMode's re-run of `useSyncExternalStore`'s subscribe effect reconnects it. Any core controller whose `destroy()` a React hook calls from a ref-kept instance needs the same treatment (or must be created inside the effect).

### [core/vector] `objectBoundingBox` Gradients Paint Nothing on a Straight Line

- **Issue / Symptom**: A gradient stroke on a horizontal or vertical line (or a stroke part drawn on a different element than the fill) disappears or shifts.
- **Root Cause**: SVG maps `objectBoundingBox` gradients onto the painted element's own geometry box; a box with no height (or width) is singular, so browsers paint nothing, and each element of a stroke drawn in parts has its own box.
- **Solution / Workaround**: The vector editor writes every gradient in `userSpaceOnUse` with the shape's box as the `gradientTransform` (`vectorBoxMatrix`), computed once per node from its outline, and a side with no extent takes the other side's (centred). Fill, stroke parts and effect copies then share one frame.

### [core/vector] A Linear Gradient's t Is a Projection, Not a Frame Coordinate

- **Issue / Symptom**: A `userSpaceOnUse` linear gradient on a sheared shape exported to SVG paints at the wrong angle, though the editor's own sampling is right.
- **Root Cause**: The model measures t as the u coordinate in the start / end / width frame (exact under any affine map), but SVG's `x1 y1 x2 y2` measures the projection onto x1 → x2, which only agrees while the width axis is square to the main axis.
- **Solution / Workaround**: `vectorGradientSvgDefs` writes `x1 y1 x2 y2` when the frame is square and `x1=0 x2=1` with the frame as `gradientTransform` otherwise. Keep that check if the export changes.

### [core/vector] Adaptive Stop Expansion Must Probe Near the Ends of Each Piece

- **Issue / Symptom**: Oklab or linear-light gradients exported as stops were off by two colour levels just after a stop whose colour has a zero channel.
- **Root Cause**: Converting back to sRGB applies the gamma curve, whose slope is steepest next to 0, so the error of a straight piece peaks close to its end; checking only the quarter points missed it.
- **Solution / Workaround**: `expandVectorGradientStops` checks each piece at 3 %, 10 %, 25 %, 50 %, 75 %, 90 % and 97 % before accepting it. The tests compare 2000 samples against the true ramp.

### [core/vector] Gradient Samples on a Period's Edge or a Conic Centre Are Ambiguous

- **Issue / Symptom**: Tests comparing a `repeat` gradient (or a conic one) with its exported paint server fail at a few grid points with a completely different colour.
- **Root Cause**: At t exactly on a whole number, `repeat` gives 0 or 1 depending on rounding (the first or last stop), and a conic gradient's angle is undefined at its centre and jumps at its seam.
- **Solution / Workaround**: Skip sample points within 1e-4 of a period edge, the centre and the seam; anywhere else the paint server must match the model within 2 / 255. The canvases' checkerboard is also a `<pattern>`: select a gradient pattern by its id (`pattern[id$="fill-a"]`), not by tag.

### [core|react|svelte/vector] Pattern Content Starts at the Tile's Corner

- **Issue / Symptom**: Conic and diamond fills (patterns of gradient tiles) drew nothing, or the wrong part of the sweep, in the browser although every `<pattern>`, tile and gradient was there.
- **Root Cause**: Without a `viewBox`, an SVG `<pattern>`'s content coordinate system has its origin at the tile's `(x, y)`, not at the user-space origin, so content written in user space was shifted by the tile's position (outside the tile).
- **Solution / Workaround**: `patternAttrs` gives every pattern a `viewBox` equal to its tile (`x y width height`), which maps content coordinates one to one onto the user space. Keep it when rendering `VectorSvgPatternDef.attrs`.

### [core/vector] Warp Meshes Must Extrapolate Outside Their Box

- **Issue / Symptom**: Curved shapes under an envelope gained far more anchors than straight ones and came out lumpy near the box edges, although the warp itself was smooth.
- **Root Cause**: The envelope's box is the paths' tight curve bounds, so Bézier handles routinely lie outside it. The ported `locate` clamped the box fraction to 0–1, which squashed every handle outside the box onto the border; the adaptive mapper then saw the mapped control polygon stray from the mapped curve and kept splitting.
- **Solution / Workaround**: `locate` in `warp.ts` no longer clamps: outside 0–1 the end patches' polynomials simply continue, so handles past the box map smoothly. Callers that need a point on the surface (`vectorMeshParamAt`) clamp their own parameters.

### [react|svelte/vector] Two Panels Editing One Effect Collide on Their Labels

- **Issue / Symptom**: After switching an envelope to Mesh, tests still found the "Envelope Bend % slider" the Envelope panel had just hidden.
- **Root Cause**: The generic Effects panel builds a control per entry of `VECTOR_EFFECT_PARAM_SPECS` and labels it `${effect label} ${param label}`, so it rendered the envelope's bend, distortion, orientation and mesh-size controls with exactly the Envelope panel's labels, regardless of the style.
- **Solution / Workaround**: `getVectorEffectsPanel` returns no `specs` for an envelope (it still lists it to toggle, reorder and remove); `VectorEnvelopePanel` edits it. The specs stay in `VECTOR_EFFECT_PARAM_SPECS` because `normalizeVectorEffectParams` validates against them.

### [core/vector] Free Distort Takes Over Mod on the Selection Box

- **Issue / Symptom**: Mod-dragging a box handle normally scales without snapping; in Free Distort mode it skews (sides) or, with Shift+Alt, makes a symmetric perspective (corners).
- **Root Cause**: Illustrator's Free Transform modifiers (Cmd on a side shears, Cmd+Alt+Shift on a corner is perspective) clash with the editor's "hold Mod to bypass snapping".
- **Solution / Workaround**: The distort modifiers apply only while `state.freeDistort` is on (the toolbar's Distort toggle); out of that mode the box scales as before. Distort drags never snap.

### [core/agent] Agents Can't Turn Plain Text into ProseMirror Positions

- **Issue / Symptom**: An agent read the document with `get_text`, counted characters to the word it wanted, and called `insert_text { at }`. The text landed a few characters off, more so further down the document.
- **Root Cause**: Editing tools take ProseMirror document positions. Each block boundary adds positions that don't exist in the plain text (`<p>a</p><p>b</p>`: "b" is at 4, not at offset 2), and inline nodes count as one position. Plain-text offsets and document positions only agree at the start of the first paragraph.
- **Solution / Workaround**: Never ask a model to compute positions. `find_text` returns `{from, to}` for each match, and `get_text { blocks: true }` returns each textblock's `from`/`to`. Edits by content go through `replace_text`, which searches and replaces in one transaction (last match first, so earlier positions stay valid). Any new tool that takes positions must have a read tool that returns them.

### [core/agent] The Planner Is Lenient, So Tool Providers Must Validate First

- **Issue / Symptom**: `edit_canvas { operation: "remove_nodes", nodeIds: ["typo"] }` reported `applied: 1`, and nothing happened. An added node without an id got a generated id the agent never saw, so its next `connect` call used a made-up id.
- **Root Cause**: `planAgentCommand` is built for UI choreography. It falls back instead of failing (unknown anchor → place beside the last node) and plans steps for ids that don't exist, leaving `applySteps` to ignore them. The provider returned only step types.
- **Solution / Workaround**: `createEditorMcpToolProvider` runs `validateAgentCommand(command, snapshot)` before planning. Unknown ids, an id that already exists, self-edges and unordered ranges come back as tool errors naming the bad id. Results include `created: { nodes, edges }` with the generated ids. Hosts that call the planner directly should call `validateAgentCommand` too. Prompt positions are host-defined, so only their order is checked.

### [core/tools] `anyOf` / `oneOf` Errors Must Point at the Closest Branch

- **Issue / Symptom**: With composition keywords, a validator that only says "does not match any schema" leaves a model guessing. A model that retries blindly tends to swap to the other branch instead of fixing the one field it got wrong.
- **Root Cause**: Every branch fails for its own reasons, and reporting all of them buries the useful one.
- **Solution / Workaround**: `validateJsonSchema` reports one summary error plus the errors of the branch with the fewest errors (usually the one whose `const` discriminator matched). `$ref` only resolves local pointers (`#`, `#/$defs/...`) and stops after 32 hops, so recursive schemas (`items: { $ref: "#" }`) work and cycles can't hang the registry. Keywords it doesn't know are ignored, so tool authors should stick to the documented list.

### [core/tools] MCP Distinguishes Protocol Errors from Tool Errors

- **Issue / Symptom**: A server that reports every failure the same way breaks clients. If a call to a tool that was removed (its editor unmounted) comes back as a normal tool result, the model keeps retrying it. If a cancelled `tools/call` still sends its late result, the client sees a response to a request it no longer tracks.
- **Root Cause**: The MCP spec puts an unknown tool or malformed `params` at the JSON-RPC level (`-32602`), while invalid arguments and execution failures are `isError` results the model reads. Cancellation (`notifications/cancelled`) means the server must not respond to that request.
- **Solution / Workaround**: `createMcpServer` returns `-32602` for unknown tools and non-object `arguments`, passes `invalid_arguments` / `tool_failed` through as `isError` results, aborts the call's `AbortSignal` on cancellation and resolves `handle()` to `null` for it. `notifications/tools/list_changed` is only sent after `notifications/initialized`.

### [core/chart] Tick Steps Below the Float Spacing Stall a Running Sum

- **Issue / Symptom**: `niceScale(1e16, 1e16 + 4)` returned up to 1000 identical ticks, and axis labels with a 2.5 step merged (`0 | 3 | 5 | 8 | 10`).
- **Root Cause**: Ticks were built with `t += step`. Near 1e16 the float spacing is 2, so adding 1 rounds back to the same value and the loop only stops at its cap. Separately, label decimals came from the step's order of magnitude, which says 0 decimals for 2.5 and 1 for 0.25. `clean()` (`toPrecision(12)`) also flattens 1e16 + 2 to 1e16.
- **Solution / Workaround**: Compute tick `i` as `(firstIndex + i) * step`, drop neighbours that round to the same float, and only `clean` when that moves a value by less than a millionth of the step. `stepDecimals` counts the decimals of the step itself. When `hi - lo` overflows (±`Number.MAX_VALUE`), take the step from the half span and double it.

### [core/chart] A Drag Must Freeze the Value Axis and Drop No-op Steps

- **Issue / Symptom**: Dragging a bar past the axis maximum rescaled the axis under the pointer, so the bar seemed to run away. Dragging back to the start, or setting a value to what it already was, still left an undo step.
- **Root Cause**: Every move relaid the chart with a fresh `niceScale` over the new data. The controller recorded every commit and merged gesture steps without comparing them to the starting spec.
- **Solution / Workaround**: `startChartPointDrag` returns `valueDomain`. Canvases keep it in state and pass it to `layoutChart({ valueDomain })` until `end()`. `ChartController.commit` returns early when the next spec is structurally equal to the current one, and `endGesture` calls `history.revertTo(mark)` when the spec is back where the gesture began.

### [svelte] A Variable Named `state` Breaks `$state` in the Same Component

- **Issue / Symptom**: `let state = $state.raw(...)` in `ChartPresenceLayer.svelte` failed svelte-check with "Block-scoped variable '$state' used before its declaration" and "Cannot use 'state' as a store".
- **Root Cause**: In a component, `$name` means "subscribe to the store `name`". With a local variable called `state`, the compiler reads `$state` as a store subscription to it, not as the rune.
- **Solution / Workaround**: Never name a component variable `state` (or `derived`, `effect`, `props`). Use `current`, `view` or similar.

### [core/import] Imported HTML Drops `data:image/svg+xml` Images

- **Issue / Symptom**: Charts imported from DOCX as SVG `<img>` tags vanished from the HTML.
- **Root Cause**: `sanitizeImportedHtml` validates `src` with markdown-it's `validateLink`, which only allows `data:image/(gif|png|jpeg|webp)`. SVG data URLs are rejected on purpose (SVG can carry script when opened directly).
- **Solution / Workaround**: The DOCX importer writes each chart as `<div data-type="chart" data-chart="{spec}">` around a caption and a data table, and returns the full spec in `DocumentImport.charts`. With the `chart` node in the schema the div becomes a live chart; without it the div is a plain wrapper and the caption and table stay. The chart node's own HTML carries its static SVG inline (the sanitizer drops it with its content on import; the spec in `data-chart` is what is parsed). Do not widen the URL allowlist for SVG.

### [core/chart] Atomic `run_commands` Only Covers Edits in the Registry's History

- **Issue / Symptom**: `run_commands { atomic: true }` left chart edits applied after a later step failed.
- **Root Cause**: The batch is a `history.batch` on the `CommandRegistry`'s own `history`. A `ChartController` created without `history` records into its own `HistoryManager`, which the batch never sees.
- **Solution / Workaround**: Share one `HistoryManager` between the registry (`new CommandRegistry({ history })`) and the controllers (`new ChartController({ history })`). Without a registry history, atomic batches are refused with a sentence.

### [core/chart] A User Drag During an Agent Performance Ends the Agent's Undo Step

- **Issue / Symptom**: If the user drags a bar while `ChartDirector` is acting out an agent's edits, the agent's edits before and after the drag become separate undo steps.
- **Root Cause**: `ChartController` holds one gesture at a time; `beginGesture` from the user's drag ends the director's gesture.
- **Solution / Workaround**: Accepted: both sets of edits still apply and undo correctly, only the grouping differs. Hosts that need strict grouping can disable editing (`editable={false}`) while `presence` shows an active actor.

### [monorepo] A Patch Changeset Moves the React Peer Range Off `.0`

- **Issue / Symptom**: The Release run failed after merging a patch changeset: `expected '>=0.46.1 <1.0.0-0' to match /^>=0\.\d+\.0.*<1/` in `packages/react/tests/react.test.ts`. PR CI passed because it runs the tests before `changeset version`.
- **Root Cause**: `updateInternalDependencies: "patch"` makes `changeset version` raise the react package's `@pixerate/editor` peer range to the new core version, which ends in `.1` after a patch release. The test assumed it always ends in `.0`.
- **Solution / Workaround**: The test accepts any `>=0.x.y <1` range. To catch this class of failure before merging, run `pnpm version-packages && pnpm test`, then discard the version changes.

### [monorepo] Dependabot Bumps Can Load Two Copies of `prosemirror-model`

- **Issue / Symptom**: After a grouped Dependabot bump (#136), table, track-changes and document-structure tests failed with `Can not convert <…> to a Fragment (looks like multiple versions of prosemirror-model were loaded)`.
- **Root Cause**: `prosemirror-markdown@1.13.8` resolved `prosemirror-model@1.25.12`, while the TipTap packages stayed on 1.25.11. ProseMirror checks node types by identity, so nodes from one copy are rejected by the other.
- **Solution / Workaround**: Run `pnpm dedupe` and commit the lockfile. After any dependency bump, check that `pnpm-lock.yaml` has a single `prosemirror-model@` entry.

### [core/extensions] An Attribute's `parseHTML` Overrides the Parse Rule's `getAttrs`

- **Issue / Symptom**: A ```` ```mermaid ```` block parsed into a chart node with an empty spec, although the `pre` parse rule's `getAttrs` returned the spec read from the code.
- **Root Cause**: TipTap wraps every parse rule: it calls the rule's `getAttrs`, then each attribute's own `parseHTML(element)`, and spreads the attribute values over the rule's. Only `null` / `undefined` leave the rule's value in place, so `parseHTML: (el) => read(el) ?? fallback` always wins.
- **Solution / Workaround**: When a node has several parse rules, attribute `parseHTML` must return `null` when its source is missing (the chart's `spec` and `height` do); the attribute `default` still applies when neither sets it.

### [core/extensions] `addNodeView` Cannot Opt Out by Returning `null`

- **Issue / Symptom**: A node whose `addNodeView` returned `null` when no framework view was configured would throw when ProseMirror created the node view.
- **Root Cause**: TipTap only checks that the `addNodeView` *field* exists, then calls the factory it returns for every node; a `null` factory is called like a function.
- **Solution / Workaround**: Always return a factory. `createChartNodeView(mount, renderStatic)` mounts the framework component when there is one, and otherwise draws (and redraws on update) the same static SVG as `renderHTML`.

### [core/agent] Quick Agent Edits Merge Into One Undo Step

- **Issue / Symptom**: `insert_chart` followed by two `update_chart_in_document` calls was undone in one Mod-Z, removing the chart.
- **Root Cause**: `prosemirror-history` groups transactions that arrive within `newGroupDelay` (500 ms), and tool calls come back to back.
- **Solution / Workaround**: The chart tools mark their transaction with `closeHistory(tr)` (`@tiptap/pm/history`), so each call starts its own undo step.

### [react|svelte/chart] A Chart Node View Keeps Its Own Controller in Step With the Document

- **Issue / Symptom**: Writing every `ChartController` change into the document turned one bar drag into dozens of document steps, and undo in the editor left the canvas showing the old chart.
- **Root Cause**: The canvas, inspector and data grid edit a `ChartController`; the document stores the spec as a node attribute. They are two sources of truth.
- **Solution / Workaround**: `ChartNodeView` (core) subscribes to the controller and writes the spec with `setNodeMarkup` only when no gesture is running, skipping specs equal to the node's. Its `update(node)` loads a changed spec into the controller with `clearHistory: true` (undo, agent tools, collaborators). While the inspector is open `stopEvent` returns `true`, so inputs and keys stay in the inspector, and `ignoreMutation` always returns `true`. The React view renders in its own root (`createRoot`), so app context does not reach it, and it unmounts in a microtask because ProseMirror can destroy node views during a React render. The Svelte component takes the state as `view`, not `state` (see "A Variable Named `state` Breaks `$state`").

### [svelte/packaging] `Foo.svelte` and `foo.svelte.ts` Collide on Case-Insensitive Disks

- **Issue / Symptom**: `svelte-check` warned "Cannot write file `dist/chart-node/chartNodeView.svelte.js` because it would be overwritten by multiple input files", next to `ChartNodeView.svelte`.
- **Root Cause**: A component `ChartNodeView.svelte` and a rune module `chartNodeView.svelte.ts` both emit `…/[Cc]hartNodeView.svelte.js` / `.d.ts`; macOS and Windows file systems treat the names as one file.
- **Solution / Workaround**: Give rune modules a name that differs from every component in the folder by more than case (here `createChartNodeView.svelte.ts`).

### [core/export] Charts Round-Trip Through Word Without Their Series Ids

- **Issue / Symptom**: A chart exported with `exportDocx` and imported again has the same data, colours and options, but its series ids are `series-1`, `series-2`, … instead of the originals, and colours come back lower-case.
- **Root Cause**: `chartToOoxml` writes a DrawingML `c:chartSpace`, which has no place for a series id; `chartFromOoxml` numbers series on read and writes colours as lower-case hex. The import also does not read the drawing's `wp:extent`, so the node's `width` / `height` fall back to the defaults.
- **Solution / Workaround**: Compare round-tripped specs without series ids (as `tests/docx-export.test.ts` does), and do not key anything that must survive a Word round trip on series ids. Sparklines have no Word equivalent here and are exported as text (label, or `▁▅█` bars).

### [react|svelte/canvas] Streamed Nodes Lose Their Edges in React Flow

- **Issue / Symptom**: In the Mermaid streaming view, only the last edges to arrive were drawn; earlier ones vanished while nodes glided between layouts.
- **Root Cause**: Every tween frame passes new node objects. Without `measured`, React Flow treats a changed node object as unmeasured and drops its handle bounds, and edges whose handles have no bounds are not rendered.
- **Solution / Workaround**: Keep the sizes React Flow reports (`dimensions` changes in `onNodesChange`) and pass them back as `node.measured` (see `MermaidDiagramDemo.tsx`). Controlled editors that already apply `applyNodeChanges` are not affected.

### [core/canvas] Moving One Node of an Auto-Laid Mermaid Diagram Shifted the Others

- **Issue / Symptom**: Dragging one node of a diagram without a `%% @pixerate` layout moved every other node by the same offset.
- **Root Cause**: `ensureDiagramLayout` keeps stored positions and aligns the auto layout of the rest on them (Ursula's blend). With one stored node, the whole auto layout is shifted to match it.
- **Solution / Workaround**: Pin the current positions on the first move: `mermaidMovesFromCanvas(..., { stored: doc.meta.layout })` (the React / Svelte bindings do) and `createDiagramToolProvider(controller, { getPositions })` for agent moves.

### [core/bridge] `http.close()` Hangs While a WebSocket Peer Stays Open

- **Issue / Symptom**: Closing the tool bridge in tests hung until the test timed out.
- **Root Cause**: Upgraded sockets are no longer HTTP connections, so `server.closeAllConnections()` does not touch them, but `server.close()` still waits for them. A peer that never answers a close frame keeps the server open.
- **Solution / Workaround**: The bridge tracks every upgraded socket and destroys them on `close()`. A closed WebSocket is also destroyed one second after its close frame if the peer stays silent.

### [svelte/tests] Node's WebSocket Fails Under jsdom ("event" must be an instance of Event)

- **Issue / Symptom**: A Svelte test that opened a real WebSocket under the jsdom environment threw `The "event" argument must be an instance of Event`.
- **Root Cause**: jsdom replaces the global `Event`, and Node's built-in WebSocket (undici) rejects events that are not its own. Under the `node` environment, the Svelte tests resolve the server build, where `$effect.root` does not run.
- **Solution / Workaround**: Test the network path in core under the `node` environment (`tests/tool-bridge.test.ts`). Test runes with a fake socket passed as `options.WebSocket`.

### [core/chart] Agent Cursors Never Disappeared After `linger`

- **Issue / Symptom**: A `ChartDirector` cursor stayed on the chart after its command finished, although `linger` should hide it.
- **Root Cause**: The queue stored `run.catch(...)` but the linger check compared the stored promise with `run`, which never matched, so the cursor was never removed.
- **Solution / Workaround**: The per-actor queue now lives in `PerformanceQueue` (`animation/presence.ts`), shared by the chart and diagram directors, and compares against the promise it stored.

### [core/tests] Undestroyed TipTap Editors Crash Later Test Files ("document is not defined")

- **Issue / Symptom**: The full test run reported an unhandled `ReferenceError: document is not defined` from `prosemirror-view`'s `DOMObserver.flush`, attributed to `chart-node.test.ts`, while that file passed on its own.
- **Root Cause**: Editors created in a test and never destroyed keep ProseMirror's DOM observer timers. Under load, a timer fires after the file's jsdom environment is torn down.
- **Solution / Workaround**: Destroy every editor a test creates. `chart-node.test.ts` tracks them in an `afterEach`.

### [core/chart] Don't Recover a Category Index From a Pixel

- **Issue / Symptom**: With `xAxis.reverse`, stacked areas filled down to the wrong series' baseline.
- **Root Cause**: The area layout turned each point's x pixel back into a category index (`(c - catStart) / band - 0.5`), which assumes categories run left to right.
- **Solution / Workaround**: Points carry their index (`Pt.i`) and everything maps index → pixel through `catCenter(i)` (which handles reversing, and fractional indexes for trendlines). Never invert pixels to find data.

### [core/chart] Straight Trendlines Need Sampling on a Log Axis

- **Issue / Symptom**: A linear trendline vanished on a logarithmic value axis whenever one end of it went to 0 or below.
- **Root Cause**: Linear fits were drawn from two samples (the ends). On a log axis the line is a curve, and an end with no pixel (value ≤ 0 → NaN) was dropped, leaving one point and no path.
- **Solution / Workaround**: `drawTrendlines` samples linear fits like the others (200 steps) when either axis is logarithmic and drops samples with non-finite pixels. Value → pixel on log axes goes through `chartScaleToPixel`, which returns NaN for values ≤ 0; `ScaleInfo.px` clamps those to the lower end instead, so bars and area baselines still start at the bottom.

### [core/chart] Property Tests: Series Names Can Be the Text "NaN"

- **Issue / Symptom**: Adding new random steps to `chart-property.test.ts` made a seed fail with `NaN` in the SVG, although every mark was finite.
- **Root Cause**: The extra steps shifted the random sequence; a paste then named a series `NaN` (junk cell text), which the SVG legend and `<desc>` write verbatim. The test searched the whole SVG for `NaN|Infinity`.
- **Solution / Workaround**: Check geometry attributes only (`x=`, `y=`, `d=`, `cx=`, `width=`, …). When adding steps to the property test, expect other seeds to explore new paths and read the failure before assuming the new feature is at fault.

### [core/chart] A Chart SVG Drawn to a Canvas Comes Out Black

- **Issue / Symptom**: A PNG made from a live chart's SVG (or `chartToSvg` with `CSS_VARIABLE_CHART_THEME`) had black text, axes and grid lines, and a serif font, although the chart looked right on the page.
- **Root Cause**: An SVG loaded through an `<img>` (which is how it reaches a canvas) is a separate document: the page's stylesheets and custom properties do not apply. `fill="var(--foreground, #0f172a)"` then has no `--foreground`, and some browsers treat `var()` in a presentation attribute as invalid outright, falling back to the initial paint (black). `currentColor` and `font-family="inherit"` have nothing to inherit either.
- **Solution / Workaround**: Run `resolveChartSvgPaints(svg, { scope })` before drawing (`rasterizeChartSvg` does): it replaces `var()` with the custom property's computed value on `scope` (or the fallback), `currentColor` with the scope's colour and `inherit` fonts with its font, and drops attributes left empty. Pass the chart's container as `scope` when the theme is scoped to a wrapper (e.g. `.dark`). Agent tools render with `DEFAULT_CHART_THEME` (concrete colours), so their PNGs do not depend on the page. jsdom has no canvas: tests stub `getContext`, `toDataURL` and `Image`.

### [core/chart] PowerPoint Slide Order Is Not Part-Name Order, and Excel Chartex Hides in `mc:AlternateContent`

- **Issue / Symptom**: Reading `ppt/slides/slideN.xml` by name numbers charts on the wrong slide after slides were reordered; looking for `c:chart` only in an Excel drawing misses waterfall, funnel, treemap, histogram and box charts.
- **Root Cause**: PowerPoint keeps part names when slides move; the order lives in `p:sldIdLst` in `presentation.xml`. Office 2016 charts are `cx:chart` references (chartex namespace, `chartEx` relationship) inside `mc:AlternateContent/mc:Choice`, with a picture or empty `mc:Fallback`.
- **Solution / Workaround**: `extractPptxCharts` walks `p:sldId r:id` in order and numbers slides by position. `extractOfficeCharts` matches any `chart` element in the DrawingML chart, strict chart or chartex namespace (wherever it is nested) and dedupes by target part, so a fallback that also points at a chart is not read twice.

### [core/animation-editor] A Segment's Value Is the Latest One *Started*, Not a Keyframe Track

- **Issue / Symptom**: Treating an animation scene's compiled segments like keyframes (sorting by end, or blending overlapping segments) made entering nodes visible before they entered, and made the Flair export disagree with the editor's own frames.
- **Root Cause**: The animation editor (and Flair's `svgFrame`) give a property the value of the latest segment to have started, holding its `from` before the first one. That is what hides a node until its `enter`. Segments of one command can start later than segments of a command compiled after it (an `enter: "draw"` fades its fill in at 60%), so tracks are not in start order while compiling.
- **Solution / Workaround**: `activeSegment` scans the whole track for the latest start (ties go to the later segment) instead of breaking early, and `compileMotionScene` sorts each track by start once it is done. A `draw` on a stroke with no draw-on yet starts from 0, like an enter.

### [core/animation-editor] Flair's Easings Are Cubic Polynomials, Not CSS Curves

- **Issue / Symptom**: Exported Flair motion was sampled into dozens of 33 ms linear steps for plain moves.
- **Root Cause**: Flair's `out` is `1 − (1 − t)³` and `in-out` the piecewise cubic, which differ from CSS `ease-out` / `ease-in-out` by up to ~7%. Separately, a move animates `x` and `y` as two segments, so an interval had two active segments and fell back to sampling.
- **Solution / Workaround**: The editor's defaults are `MOTION_EASE_OUT` (`cubic-bezier(1/3, 1, 2/3, 1)`, exactly Flair's `out`) and `MOTION_EASE_IN_OUT` (within 1% of Flair's `in-out`). `flairEaseFor` matches a curve to a Flair name within 1%, and the exporter writes one change when every active segment spans the same interval with the same curve.

### [core/animation-editor] Additive Layers Live on Their Own Tracks, Not on the Pose's

- **Issue / Symptom**: A shake that started during a slide cut the slide off: the box jumped back and shook in place. Putting additive deltas on the same track as the pose counted them twice once a later move started from the composed value.
- **Root Cause**: A track's value is its latest *started* segment, and every `from` is read from the track. An offset added in the same place leaks into the next segment's `from`.
- **Solution / Workaround**:
  - Segments with `blend: 'add'` go on `motionAddTrackKey(node, property)` and run from 0 (offsets, turns) or 1 (scales). `withMotionLayers` adds or multiplies every started layer onto the pose.
  - Commands read `from` from the pose track only (`valueAt`), so layers never feed back into it.
  - The overlap check skips add tracks. The Flair export puts layers on the node's transform channel: alone in a stretch they are one exact change, and overlapping the pose they are sampled (Flair has no layers).
  - Emphasis defaults to `add`; `blend: 'replace'` gives the old take-over.

### [core] The Entry-Isolation Test Reads `-import"` in a String as an Import

- **Issue / Symptom**: `tests/entry-isolation.test.ts` reported a third-party package named `, artwork, shots, …` for `/animation-editor` after a default scene name `'flair-import'` was added.
- **Root Cause**: The test scans the built files with a regex for `import … "x"`. Its lookbehind does not exclude `-`, so `"flair-import"` followed by a quote matches as an import of whatever text runs to the next quote.
- **Solution / Workaround**: Don't end string literals in shipped code with `-import` or `-export` (`'from-flair'` is used instead). If such a name is needed, tighten the test's lookbehind to exclude `-`.

### [core/animation-editor] Repeats Are Laid Out as Segments, and a Mirrored Cycle Runs Its Curve Backwards

- **Issue / Symptom**: A mirrored repeat that swapped `from` and `to` played a different curve on the way back (an ease-in came back as an ease-in, not an ease-out). After a repeat, the next command started from the wrong value.
- **Root Cause**: Swapping the ends keeps the ease running forward. Real time reversal shows at `u` what the forward run showed at `1 − u`.
- **Solution / Workaround**:
  - `compileRepeated` compiles one cycle, then copies its segments for each further cycle. Later commands read values through the same tracks, so they start where the repeat ended.
  - A mirrored copy keeps its ends and sets `reverse`: `segmentProgress` evaluates the ease at `1 − u`.
  - The Flair export writes such a copy from its value at the start to its value at the end, with `reverseCubicBezier` (`[1 − x2, 1 − y2, 1 − x1, 1 − y1]`). A reversed spring has no curve, so it is sampled.
  - `offset` adds the cycle's change once per cycle, and only to numbers. Colours and shapes repeat like `loop`.
  - `duration` is one cycle. `motionCommandDuration` includes every repeat, and `motionCycleDuration` is one.

### [core/animation-editor] `match` Morphs Parts, So the `into` Group Stays Hidden and Its Extra Parts Never Show

- **Issue / Symptom**: After a `match`, parts that only the end state has (a new avatar, say) were missing. The `into` group, if visible, sat on top of the target the whole time.
- **Root Cause**: `match` morphs each part of the target into its partner (shape, paint and place, as `morph` does) and fades out parts with no partner. Nothing of `into` is drawn: it is a description of the end state.
- **Solution / Workaround**: Keep `into` hidden (`visible: false`). For every part the end state adds, put a partner in the target with the same name or id, which can start tiny or with no fill. `check` reports `match-unpaired` (a note) for parts of `into` with no partner, and `match-self` when one group holds the other.

### [core/animation-editor] Flair's Click Trigger Plays Nothing Until the First Click, Then Steps 0 and 1 Together

- **Issue / Symptom**: The first click-trigger export put shot 0 on step 0, expecting it to play on load. In Flair's player (checked in a browser with 0.40) nothing played on load, and the first click played shots 0 and 1 together. A hover-triggered scene with several steps would play only its first.
- **Root Cause**: A triggered `SvgPlayer` does not autoplay. It draws time 0 and waits. Each click (`advance`) records a step start at the current time and plays. Step 0 starts at time 0, which the first click is also at, so steps 0 and 1 start together. After the last step a click goes back to step 1. Hover, press and scroll ignore steps altogether.
- **Solution / Workaround**:
  - For `click`, `toFlairSvgMotion` puts shot n on step n + 1 (each change's `delay` measured from its shot's start) and leaves step 0 empty. Each click plays one shot, and after the last the first plays again. Other triggers keep everything on step 0.
  - For a toggle, make the last shot put things back the way the scene starts.
  - Importing a click effect (`clickSteps`) folds step 0 into the first shot, the way Flair plays it.
  - The checks note a looped triggered scene (`trigger-loop`), a one-shot click scene (`click-one-shot`) and cues on click (`click-cue`, since clicks decide when shots start).
  - Flair's `EffectDocument` has no trigger, so `toFlairEffectDocument` keeps the steps but plays through.

### [core/animation-editor] Stroke Order Puts `drawEnd` on Each Path, and a Group's Own `drawEnd` Overrides It

- **Issue / Symptom**: A group drawn on in sequence, then drawn again with a plain `draw` on the group, ignored the per-stroke timing. Checks warned "enters while it is already showing" for a group whose strokes were each still undrawn.
- **Root Cause**: With `order`, `pace` or `comet`, `drawEnd` (and `drawStart`) segments go on each path, not on the group. Frames visit children first, then apply the group's own `drawEnd` to every path in it, replacing a child's trim.
- **Solution / Workaround**:
  - Draw a group either per stroke (with an order) or as a whole; don't mix them in one scene.
  - `visibleAt` counts a group as drawn when its own `drawEnd` and at least one stroke's are above zero.
  - The Flair export finds the owning node per path, so per-stroke windows export as exact `draw` changes. A comet's tail (`drawStart`) does not export, because Flair draws from the start of the path. Lottie writes it as the trim's start.

### [core/animation-editor] Averaging Frames in SVG Needs `plus-lighter`, Not Stacked Opacity

- **Issue / Symptom**: Motion blur made by stacking N frames at opacity 1/N came out too faint and tinted towards the first frame. A running average (layer k at 1/(k+1)) was right on an opaque background, but wrong wherever frames are transparent: a shape in only the first layer stayed fully opaque.
- **Root Cause**: The normal "over" composite is not a sum, so N layers at 1/N do not average.
- **Solution / Workaround**:
  - `motionStageSvg` adds the moments with `mix-blend-mode: plus-lighter`, each at opacity 1/N, inside an `isolation: isolate` group. That is an exact average of premultiplied colour, transparency included.
  - The background is drawn once underneath. Compositing is linear, so this equals the average of whole frames.
  - Element ids stay on the last moment only.
  - Exports (Flair, Lottie) and `motionFrameToSvg` stay sharp; the exporters note it.

### [core/animation-editor] Emphasis Behaviours Must Match Flair Number for Number

- **Issue / Symptom**: An exported wiggle or shake would play differently in Flair from the editor's preview, even though both "wiggle with seed 3".
- **Root Cause**: Flair plays an `SvgAnimation.behavior` (Flair ≥ 0.38) by swinging every number in the value from `from` towards `to` by `behaviorProgress`. A wriggle wanders each number on its own noise channel, keyed by that number's position in the value. The editor can't import Flair (Flair depends on the editor), so it carries its own copy of the maths (`animation/behavior.ts`: SplitMix64 hashing, quintic value noise, FNV-1a seeds from ids).
- **Solution / Workaround**:
  - Keep `animation/behavior.ts` identical to Flair's `vector/motion.ts`, `scene/behavior.ts` and `time/noise.ts`. `tests/animation-behavior.test.ts` pins values computed by Flair's own code; recompute them when Flair changes.
  - Emphasis segments store the peak in `to` (a pulse's swollen scale, a shake's far point) and a `behavior`. The exporter sends `to` with behaviours ignored (`trackValue(…, raw)`).
  - `MotionSegment.index` must match the number's position in the exported transform `translate(dx dy) rotate(r cx cy) …`: x is 0, y is 1 and the angle is 2. If the transform string's order changes, change the indices too.
  - A behaviour exports as one change only when every segment active over that interval shares the same span, ease and behaviour. Otherwise it is sampled.

### [core/animation-editor] Reveal Clips Live on the Frame, Not in the Vector Model

- **Issue / Symptom**: `wipe`, `iris` and `split` (Flair's `entrance.wipe` / `iris` / `split` and `exit.wipe`) need a clip path, but a frame is a `VectorDocument`, which has no clips. Clipping in document units would also disagree with Flair as soon as the node moves or scales.
- **Root Cause**: Flair reveals through a `<clipPath clipPathUnits="objectBoundingBox">` on a wrapper group, so the clip is in the units of the wrapped element's current box (0–1 across it) and follows the element. Its padding (`stroke reach / box + 0.02`, at most 1) is a share of the box, and a box with no width or height (a lone straight line) cannot be clipped.
- **Solution / Workaround**:
  - The clip rides beside the document: `clipRect` (`[x, y, width, height]`) and `clipCircle` (`[cx, cy, r]`) tracks in unit-box space, rounded to 4 places like Flair's `clipParts`, and `MotionFrame.clips` by node id. `motionFrameToSvg` (and so both `<AnimationStage>`s) writes the wrapper through `vectorDocumentToSvg`'s `wrap` option. Anything that draws a `MotionFrame` without `motionFrameToSvg` must apply `clips` itself.
  - The Flair export writes the same wrappers (`<id>--reveal`, `<id>--iris`, clip `…-clip`, shape `…-clip-shape`) and animates only the shape attributes that change. Clip wrappers sit outside the follow wrappers, so the box they measure is the node as it moves, as in the editor.
  - A clip stays after its reveal (open, or shut after a wipe out). Every `enter` opens leftover clips at once, and a reveal sets opacity at its start, or a later fade in (whose `from` holds back to time 0) would hide it all along.
  - A reveal of a node with no box fades instead, and `checkMotionScene` warns `reveal-no-box`.

### [core/animation-editor] Follows Are Measured in the Parent's Units, and Offsets Turn With Them

- **Issue / Symptom**: A follow was sampled into dozens of transform steps for Flair, and a follow inside a rotated or scaled group turned to the wrong angle.
- **Root Cause**: Flair's `along` moves a wrapper by `translate(point) rotate(angle)` measured on the path's own `d` (`getPointAtLength`), in the units of the wrapper's parent. The editor measured length and angle in document space and added the follow to the node's own offset, so an offset made during an oriented follow did not turn with the path as it does under Flair's wrapper.
- **Solution / Workaround**: `motionFollowRoute` maps the path into the node's parent's units and the follow is measured there. `motionNodeOffset` composes scale, turn and offset about the centre, then `translate(−centre)`, the path's turn and the point, the same as Flair's `<id>--follow` / `<id>--follow-centre` wrappers. The export writes the route as a `<defs>` path in those units (so a hidden path, or one in another group, still works) and one `along` per follow. Overshooting eases on an oriented follow are sampled: past the path's ends Flair measures no direction and stops turning.

### [core/animation-editor] Back Eases Cannot Go to Flair on Colours or Opacity

- **Issue / Symptom**: Writing an overshooting cubic-bezier (`ease-out-back`, `ease-in-back`, any curve with `y1` or `y2` outside 0–1) as a Flair `ease` tuple on a `fill` / `stroke` change would make Flair produce invalid hex colours, and on opacity or draw-on it would disagree with the editor.
- **Root Cause**: Flair's `lerpAttr` blends hex channels with the eased progress unclamped, so a progress past 1 or below 0 gives channel values outside 0–255. The editor clamps opacity and draw-on to 0–1 when it evaluates them.
- **Solution / Workaround**: `toFlairSvgMotion` only writes an overshooting curve on channels that extrapolate the same in both (transforms and the camera `view`); elsewhere it samples. Curves that stay in 0–1 (`ease-in`, `ease`, …) are written as tuples on every channel.

### [svelte] `role="listitem"` on a `<button>` Is an a11y Warning

- **Issue / Symptom**: `svelte-check` / vite-plugin-svelte warns `a11y_no_interactive_element_to_noninteractive_role` for a list of shot buttons.
- **Root Cause**: Svelte refuses non-interactive roles on interactive elements.
- **Solution / Workaround**: Wrap the buttons in `role="group"` with an `aria-label` and leave the buttons' own role alone (React matches it for parity).

### [monorepo/release] A Release That Fails Part-Way Can Publish Versions Whose Changelog Lands Later

- **Issue / Symptom**: After #152 merged, the Release run succeeded but printed "No unpublished projects to publish". npm's `@pixerate/editor@0.54.0` lacked `/animation-editor`, although `main`'s CHANGELOG for 0.54.0 lists it.
- **Root Cause**: The Release run for #151 versioned and published the packages, then failed ("Some packages failed to publish") before it pushed its `chore(release)` commit. `main` kept the pending changesets, so the next run computed the same versions from them, folded in #152's changeset, and found 0.54.0 / 0.41.0 / 0.49.0 already on npm.
- **Solution / Workaround**: After a failed Release, compare `npm view @pixerate/editor version` with `main`'s `packages/core/package.json`. If npm has a version that `main` has not committed yet, merge a new changeset so the next release bumps past it. Check what was published with `npm view @pixerate/editor@<version> exports`.
- **It also happened from a race (#154 / #155)**: #154's release published 0.56.0, but #155 merged while that release was running, so pushing its version commit was rejected (non-fast-forward). The push step ended in `|| echo "Failed to push tags"`, so the run still showed green. #155's release then recomputed 0.56.0 and failed with `E409 Cannot publish over previously staged version`. An extra changeset doesn't help here: changesets merges every pending minor into one bump, giving the same version again. The fix was to commit #154's version bump on its own, keeping #155's changeset pending.
- **Since then**: the release workflow pushes the version commit to `main` *before* publishing, rebasing onto merges that landed meanwhile and failing loudly if it can't. It also refuses to publish when a version `main` hasn't recorded is already on npm.

### [core/canvas] Self-Registering Modules Are Dropped Because the Package Is `sideEffects: false`

- **Issue / Symptom**: A module that only calls `registerFamilyScene(...)` at import time (and exports nothing anyone uses) works in tests but draws nothing in an app build: the family falls back to plain boxes.
- **Root Cause**: `packages/core/package.json` declares `"sideEffects": false`, so consumers' bundlers may drop any module whose exports are unused, together with its top-level registration call. Family *layouts* are safe only because `diagram/registry.ts` imports each adapter module for its exported adapter, which keeps the module (and its `registerFamilyLayout` call).
- **Solution / Workaround**: Family scenes export a function each (`pieScene`, `ganttScene`, …) and `canvas/mermaid/families/index.ts` collects them in `BUILTIN_FAMILY_SCENES`, which `scene.ts` imports to seed its registry. Keep new built-in registries static like this; reserve `register*` for hosts adding their own.

### [core/diagram] Tests That Parse Mermaid With Titles Need the jsdom Environment

- **Issue / Symptom**: Ported Ursula tests failed with `TypeError: DOMPurify.sanitize is not a function` inside Mermaid's `setDiagramTitle` (pie, quadrant, C4, gitGraph…), while flowchart tests passed.
- **Root Cause**: Mermaid sanitises titles and labels with DOMPurify, which needs a `window`. Ursula ran every test under jsdom from its vitest config; core's config uses the Node environment, and flowchart parsing happens to skip the sanitiser.
- **Solution / Workaround**: Start any test that calls Mermaid (`expectValidMermaid`, `mermaidDb`, `mermaidSummary`) with `// @vitest-environment jsdom`.

### [core/diagram] `pie` Is No Longer a Text-Only Example

- **Issue / Symptom**: Tests and examples that used `pie` to show "this family is kept as text" (validation refusals, `render_diagram` refusals, `<MermaidThumbnail fallback>`) started failing once the statement adapters were ported.
- **Root Cause**: Pie, mindmap, quadrant, C4, architecture, sequence, gitGraph, Gantt, timeline, journey, XY and radar are now `editable` and drawn as scenes.
- **Solution / Workaround**: Use `sankey-beta` (or block, packet, kanban, treemap) as the render-only example.

### [core/animation-editor] lottie-web Ignores `hd: true` on Shape Groups

- **Issue / Symptom**: A hidden node (`visible: false`, such as the demo's "arc" follow route) showed up in the Export Lottie preview, though the editor's own stage never draws it.
- **Root Cause**: `toLottie` wrote each node as a `gr` group and marked hidden ones `hd: true`. lottie-web 5.12 honours `hd` only on paths, fills and strokes; for a `gr` it builds and draws the children anyway.
- **Solution / Workaround**: Leave hidden nodes out of the file. Nothing in a Lottie file refers to another shape by id: follows and morphs are sampled into keyframes from the scene, so a hidden route or morph target is not needed in the output. To hide a shape you must keep, set its transform opacity to 0 instead of relying on `hd`.

### [core/agent] A Tool Missing From the Agent-Skills Test Because It Only Registers in a Browser

- **Issue / Symptom**: `tests/agent-skills.test.ts` passed while `pixerate-chart` listed `import_chart_ooxml` only in prose; with the tool in a table row the test reported it as stale.
- **Root Cause**: Some providers add tools only when a global is present (`createChartToolProvider` registers `import_chart_ooxml` only when a `DOMParser` exists). Vitest runs core in Node, so the tool list the test builds lacked it. The per-skill tests are also generated by `describe.each` at collection time, before any `beforeAll`, so a DOM set up in `beforeAll` is too late.
- **Solution / Workaround**: The test sets up jsdom (`document`, `window`, `Node`, `DOMParser`) at module level, so it sees the tool list a browser host gets. If a new tool depends on another browser global, provide that global there too, and give the tool a table row like any other.

### [core/image-editor] PSD Blend Keys and Other 4-Character Codes Can End in Spaces

- **Issue / Symptom**: An exported PSD with a Multiply layer could not be reopened: "Unexpected end of data reading a 32768-byte section". Every byte after the blend mode was shifted by one.
- **Root Cause**: Photoshop's keys are always 4 bytes, and several end in a space (`mul `, `div `, `hue `, `sat `, `lum `, and descriptor keys like `Rd  `, `Bl  `). The map had `mul` without the space, so the record was 1 byte short.
- **Solution / Workaround**: Keep the spaces in every key table. `writeLayerRecord` now refuses a blend key that is not 4 characters, so a typo fails at export with the key named.

### [core/image-editor] Photoshop's Merged Image Is Matted Over White

- **Issue / Symptom**: Partly transparent pixels of a PSD's merged image read lighter than the layers composite to (a red layer at 80 % read as `255, 51, 51, 204`, not `255, 0, 0, 204`), and our exported merged image looked darker in viewers that use it.
- **Root Cause**: Photoshop stores the merged image's colour blended over white where it is transparent (`c × a + 255 × (1 − a)`). The PSD spec does not say so.
- **Solution / Workaround**: `matteWhite` before writing the merged image, `unmatteWhite` after reading one with alpha (`psd/pixels.ts`). Without a merged alpha channel the file is simply flattened over white; compare against our composite flattened the same way.

### [react] jsdom Cannot Build a Blob From Node's Typed Arrays

- **Issue / Symptom**: "Cannot read properties of undefined (reading '_buffer')" when the LayersPanel's Export PSD ran in a jsdom test.
- **Root Cause**: Vitest's jsdom environment gives `Blob` from jsdom but `Uint8Array` from Node, and jsdom's Blob only accepts its own realm's buffers. `URL.createObjectURL` exists (it is Node's), so `downloadPsd` took the browser branch.
- **Solution / Workaround**: In tests, set `URL.createObjectURL` to `undefined` around the click so `downloadPsd` skips the download and only returns the warnings, then restore it. Browsers are unaffected.

### [svelte/tests] Vitest 5 Makes `globalThis.document` Read-Only

- **Issue / Symptom**: After the vitest 4 → 5 upgrade, Svelte tests that build their own JSDOM fail before running: `TypeError: Cannot set property document of [object Window] which has only a getter`.
- **Root Cause**: Vitest 5's test environment defines `document` and `window` on the global as getter-only properties, so `globalThis.document = …` throws in strict mode.
- **Solution / Workaround**: Use `vi.stubGlobal("document", dom.window.document)` and `vi.stubGlobal("window", dom.window)` (they redefine the property) instead of assigning. This also works on vitest 4.

### [core/video-editor] A Blend Inside a Compound Clip Must Use the Backdrop's Alpha in ffmpeg

- **Issue / Symptom**: Built the obvious way, a `multiply` (or any non-normal) clip inside a nested sequence comes out black in the export wherever nothing else in the sequence is beneath it, while the preview shows the clip's own colour there.
- **Root Cause**: A sequence is built as a sub-graph on a transparent frame (`color=black@0,format=yuva420p`). ffmpeg's `blend` filter mixes the colour planes with no regard for alpha, so over a clear backdrop it blends with black. The canvas and CSS follow the compositing spec: the blended colour is `(1 − αb) × layer + αb × B(backdrop, layer)`, so where the backdrop is clear the layer shows unblended.
- **Solution / Workaround**: Inside a sequence (`scope.within.length > 0` in `buildFfmpeg`), the blend result gets the backdrop's alpha (`alphaextract` + `alphamerge`) and is overlaid on an opaque copy of the layer before the layer's own alpha is applied. At the top level the backdrop is opaque, so the graph is unchanged there. `overlay` itself needs no help: on a main input with alpha it un-premultiplies, so laying layers on a transparent base gives straight-alpha "over", the same as the canvas.

### [core/video-editor] SVG Groups for Compound Clips Need `isolation: isolate`

- **Issue / Symptom**: Without it, a screened clip inside a compound clip lightens the picture beneath the compound in SVG frames, not just the compound's own layers.
- **Root Cause**: `mix-blend-mode` blends with everything behind it up to the nearest isolated group. A plain `<g>` is not isolated unless something on it (opacity < 1, a filter, a blend mode) creates a stacking context, so a compound at full opacity with no grade let its children blend through.
- **Solution / Workaround**: `videoFrameToSvg` always puts `isolation:isolate` on a compound's `<g>`. The canvas does the same by drawing the compound's layers on their own scratch canvas.

### [core/video-editor] One Scratch Canvas Is Not Enough Once Groups Nest

- **Issue / Symptom**: With one shared offscreen canvas, a LUT layer inside a compound (or a compound inside a compound) would clear the very canvas its parent compound is being drawn on.
- **Root Cause**: `drawVideoFrame` needs an offscreen canvas for each compound level being drawn and one for a LUT layer at that level, all at the same time.
- **Solution / Workaround**: `VideoDrawOptions.scratch(width, height, slot)` takes a slot: `2 × depth` for a compound's layers and `2 × depth + 1` for a LUT layer at that depth. Return one canvas per slot (`VideoPreviewEngine` keeps a map). A host scratch that ignores the slot still works for LUTs on projects without compounds.

### [core/video-editor] Layers and Sounds Inside Compounds Are Keyed by Clip Path

- **Issue / Symptom**: Keyed by the inner clip's own id, two compound clips playing the same sequence at once would fight over one `<video>` element in the preview (seeking it back and forth every frame).
- **Root Cause**: The preview keeps one media element per `layer.clip` / `audio.clip`. A sequence's clip ids are unique, but the same sequence can play in two places at once.
- **Solution / Workaround**: `videoFrameAt` names nested layers and sounds by the path of clip ids from the project's own track (`comp/inner`, `comp/mid/shot`). Use `videoFrameLeafLayers` to walk a frame's pictures with compounds opened up (the preview and `videoFrameRequestsAt` do).

### [core/paint] Pigment Mixing: Newton Stalls on Dark Saturated Colours, and Pure Primaries Tint Slowly

- **Issue / Symptom**: (1) Building the pigment spectrum table, a few lattice nodes (very dark pure blues and reds) came back with the wrong colour, up to 22 levels off, and some greys turned black after a "fix". (2) Pure sRGB red mixed 1:1 with white gives a coral `#ff3f37`, not a pastel pink, and a 0.1 % touch of yellow visibly shifts pure blue.
- **Root Cause**: (1) The sigmoid-polynomial fit (`R = ½ + z/2√(1+z²)`, z quadratic in λ) needs very large coefficients near the gamut edge. Warm-starting from a saturated neighbour, or from a flat grey, leaves damped Newton where the gradient vanishes. A "dimming" continuation that started at full brightness broke greys, because a grey's coefficients go to ±∞ at white. (2) Reproducing a pure sRGB primary exactly needs reflectance troughs near 0.004. Their K/S is above 100, so they dominate any mix. K/S also has a square-root slope where a band reflects fully, so a little of a paint that absorbs that band moves the mix fast.
- **Solution / Workaround**: (1) `fitNode` tries the neighbour start, then a flat-grey start, then a dimming continuation from half brightness. It keeps whichever fits closest. A few very dark reds and purples still miss by up to 3 levels, and the round-trip test bound is 3.5/255. (2) This is how Kubelka-Munk behaves with ideal colorants, so it is not a bug. Real paint colours (`#e32636`, not `#ff0000`) tint more gently. Give white a higher `strength` for faster tints. Don't "fix" it by raising the reflectance floor: that breaks the round trip of saturated colours. Don't add an RGB residual either: that is the design Mixbox uses, and we stay clear of it.

### [core/raster] The Pigment Blend Mode Is Not a `B(Cb, Cs)` Function

- **Issue / Symptom**: Adding `pigment` like the other modes (a `blendChannel` / `blendRgb` case) gives the wrong result at any opacity below 100 %: blue over yellow at 50 % comes out grey-ish, not green, and it changes with the backdrop alpha in odd ways.
- **Root Cause**: Every other mode computes `B(Cb, Cs)` and then mixes it with the backdrop linearly, `(1 − α)·Cb + α·B`. Paint mixing is the non-linear part itself: the interpolation has to happen in K/S space, so no choice of `B` gives it. `isSeparableBlendMode` must also say false, or the compositor would use its per-channel LUT.
- **Solution / Workaround**: `blendPixel`, `blendTile` (compositor), `blendImageData`, the brush and adjustment layers special-case `pigment`: `Co = lerpPigment(Cb, Cs, αs / αo)` with the usual `αo = αs + αb(1 − αs)` (over an opaque backdrop the share is just `αs`; over a clear one it is the source). `blendRgb('pigment')` returns `Cs` and must not be used for it. The 8-bit paths go through `mixPigment8`, which caches K/S per packed RGB (cleared at 16 384 colours); a 1024² layer over random noise costs about 0.2–0.75 s against 15 ms for Normal, so keep the dirty rectangles tight. PSD has no such mode: `toPsd` warns and `exportPsd` writes `norm` (`BLEND_TO_PSD` is `Partial`).

### [core/raster] A Running-Sum Blur Is Not Exactly Zero After It Passes a Shape

- **Issue / Symptom**: A drop shadow with Noise speckled whole rows of the canvas far from the shape, and a tiled render differed from a whole-image render by up to 53 levels.
- **Root Cause**: The effect blur is two box passes as running sums (`inner += next - leaving`). After the window leaves a shape the sum is about 1e-16, not 0. Noise adds speckle to any coverage above 0, so it lit up that residue. The residue runs to the end of the row, so how far it reaches depends on where the map's region ends.
- **Solution / Workaround**: `tentLine` (`raster/effects/render.ts`) flushes values below `BLUR_EPS` (1e-7) to 0, and `noise` skips coverage at or below it. Keep both if you change the blur. Effects with noise also count as non-local in `effectsAreLocal`. The running sums are now also exact (inputs rounded to multiples of 2⁻³², `BLUR_FIX`), so a blurred value no longer depends on where its line starts; see "Patched Effect Maps Must Equal a Full Build".

### [core/raster] Chiselled Bevels Streak When Distances Go to Pixel Centres

- **Issue / Symptom**: Chisel Hard and Soft bevels and embosses on round shapes showed radial streaks, worst on the outside half of an emboss.
- **Root Cause**: The exact distance transform measures to the nearest covered pixel's centre. Its gradient jumps at the Voronoi cell borders of those centres, and the chisel lights the height map by its gradient, so every border shows as a streak. Placing the edge by coverage (`d - (a - 0.5)`) moves each cell but keeps the borders.
- **Solution / Workaround**: `edgeDistances` measures to the straight edge through the nearest edge pixel: its normal is the coverage gradient (Sobel) there, and its position is the pixel's coverage. Smooth bevels blur the shape and do not need this. Photocraft solves it with a fuller sharp-edge refinement that was not ported.

### [core/raster] Layer Effects Read Pixels Beyond the Tile, So Tile Signatures and Dirty Rects Must Grow

- **Issue / Symptom**: A shadow cast into a neighbouring tile did not update after a stroke near the tile edge, and a tile with no layer pixels never showed the shadow at all.
- **Root Cause**: The compositor caches a tile by the surface tiles it reads and recomposites only inside `dirty` rectangles. A layer with effects changes pixels up to its effects' reach (`effectsMargin`) away from its own pixels.
- **Solution / Workaround**: Effect maps are built once over the layer's region (its bounds grown by the margin) and cropped per tile, so tiles always match a whole-image render. `effectSig` reads the layer's tiles within the margin around the tile, or the whole region when an effect is laid out over the layer's bounds (aligned gradients, gradient strokes, linked patterns, noise). `compositeTiles` grows every dirty rectangle by the stack's largest margin. Do not put the region rect into a local stack's signature: the region grows as you paint elsewhere, and every tile would recomposite.

### [core/raster] Patched Effect Maps Must Equal a Full Build

- **Issue / Symptom**: Rebuilding a layer's effect maps over its whole region on every stroke update cost about 200 ms for a 2000 × 2000 layer with a drop shadow (about 700 ms with a stroke and a bevel as well). Rebuilding only a window around the change and pasting it in can differ from a full build in three ways: the window's edge acts as the shape's edge, the blur's running sums pick up different float rounding from a different start, and neighbouring tiles still recomposite in full.
- **Root Cause**: A local effect map pixel depends only on the shape within `effectsMargin`, so pixels near the window's edge are wrong. A running sum's float error depends on every value since the start of the line. That is usually far below a byte, but a contour LUT lookup right at an index boundary can flip one. A tile next to the change reads it within the margin, so its signature changes. It then had no part in the `dirty` rects and was recomposited whole.
- **Solution / Workaround**: `patchEffectMaps` rebuilds the map pixels within the margin of each change (plus any part of the region that is new) from a window grown by the margin again (twice the margin around the change), and pastes only the inner part. `tentLine` sums fixed-point integers (`BLUR_FIX`), so the sums are exact wherever a line starts. The compositor finds the change from the per-tile shape signatures it keeps with the maps, narrowed to the call's `dirty` rects when the maps are from the previous call and the layer is a plain pixel layer (filters and feathered or parametric masks spread a change beyond `dirty`). It falls back to a full build for non-local effects, reaches past `MAX_EFFECT_REACH`, or windows covering half the region. A tile that has no part in the grown `dirty` rects keeps its pixels when its entry is from the previous call and every step whose signature changed is a pixel layer with local effects (`changedOnlyNearby`). Without that last check, tiles that a far change does alter (an aligned gradient over the layer's bounds, a spatial filter, a feathered mask) would go stale. Distance maps far from the shape can still hold different values (a window sees no site beyond itself), but they are past every effect's reach, so the painted result is the same. Test any new effect with the incremental painting test in `raster-effects.test.ts`.

### [core/raster] The Raster Isolation Test Rejects the Word "document" in Strings

- **Issue / Symptom**: `raster-module.test.ts` failed on `effects/model.ts` with "expected true to be false", and no import was wrong.
- **Root Cause**: The test strips comments, then looks for `document`, `window` and canvas globals anywhere in the source, string literals included. An error message saying "a document pattern" matched.
- **Solution / Workaround**: Word user-facing strings in `src/raster` without those words, or say "file" instead. Comments are fine.

### [core/paint] Mixer Brush: Strokes Paint Into Live Tiles, and Full Flow Drifts to the Loaded Colour

- **Issue / Symptom**: (1) A Mixer Brush stroke built on the brush's `CoverageMap` never smeared: every dab picked up the pre-stroke pixels, so a wet brush could not drag colour along. Painting into live tile buffers in place then left the canvas showing the old pixels mid-stroke. (2) With `flow` 1, a blue brush dragged through yellow in pigment mode came out teal, not green, and RGB mode looked almost the same as a plain brush.
- **Root Cause**: (1) The brush composites the stroke's coverage once over the pre-stroke pixels, which is right for a brush (dabs never exceed the opacity) and wrong for a mixer, whose dabs must read what earlier dabs laid down. The raster compositor's cache signatures compare `Tile` objects by identity, so mutating `tile.data` in place is invisible to it. (2) At full flow each dab covers what is under it, so the next dab's pickup mostly sees the brush's own paint and the mix settles towards the reservoir colour.
- **Solution / Workaround**: (1) `MixerStroke` paints dab by dab through a `MixerTarget` (`readTile` / `writeTile`). `PaintStrokeSession` copies a base tile on first write and, at each update, wraps every tile written since the last update in a new `Tile` object before handing the surface to `_strokeUpdate`. Never mutate a tile that came from a committed surface or the shared uniform-tile cache. (2) This is the model, not a bug: use a flow around 0.3–0.6 for blending (the skill says so). The pigment test uses flow 0.5 and checks the hue lands in the greens.

### [core/image-editor] Compare PSD Effects by What They Render, Not by Bytes or Ids

- **Issue / Symptom**: An effects block opened from a PSD and saved again unchanged was regenerated, which dropped descriptor keys we do not model. Or an edited effect was written back as the stale original.
- **Root Cause**: Export decides between the original block and a regenerated one by comparing the effects. Parsing gives every effect a fresh id. JSON round trips drop `undefined` fields. Object key order depends on who built the object.
- **Solution / Workaround**: `exportPsd` re-parses the stored block and compares `effectsFingerprint` of both sides. The fingerprint ignores ids and `psd`, sorts keys and skips `undefined`. Anything else that can differ without changing the render must be normalised the same way on both sides. Photoshop's `lmfx` (several instances per kind) wins over `lfx2` on read. We always write `lfx2` (`lfxs` on groups) with the `…Multi` keys, and pad odd-length blocks inside their length.

### [demo/image-editor] The Demo Shows a Crop by Default, So Edge Effects Look Missing

- **Issue / Symptom**: In the demo's Image tab, an inner glow or inner stroke on the Background showed on the top and left edges only. The new effects section was also missing until the packages were rebuilt.
- **Root Cause**: The sample photo opens with a freeform crop over part of the image, so the right and bottom edges in view are the crop's, not the layer's, and effects are drawn at the layer's edges. Separately, the demo imports `@pixerate/editor-react` and `@pixerate/editor` from their `dist`, so a running dev server shows the last build.
- **Solution / Workaround**: Clear the crop (Transform & Crop › Clear Crop) before judging effects at the image edges. Run `pnpm --filter @pixerate/editor --filter @pixerate/editor-react build` and reload after changing the packages.

### [core/raster] Free Transform Previews Are Bound by Writing Pixels, Not by Sampling

- **Issue / Symptom**: Dragging a Free Transform handle on a 4000 × 3000 layer took 200–700 ms per update even with one sample per 4 × 4 block, so the preview lagged far behind the pointer.
- **Root Cause**: Each update read the full-resolution source into float windows for every destination tile, and then copied each block sample into the output with small `TypedArray.fill` calls (about three million per update). Sampling itself was a small part of the cost.
- **Solution / Workaround**: A `FreeTransformSession` keeps a box-reduced copy of each moving surface per preview factor (`reduceSurface`) and transforms that through the map composed with the scale, so a preview at 25 % reads a sixteenth of the pixels. `transformSurface` with `step` samples one block row first, then writes packed 32-bit pixels down the block rows. The mesh warp rasterizes only each block's first pixel when previewing. Commit always resamples the full source at full quality. Measure with `RASTER_TRANSFORM_BENCH=1` (`tests/raster-transform.bench.test.ts`).

### [core/raster] The Raster Module May Import Only Itself and `src/geom`

- **Issue / Symptom**: `raster-module.test.ts` rejected `raster/transform.ts` for importing the homography maths.
- **Root Cause**: The isolation test allowed only relative imports inside `src/raster`. The projective maps and warp meshes live in `src/geom`, shared by the vector editor, the image editor and the raster resampler.
- **Solution / Workaround**: The test also accepts imports that resolve into `src/geom`, and checks that `src/geom` imports nothing but itself. Keep `src/geom` free of DOM and editor imports. The vector modules re-export the moved functions under their old `vector…` names, so their API is unchanged.

### [core/image-editor] Layer Pixels and Masks Are in Layer Space, So a Transform Must Be Conjugated by the Offset

- **Issue / Symptom**: A layer moved with `offset_layer` jumped when it was transformed, and an unlinked mask moved with its layer.
- **Root Cause**: A pixel layer's surface and its mask are stored in layer space (document = layer + `offset`). The transform's frame and corners are in document pixels.
- **Solution / Workaround**: `FreeTransformSession` resamples each part through `T(offset) · H · T(−offset)` and keeps the offset. `offsetLayer` translates an unlinked mask (`linked: false`) by the opposite move, so it stays where it is in the document. Tests reading pixels must subtract the layer's offset (`pixelAt` in `tests/image-free-transform.test.ts`).

### [core/raster] A Mesh Warp Has No Anti-Aliased Fringe at the Source Edge

- **Issue / Symptom**: The same affine map through `warpSurface` and `transformSurface` differed by up to 255 at the result's border.
- **Root Cause**: `transformSurface` samples up to a pixel past the source rectangle, so the edge pixels are partly covered. `warpSurface` (ported from photocraft) rasterizes triangles of the forward-mapped grid and only fills pixels whose centres fall inside them.
- **Solution / Workaround**: Expected: compare the two only where both are opaque. A warp's edge is a little harder than a transform's.

### [core/image-editor] PSD Mask Flag Bit 0 Means "Unlinked"

- **Issue / Symptom**: Photoshop's mask link (the chain icon) had no field in our model, so an unlinked mask came back linked after a round trip.
- **Root Cause**: The PSD layer-mask flags document bit 0 as "position relative to layer". Photoshop sets it when the mask is unlinked; photocraft reads `linked = flags & 1 == 0`.
- **Solution / Workaround**: `RasterMask.linked === false` maps to `MASK_FLAG_UNLINKED` on import and export, and to `linked: false` in saved documents. Missing means linked.

### [core/image-editor] Free Transform Handles Overlap on a Small Frame, So Hit-Test by Distance

- **Issue / Symptom**: Dragging a corner of a small layer moved the reference point instead of scaling.
- **Root Cause**: The hit tolerance is a fixed number of screen pixels (6), converted to document pixels by the zoom. On a frame a few dozen screen pixels across, the centre reference point and every handle are all within reach, and the reference point was tested first.
- **Solution / Workaround**: `FreeTransformTool.hit` returns the nearest handle within the tolerance, and the reference point only when it is strictly nearer. Ctrl/Cmd+T is reserved by some browsers (a new tab), so the editors also show Free Transform buttons in the Layers, Paint and Select tabs.

### [core/image-editor] The Warp Mesh Lives in the Frame's Own Space, Before the Corner Map

- **Issue / Symptom**: After a perspective, the warp mesh drawn on screen sat a little off the warped pixels near the far edge, and dragging a mesh point after a rotation moved it in the wrong direction.
- **Root Cause**: A Free Transform is a warp of the untransformed frame followed by the corner map (`transformMap`), as in photocraft. The mesh's control points are in the frame's space. Mapping control points through a projective map does not give the Bézier patch of the mapped surface, only a close one, and pointer moves are in document space.
- **Solution / Workaround**: `FreeTransformTool` maps pointer positions into the frame's space through the inverse corner map before `dragWarpMeshPoint` / `pullWarpMesh`, and draws the control points through the corner map. The drawing is exact for affine corners and approximate for perspective, but the resampling always uses the exact composition. Leaving Warp mode keeps the mesh, so a warp and a perspective commit together.

### [core/paint-editor] Procedural Paper Grain Only Tiles With Whole Lattice Periods and an Even Thread Count

- **Issue / Symptom**: Generated paper showed a visible seam every 256 px: fibre and streak patterns (charcoal paper, gesso) broke at the tile edge, and the canvas weave flipped from over to under across it.
- **Root Cause**: Value noise wraps only when every octave's lattice has a whole number of cells across the tile. Stretching the coordinates (`x / stretch`) to make fibres leaves a fractional period. The weave alternates by `(column + row) % 2`, which only lines up with the next tile when the number of threads across it is even.
- **Solution / Workaround**: `TileableNoise` takes separate cell counts per axis (`cellsX`, `cellsY`) instead of a stretch, and the canvas and linen patterns round the thread count to an even number. The paper test checks `at(x + 256, y) === at(x, y)` for every pattern; keep it when you add one.

### [core/paint-editor] A Mixer Brush Preset With a Low Load Runs Dry in a Few Dozen Dabs

- **Issue / Symptom**: The paint editor's Mixer Brush preset painted a short smear at the start of a stroke and then nothing.
- **Root Cause**: The shared Mixer Brush drains its reservoir by `MIXER_DRAIN × (1 − load)` per dab (photocraft's model). At `load` 0.5 that is 4 % a dab, so after 50 dabs (about 100 px of a 30 px brush at 0.08 spacing) 13 % is left.
- **Solution / Workaround**: The preset uses `load` 0.95 and spacing 0.1. Lower loads are right for a brush that should run out (oil paint loading), not for a general mixer. Blender and smudge have no reservoir (`loadsColor: false`), so load does not matter for them.

### [core/paint-editor] A Rotated or Mirrored View Must Turn the Pen's Azimuth and Twist Too

- **Issue / Symptom**: With the canvas view rotated, a tilted pencil shaded in a different direction on screen than with the view upright, and barrel-rotation brushes turned the wrong way when the view was mirrored.
- **Root Cause**: Pointer Events report tilt, azimuth and twist in screen space. The view maps positions to document space, but nothing mapped the pen's orientation.
- **Solution / Workaround**: `pointerToPenPoint(event, x, y, view)` converts tilt to altitude / azimuth and then `viewPenToDocument` subtracts the view rotation (and reflects for mirroring) from the azimuth and twist. Bindings must pass the view; recorded strokes store document-space values, so replays do not depend on the view.

### [core/paint-editor] View-Only Layers Must Stay Out of Exports and the Export Compositor

- **Issue / Symptom**: A tracing image could end up in an exported PNG or PSD, or a preview after a stroke could show stale tracing pixels.
- **Root Cause**: The tracing image is drawn by the shared compositor as a content layer (`ImageNode`) between the paper and the paint. Exports, `pickColor` and `render_preview` use the same stack builder, and a compositor caches tiles by each step's signature, so a stack with the underlay and one without must not share a compositor (see "Dirty Rectangles Are Only Safe on a Compositor That Sees One Stack").
- **Solution / Workaround**: `renderLayers(options, view)` adds `underlayLayers()` only for the viewport (`compositeTiles`, on `viewCompositor`); exports and picks use `exportCompositor` without it. The tracing node's `version` changes whenever its image, placement or the canvas size changes, so its tiles recomposite; its opacity is a normal layer property. Tests check that `compositePixels` never shows the tracing image.

### [core/paint-editor] Perspective Snapping Must Be Applied Before a Stroke Is Recorded

- **Issue / Symptom**: Replaying a stroke painted with perspective snapping wobbled off the guide line, or snapped to a different vanishing point after the guide moved.
- **Root Cause**: A replay feeds the recorded points back in. If the raw pointer samples were recorded, the replay either had to re-snap (to whatever the guide is now) or painted the unsnapped path.
- **Solution / Workaround**: The snapper runs as the session's `inputFilter`, before the samples are painted and pushed to `session.points`, so recordings hold the snapped path and replays never snap. Symmetry is the opposite: the stroke records its raw path plus the copies as affine maps (`copies`), so a varied replay can conjugate them and stay symmetric about the moved centre.

### [react|svelte/paint-editor] Paper Controls Are Undo Steps, So Commit on Release, Not on Every Input

- **Issue / Symptom**: Dragging the paper's grain-depth slider, or the colour picker, in the React paint editor left dozens of "Paper" entries in the undo history.
- **Root Cause**: `setPaper` is one undo step per call. React's `onChange` on a range or colour input fires on every `input` event, not on release. Brush settings are editor state, so updating them live is fine, but paper settings are document state.
- **Solution / Workaround**: `PaintSlider` takes `onCommit`, which runs on the native `change` event (attached with `addEventListener` in React, `onchange` in Svelte), and keeps a local draft value while dragging. `CommitColorInput` does the same for the React colour input. Tests dispatch `input` then `change` and check for exactly one undo step.

### [core/image-editor] A Smart Object's Pixels Are a Cache the Compositor Draws Like a Pixel Layer

- **Issue / Symptom**: A smart object's `surface` looks like a pixel layer's, but painting into it, or changing `placement` / `smartFilters` / `contents` with a plain object spread, leaves the layer showing stale pixels (and the next transform throws the paint away).
- **Root Cause**: `SmartObjectLayer.surface` is the rendered result of contents → placement → smart filters, kept on the layer so the compositor, effects, thumbnails, history and export see it like any pixel layer (the raster engine treats it as one through the `isPixelLike` profile hook). Nothing re-renders it implicitly.
- **Solution / Workaround**: Change smart objects only through the operations in `layers/smart.ts` (`setSmartPlacement`, `replaceContents`, the smart filter functions, `rerender`), which render again. Painting targets `pixels` are refused on smart objects; the filter mask is painted through channel `filter-mask` and re-renders on every update. The render is clipped to the canvas grown by `SMART_RENDER_MARGIN` (512 px), so scaling a smart object up can never hit the resampler's size limit, and smart filters run over the canvas only, like pixel-layer filters (which is what makes a converted pixel layer render byte for byte the same).

### [core/image-editor] Free Transform on a Smart Object Edits Its Placement, in Contents Pixels

- **Issue / Symptom**: Composing a new transform onto a smart object's existing one works for corners, but not for a warp: a Bézier warp of the document after a rotation is not a Bézier warp of the contents, so the placement could not hold it, and chained transforms would have to resample.
- **Root Cause**: A placement is a warp in the contents' own pixels followed by a corner map (the same shape as `FreeTransformGeometry`). A warp drawn over a rotated document box would be a degree-6 surface in contents space.
- **Solution / Workaround**: For a smart object, `FreeTransformSession` starts from the placement itself: `box` is the contents' rectangle (contents pixels), `startGeometry` / `geometry` hold the current corners and warp, and commit writes them back and re-renders from the contents. Relative helpers (`transformLayer`, `flipLayer`, `rotateLayer90`, the options bar) apply their change to `startGeometry`'s corners, not to `identityTransform(box)`. `get_transform_frame` reports `smartObject: true` with the contents' rectangle as the frame, and warp meshes for smart objects are in contents pixels. A linked mask follows a warp-free change by the change's homography; with a warp involved it stays (the result's `moved` says so).

### [core/image-editor] A Placed Layer's Quad Maps the Warp's Box, Not Always the Source Rectangle

- **Issue / Symptom**: A warped smart object from Photoshop came in stretched, and one we wrote back moved when Photoshop re-rendered it.
- **Root Cause**: `SoLd`'s `Trnf` / `nonAffineTransform` quad is where a *frame* lands: the bounding box of a single-patch custom warp's 16 control points (which may spill past the source), else the source rectangle (always the source rectangle for a non-parallelogram quad, as photocraft reads it). `Sz  ` is in document units, which differ from the embedded file's pixels when resolutions differ, and preset warps have their own `bounds`.
- **Solution / Workaround**: `placementFromPlaced` builds the frame first, maps the contents' rectangle through `rectToQuad(frame, quad)` to get our corners, and refits a warp whose bounds are not the contents' rectangle (`fitWarpMesh`, exact for an affine reparameterisation); the importer scales a warp from `Sz` units to the contents' pixels. `soldBytes` / `plldBytes` invert it (`quadFromCorners`). A mesh of several patches cannot be written (`warpNone` plus a warning; the layer's pixels still show it), and Photoshop's newer Cylinder warp is not read.

### [core/image-editor] Photoshop Extends Smart Filter Masks With White

- **Issue / Symptom**: A smart filter mask made from a selection (black outside it) came back from a PSD revealing the filter everywhere outside the selected area.
- **Root Cause**: The filter mask lives in the `FEid` / `FXid` block as a rectangle and a plane; outside the rectangle Photoshop treats it as white (`filterMaskExtendWithWhite`). Writing only the painted bounds of a mask whose default is black loses the black.
- **Solution / Workaround**: `filterMaskItem` writes a mask whose default is not white over the whole canvas (plus anything painted outside it); reading uses default 255. The filter mask's enabled / linked flags are in `filterFX` (`filterMaskEnable`, `filterMaskLinked`), not in the block.

### [core/paint-editor] Live Agent Strokes Run Slower Than Their Point Times With Big Brushes

- **Issue / Symptom**: In the demo, the landscape script's 672 ms soft-pastel stroke (90 px tip on a 1200 × 800 canvas) took about 4 s to paint through `PaintDirector`.
- **Root Cause**: The director pushes the points due in each 16 ms frame and then waits a frame. Each push lays the dabs and re-composites the touched tiles, and React then uploads those tiles. With a big tip this takes longer than a frame, so the wall-clock time adds up beyond the schedule.
- **Solution / Workaround**: Accepted. The result is the same as `paintStroke` with the same seed (tested), and only the pacing differs. Hosts that want strokes to land faster can pass a higher `speed` or a lower `maxStrokeMs`, or leave out the director so strokes apply at once.

### [core/raster] Painterly Blend Modes Reach Every `BLEND_MODES` Consumer, and Tint Must Replace Hue, Not Average It

- **Issue / Symptom**: (1) After adding `watercolor`, `tint`, `highlight` and `shadow` to `BLEND_MODES`, they showed up in the image editor's layer, effect and smart-filter menus and agent enums, and its PSD export silently wrote them as Normal. (2) The first `tint` turned yellow under a blue tint into grey instead of light blue. (3) `watercolor` with a white source changed the backdrop by a level or two.
- **Root Cause**: (1) Those menus and enums are built from `BLEND_MODES` and filter out only `pigment`; `BLEND_TO_PSD` is `Partial`, so any mode without a PSD key falls back to `norm`. (2) Interpolating Oklab `a, b` from the backdrop's towards the source's passes through the neutral axis when the hues are opposite. (3) The spectral uplift round-trips a colour only to within about 3.5/255, so `R_b·R_white` is not exactly `R_b`.
- **Solution / Workaround**: (1) The painterly modes are real `B(Cb, Cs)` functions (`blendRgb` / `blendChannel`), so they work wherever a mode is accepted (compositor, adjustment layers, effects, brushes, canvas fallback); there is nothing to filter. Writers of formats without them must call `standardBlendMode(mode)` (the paint editor's `exportPsd` does, with a warning); the image editor's `toPsd` does not yet. (2) Tint replaces the hue: `ab = ab_s·√(4·L_b·(1 − L_b))`, then cuts chroma (never lightness) into the gamut. (3) `watercolor` short-circuits a white source to the backdrop and a white backdrop to the source, so "white is clear" is exact; other colours are quantised to 8 bits and their spectra cached like `mixPigment8`'s.

### [core/paint] Repeated Small Pigment Mixes Drift Towards the Lighter Paint

- **Issue / Symptom**: Working blue and yellow together 1:1 on the mixing pad with the palette knife came out as a light olive (`#b2b52f`), far from the Kubelka-Munk mix of equal parts (`#5f9746`). Black and white 1:1 gave a light grey instead of a near black.
- **Root Cause**: Two simplifications compound over hundreds of small mixes. (1) The Mixer Brush samples the footprint as an RGB average (`TileMedium.sample`), so a footprint across blue and yellow is already greyish before any pigment maths. (2) Pixels hold only RGB. A mixed colour's scattering is re-estimated from its luminance, not carried as the sum of its parts, so mixing mixtures is not linear in K and S. Dark mixtures are treated as weak, and the light paint wins over time.
- **Solution / Workaround**: Treat brush and knife smearing as the look of mixing, not as a measurement. `MixingPad.mix` (`mix_on_pad`) lays blobs, works them with the knife, and then paints a fully mixed core of `mixPigments` of the parts, so the colour it returns is the true mix. Agents that need a number use `mix_colors`. A carrier that keeps K and S per pixel (the wet layer) can fix the drift for wet media. Don't try to fix it by changing the Mixer Brush's sampling, because that changes every existing Mixer Brush stroke.

### [core/paint-editor] Dab-by-Dab Brushes Need the Opacity Ceiling Applied as Increments

- **Issue / Symptom**: A dab brush given a pick-up ratio or multi-colour (so it paints dab by dab instead of through one coverage buffer) built up to full opacity wherever its dabs overlapped, ignoring the brush opacity. It looked very different from the same brush with pick-up 0.
- **Root Cause**: The dry engine composites the stroke's accumulated coverage once, so overlapping dabs never pass `opacity`. Laying each dab's own coverage at `opacity` composites it again and again.
- **Solution / Workaround**: `PaintDabStroke` keeps a stroke `CoverageMap` for dab brushes. It lays only what each dab adds: `k = (c₁ − c₀)·o / (1 − c₀·o)`. Successive source-over composites with these `k` multiply out to the single composite at `c·o`, so a one-colour Normal stroke matches the dry engine to within rounding (tested at ≤ 3 levels). Other blend modes are applied per increment, which is close to but not exactly the single composite. The Mixer Brush keeps photocraft's per-dab deposit with no ceiling.

### [core/paint] A Smudge Must Pick Up What Was Under It, Not What It Just Laid

- **Issue / Symptom**: Smudge strokes dragged paint across the whole canvas whatever `length` was set to.
- **Root Cause**: The finger's patch was refreshed from the pixels after the dab had covered them with the patch itself, so the patch kept picking up its own paint and never faded.
- **Solution / Workaround**: `SmudgeTip.dab` reads each pixel before writing it. It lays the patch over that pixel and refreshes the patch from that original pixel by `1 − length`. A short `length` now fades within a few dabs, and the test checks that reach grows with `length`.

### [core|react|svelte/paint-editor] Brush Thumbnails Redrew on Every State Change

- **Issue / Symptom**: Dragging any brush slider in the paint editor's brush panel was slow, and the new engine-section UI tests timed out (over 5 s) once the library had a blender.
- **Root Cause**: `getState()` built `brushes: [...BUILTIN_BRUSHES, ...userBrushes]` fresh for every snapshot. React's `useMemo` and Svelte's `$derived.by` both saw a new array, so every brush thumbnail was repainted after every change. In Svelte, a `$derived.by` that reads `snap.brushes` also reruns whenever the snapshot object changes, even if the array is the same.
- **Solution / Workaround**: The controller caches the library list (`library`) and drops the cache only when the user brushes change (save, remove, import), so `state.brushes` keeps its identity. Svelte reads it through its own `$derived(snap.brushes)` (and `$derived(snap.document.paper)`), which only fires when the value changes. A core test checks that the list stays the same object across `setBrush` and `setColor`.

### [core/image-editor] A Shape Layer's Pixels Are a Render of Its Paths

- **Issue / Symptom**: Changing a shape layer's `components`, `fill` or `stroke` with a plain object spread left it showing the old pixels; painting into its `surface` was thrown away by the next edit.
- **Root Cause**: `ShapeLayer.surface` is a cache rendered from the paths (document space, offset 0, clipped to the canvas grown by 512 px), so the compositor, effects, masks, thumbnails and PSD export treat it like a pixel layer (`isPixelLike`). Nothing re-renders it implicitly.
- **Solution / Workaround**: Change shapes through `updateShapeLayer`, `rerenderShape`, `offsetShape` or `transformShapeComponents` + `renderShape` (`layers/shape.ts`), which render again. Painting `pixels` on a shape is refused; `rasterize_layer` makes it a pixel layer. Moves and Free Transform map the paths, never the pixels.

### [core/image-editor] The Accumulation Rasterizer Over-Counts Where Overlapping Parts Share an Edge Pixel

- **Issue / Symptom**: A rotated rectangle's stroke, an arrow's bar under its head and pen strokes came out up to 47 levels too opaque along some edges compared with what the canvas drew.
- **Root Cause**: The signed-area (font-rs) rasterizer is exact only for paths that do not overlap themselves. Stroke outlines from `strokeOutlineRings` overlap at joins, and a line shape's bar and arrowhead are separate overlapping subpaths. Where two overlapping parts' edges both cross a pixel, their areas add before the fill rule clamps them. Cleaning the outline with `outlineStroke` or `polygonBoolean` fixes the geometry but takes seconds for a few hundred pen points.
- **Solution / Workaround**: `rasterizeCoverage` (exact area) is used only for single-contour fills. Strokes and multi-contour components go through `rasterizeCoverageSampled`: 16 sub-rows per pixel row with exact horizontal coverage of the spans the fill rule keeps, so overlaps count once (edges within 1/32 px vertically). Curved strokes of up to 64 commands still get a clean `outlineStroke`, because raw rings of a curve tighter than half the width turn inside out. `tests/image-shape-migration.test.ts` compares every annotation kind with a 16 × 16 point-sampled reference of the old canvas drawing.

### [core/image-editor] Migrated Annotations Keep Their Annotation So v1 / v2 Documents Write Back Byte for Byte

- **Issue / Symptom**: Rebuilding an annotation from a shape (for the `annotations` view or a v1 / v2 save) changed numbers (an ellipse's box `x − rx` back to `x` is not exact in floating point) and broke byte-identical round trips.
- **Root Cause**: Pen, rectangle, ellipse, line and arrow annotations now load as shape layers, but old documents and the `annotations` / `updateAnnotation` API still speak annotations.
- **Solution / Workaround**: A migrated `ShapeLayer` keeps the source `annotation` while it is still exactly that annotation (`legacyView` and `isLegacyShape` read it; its blend mode moves to the layer). `updateAnnotation` rebuilds the layer from the merged annotation (back to an annotation layer when a colour can't be read). Any shape edit, a duplicate or a transform drops the field, and the layer leaves the `annotations` view. Plain migrated layers at the top of the stack still draw through the renderer's crisp annotation overlay, as before. Text and image annotations stay annotation layers.

### [core/image-editor] Type Layers Draw Through a Shaper, Which Node and jsdom Do Not Have

- **Issue / Symptom**: `addTextLayer` threw "Type layers need a text shaper" in tests, and a text annotation loaded in Node showed nothing.
- **Root Cause**: Layout is ours, but fonts are not: metrics, advances and drawing come from a `TextShaper`. The default is `createCanvasTextShaper`, which needs a 2D canvas with `measureText` (jsdom's canvas has no context). A family is "missing" when it measures the same as both `monospace` and `serif`, so web fonts must be loaded before layout.
- **Solution / Workaround**: Pass `textShaper` (for tests, `createOutlineTextShaper` with a font object; `tests/helpers/box-font.ts` is a deterministic box font) or call `setTextShaper`. Without one, type layers keep their stored pixels (`rendering: 'stored'`, saved as a PNG asset in v3 JSON) and edits that would draw them are refused. Migrated text annotations are created undrawn there and draw on the first edit where a shaper exists; at the top of the stack they still draw through the annotation overlay as before.

### [core/image-editor] A Text Annotation's `top` Baseline Is the Em Box, Not the Font's Ascent

- **Issue / Symptom**: Migrated text annotations would sit a few pixels off if their first baseline were placed by the font's ascent.
- **Root Cause**: The old renderer drew with `textBaseline = 'top'`, which is the top of the em square. Fonts' ascent (`fontBoundingBoxAscent`) differs from the em box.
- **Solution / Workaround**: Migrated type layers use `frame: { kind: 'point', origin: 'top' }`: the first baseline is one ascent below the origin, and the Canvas 2D shaper's `metrics` report `emHeightAscent` (falling back to the font box). `tests/image-type-tools.test.ts` checks that the new drawing calls match the old ones. Canvas also turned every whitespace character into a space, so migration replaces line breaks with spaces.

### [core/image-editor] Photoshop's Shape Paths: Joined Subpaths, a Leading Subtract and Its Own Pixel Snapping

- **Issue / Symptom**: Custom shapes lost their holes, shapes whose first component subtracted came in as their complement, and some shapes' stored pixels sat half a pixel or a stroke's fringe away from what our renderer draws for the same path.
- **Root Cause**: In `vsms` / `vmsk` path records, operation -1 after a component's first subpath means "same component" (its subpaths are filled together, so opposite windings cut holes). A first component that subtracts starts from a full canvas. Photoshop also snaps 1 px strokes to the pixel grid ("Align Edges") and some files' stored pixels are offset by half a pixel from their paths.
- **Solution / Workaround**: `componentsFromVectorBlock` starts a component at every subpath whose operation is not -1, and turns a leading subtract into `inverted: true` with the later operations swapped for their duals (combine ↔ subtract). We draw shapes from their paths on import (across 546 shape layers of the public corpus the alpha matches Photoshop's within antialiasing for all but a few snapped strokes and offset icons) and write the vector blocks back byte for byte while `shapeSignature` says the shape is unchanged.

### [core/image-editor] EngineData Runs Cover One More Character Than the Text

- **Issue / Symptom**: Text read from a `TySh` lost its last character's style, or Photoshop refused a written file.
- **Root Cause**: EngineData's `Editor/Text` always ends with an extra `\r`, and the last paragraph run and the last style run each cover it; the descriptor's `Txt ` does not. Line breaks are `\r`. Box text keeps its own origin in `BoxBounds`, separate from the `TySh` transform.
- **Solution / Workaround**: Read the text from `Txt ` (else the engine text minus its last `\r`), fit runs to it with `fitRuns`, and write the engine text with the extra `\r` and both last runs one longer (`buildEngineData`). Box text folds `BoxBounds`' top-left into our transform so our box starts at (0, 0). EngineData sizes are text-space units, which are our pixels, so no resolution conversion is needed for type (unlike `vstk` widths in points).

### [react|svelte/image-editor] On-Canvas Text Editing Types Into a Hidden Textarea

- **Issue / Symptom**: Keys typed right after clicking the canvas with the Type tool were lost, and IME (composed) text never arrived when keys were read from `window`.
- **Root Cause**: The canvas cannot take text input. Focus has to move to an element that can, and that element only exists once the click has opened a `TextEditSession` (after the pointer is released). Composed text comes as `compositionend` / `input`, not as `keydown` keys.
- **Solution / Workaround**: Both editors render a 1 px transparent `<textarea data-testid="type-input">` while a session is open and focus it on the next tick after mouse-up. `keydown` goes to `TextEditSession.handleKey` (single characters, Backspace, Delete, Enter, arrows, Home / End, Cmd/Ctrl+A) unless `isComposing`; `compositionend` and `input` insert the composed or pasted text and clear the textarea. Cmd/Ctrl+Z / C / X / V are left to the browser. All edits of one session are one undo step (the first change records history, the rest pass `commitToHistory: false`). Automated tests type into the textarea; a browser driver that types immediately after the click can beat the focus.

### [core/image-editor] Browsers Decode Images to sRGB, So an Opened Image's Own Profile Is Not Kept

- **Issue / Symptom**: A Display P3 JPEG opened with `loadImage` showed as sRGB in `get_color_profile`, and assigning its embedded profile afterwards made it look oversaturated.
- **Root Cause**: An `<img>` drawn to a 2D canvas is colour-managed by the browser into the canvas's sRGB space, so the pixels the editor reads are already sRGB numbers. The file's profile no longer describes them.
- **Solution / Workaround**: Keep sRGB for images that came through the browser decoder (the default). Only PSDs (decoded by us) take their embedded profile as the document's. To keep a wide-gamut working space for a photo, `convert_to_profile` after opening (out-of-sRGB colours are already clipped), or decode the file yourself without colour conversion and `assignProfile(readJpegIcc(bytes))`.

### [core/cms] The Synthetic CMYK Profile Is Built on First Use

- **Issue / Symptom**: The first `set_proof_setup` or `convert_colors` with `coated-cmyk` took one to three seconds; later calls were instant.
- **Root Cause**: The profile is generated from a printing model (its B2A tables are a damped least-squares separation at every grid node) instead of shipping 230 KB of measured data, and `builtinProfile` caches the result.
- **Solution / Workaround**: Expected. Call `builtinProfile('coated-cmyk')` early (e.g. idle time) to warm it. Tests that touch it need a timeout of about a minute on slow CI machines.

### [core/vector] A Frame's Size Field Must Not Apply Each Keystroke

- **Issue / Symptom**: Typing a new width such as 400 into a frame's size field squashed children that stretch with the frame (`leftRight` / `topBottom`), and their margins came back wrong.
- **Root Cause**: Resizing a frame lays its children out again by their constraints. Applied on every keystroke, the frame went through widths 4, 40 and 400. At width 4 a stretched child's span became a sliver, and its margins could not be recovered from that.
- **Solution / Workaround**: Both frame panels apply x, y, width and height on Enter or blur (React: an uncontrolled input keyed by the value; Svelte: `onchange`), never per keystroke. Code that drives `setFrame` in steps should go straight to the final size, or start every step from the original document.

### [core/vector] Frames Draw, Hit and Bound Through Different Paths

- **Issue / Symptom**: An empty frame could not be selected, and children outside a clipping frame stayed clickable, while the frame itself drew correctly.
- **Root Cause**: Drawing goes through `expandVectorAppearance`, which turns a frame into a clip group (`vectorFrameDrawn`). Hit-testing and bounds instead start from the stored node, where a frame is just a group.
- **Solution / Workaround**: `vectorNodeBounds` and `hitTestVectorNode` handle frames first: the bounds are the rectangle (plus the children when it does not clip), and a hit is any point inside the rectangle. `vectorAppearanceShapes`, `expandVectorAppearance` and `vectorMaskRegionShapes` swap in the drawn clip group. Any new code that walks groups should check `isVectorFrame` before treating a frame as a plain group.

### [core/vector] Connector Anchors Are Overwritten After Every Edit

- **Issue / Symptom**: Moving a glued connector's anchors, or setting its subpaths through `updateNode`, appeared to do nothing.
- **Root Cause**: `rerouteVectorConnectors` runs in the controller's `refreshed`, after every edit (and after the constraint solve). It writes each glued connector's geometry again from its ends' sites. Only a free end keeps its stored point.
- **Solution / Workaround**: To reshape a connector, change its `route`, `radius` or `gap`, or unglue the end (`setConnector({ end: null })`); the end then stays where it is. The method is `addConnector`, not `connect`, because `connect()` is the controller's private history subscription.

### [core/vector] Tracking Acquisition Runs on a Timer, so Tests Need Fake Timers

- **Issue / Symptom**: In tests, resting the pointer on an anchor never acquired it for tracking. In a page, a point was acquired even though the pointer had stopped moving.
- **Root Cause**: Acquisition happens when the pointer has rested on a point for 400 ms (`TRACKING_DWELL_MS`). It cannot wait for the next pointer move, because a resting pointer sends none, so the controller sets a `setTimeout`. The timer is cleared when the candidate changes, when tools switch, on `clearTracking` and on `destroy`.
- **Solution / Workaround**: Tests use `vi.useFakeTimers()` and `vi.advanceTimersByTime(TRACKING_DWELL_MS + 10)`, or call `acquireTrackingPoint` directly. Turn tracking off with `setSnap({ tracking: false })` where it is not wanted.

### [core/vector] Typed Entry Takes Digit Keys While the Pen Draws

- **Issue / Symptom**: Digit shortcuts did nothing while a pen path was in progress.
- **Root Cause**: Like CAD direct distance entry, `keyDown` turns `0`–`9`, `.`, `-` and `@` into a typed entry while the pen has a path open (`state.typedEntry`). Enter places the point, Backspace edits the entry and Escape drops it.
- **Solution / Workaround**: Bind digit shortcuts with a modifier, or finish the path first (Escape, or switch tools). Hosts that show the entry should read `overlay.typedEntry`.

### [core/raster] Deep Samples Ride Next to the 8-bit Tile, and 8-bit Writers Drop Them

- **Issue / Symptom**: In a 16-bit document, a brush stroke (or a filter, transform or merge) left the tiles it touched at 8-bit precision, while the rest of the layer kept its 16-bit samples.
- **Root Cause**: High bit depth is additive: a `Tile` may carry `deep` samples (`Uint16Array`, or `Float32Array` in linear light) and its `data` is always their 8-bit rendering. Every existing 8-bit path (compositor, viewport, brushes, the paint editor) reads and writes `data` only, and a tile it rewrites is built by `finishTile` without `deep`.
- **Solution / Workaround**: Read at depth with `tileSamples16` / `tileSamples32` / `readDeepRegion` (a tile without `deep` converts exactly as a bit-depth change would), and write with `deepTile` / `writeDeepRegion`, which also keep `data` in step. Never build a tile by spreading another one and replacing `data`: its old `deep` would no longer match. Making each editing path depth-aware is follow-up work; until then the skill tells agents to grade and export deep files rather than repaint them.

### [core/image-editor] 16- and 32-bit PSDs Keep Their Layers in an Lr16 / Lr32 Block, and 32-bit Is Linear Light

- **Issue / Symptom**: A 16-bit PSD written with the layer records in the usual layer-info section read back fine here but is not how Photoshop writes such files; and 32-bit values read as sRGB looked washed out.
- **Root Cause**: Photoshop stores the layer info of 16- and 32-bit files in a global `Lr16` / `Lr32` tagged block and leaves the layer-info section empty. Its 32-bit mode is scene-referred linear light, so float samples can exceed 1.
- **Solution / Workaround**: `writePsd` puts the layer info into `Lr16` / `Lr32` when the header depth is 16 or 32 (`readPsd` reads both places). 32-bit channels are ZIP with prediction (byte planes, then deltas); 16-bit channels are RLE. Our `Float32Array` samples are linear too; converting to 16 or 8 bits encodes to sRGB and clips colour above 1.

### [core/image-editor] Levels Quantise to 256 Levels, Which Bands a 16-bit Image

- **Issue / Symptom**: A strong Levels adjustment over a smooth 16-bit gradient came out with about thirty flat bands in the 16-bit composite.
- **Root Cause**: To match Photoshop at 8 bits, the Levels table rounds its input to whole levels and the stretch to whole steps (`LEVELS_QUANTUM`). Fed 16-bit values, that rounding throws the extra precision away. A default parameter hid a second bug: passing `undefined` to turn the rounding off brings the default back.
- **Solution / Workaround**: `compileAdjustmentLayer(layer, { deep: true })` builds Levels without the quantum (`toneLuts(layer, null)`), and `applyAdjustmentLayersFloat` (the deep compositor's filter run) uses those compiled ops through their own cache key. The 8-bit path is unchanged. Use `null`, not `undefined`, to switch off a parameter that has a default.

### [core/raster] The Deep Compositor Draws Effect, Filter and Annotation Layers at 8 Bits

- **Issue / Symptom**: In a 16-bit merge, a layer with a drop shadow or a develop filter kept only 8-bit precision, and a Multiply shadow over a coloured backdrop looked slightly different from the viewport.
- **Root Cause**: `DeepCompositor` hands those layers to the 8-bit compositor it wraps, rendered alone (normal blend, full opacity, over transparency), converts the result and blends it in float with the layer's blend mode and opacity. An effect's own blend mode therefore sees a transparent backdrop.
- **Solution / Workaround**: Expected until effects and filters get float paths. Everything else in the stack (pixel layers, masks, clipping, groups, adjustment layers) keeps full depth. If a deep merge must match the viewport exactly, rasterize the effects first.

### [core/image-editor] Retouch Sources Must Be Captured When the Stroke Starts

- **Issue / Symptom**: A Healing Brush stroke sampling Current & Below or All came out matched to its own clone instead of to the photo, and a Clone Stamp stroke running over its own source copied the same pixels on and on.
- **Root Cause**: While a stroke is drawn, `_strokeUpdate` puts the live surface into `state.layers`, so a composite built at the end of the stroke (or a source that reads the live tiles) sees the stroke itself.
- **Solution / Workaround**: `retouchStroke` builds every `PixelSource` (the layer's pre-stroke surface, or a `TilePixelSource` over a compositor and the layer list as they were) in `beginStroke`, and the heal's `finalPaint` reads only those. Sources cache their tiles, so make a new one per stroke.

### [core/paint] Sequential Retouching on a Mask Needs an RGBA View, and an Empty Mask Tile Is Black, Not Transparent

- **Issue / Symptom**: The Smudge did nothing on a "hide all" mask, and on other masks it skipped whole tiles.
- **Root Cause**: `TileMedium` and `SmudgeTip` work on RGBA tiles, where a missing tile means transparent and a locked layer skips transparent pixels. A mask has one byte per pixel, and a missing tile (default 0) holds the value black.
- **Solution / Workaround**: `PaintStrokeSession` wraps a one-channel target in `rgbaViewOfGrey`: it expands every tile it reads (an empty one as zeros) to opaque grey RGBA with transparency locked, and `flush` writes the red channel back through `writeTile` after each push. The Sponge refuses masks, since a mask has no saturation.

### [core/paint] The Wet Kernels Only Agree Bit for Bit If Every Operation Is the Same f32 Operation

- **Issue / Symptom**: After adding the edge field, the TypeScript and WebAssembly wet kernels drifted apart (different state hashes after a few steps), although the maths was "the same".
- **Root Cause**: The TypeScript kernel is the specification and must round every intermediate to f32 (`Math.fround`) in exactly the SIMD kernel's order. One constant, `0.99`, was multiplied as an f64 literal in TypeScript but splatted as an f32 in AssemblyScript. (Rounding an f64 `+ − × ÷ √` of two f32 values once to f32 *is* the f32 operation, so `F(a * b)` matches `f32x4.mul`; an f64 constant breaks that.)
- **Solution / Workaround**: Declare every non-trivial constant once as `F(value)` (`DECAY`, `W0`…) and use it; never write a decimal literal inside a kernel expression unless it is exact in binary (0.25, 0.5, 1.5, 4.5). Keep masked SIMD lanes' maths identical to the scalar branch (compute both, select). `tests/paint-wet-kernel.test.ts` compares the two kernels' state hashes and checks that `kernel-wasm.ts` was generated from the current `assembly/wet.ts` (`pnpm --filter @pixerate/editor build:wasm`).

### [core/paint] Wet Media Is Only Deterministic If Nothing Depends on When Batches End

- **Issue / Symptom**: The same strokes could dry differently depending on frame rate, worker count or how many steps each frame ran.
- **Root Cause**: Anything decided at a batch boundary (waking tiles, baking and freeing dry ones) depends on where the boundaries fall, and frames decide those.
- **Solution / Workaround**: Time is the step `clock`, never wall time; edits (dabs) happen between batches and record the clock. Batches are at most `MAX_BATCH` (32) steps and never cross a multiple of `FREE_INTERVAL`. Tiles wake when anything *alive* (water on the surface or in the paper) comes within `STRIP` (64) cells of their edge, which stays ahead of anything that moves a cell a step, so an earlier or later wake-up changes nothing. Dry tiles are baked and freed only on multiples of `FREE_INTERVAL`, from the last step's flags (not the batch's), and only when no neighbour is alive. Dry cells must compute to exactly zero (that is why the edge field is 0 where dry). The tests run the same scene in different batchings and on 1–10 workers (in a browser) and compare hashes.

### [core/paint] `Math.exp` and `Math.pow` Differ Between JavaScript Engines, So the Dry-on-Save Bake Uses Its Own

- **Issue / Symptom**: A wet painting baked in Chrome and in Safari could differ by a level on a few pixels, which breaks "the saved file is the same everywhere".
- **Root Cause**: Only `+ − × ÷` and `Math.sqrt` are correctly rounded in JavaScript; `exp`, `log`, `pow`, `sin`, `cos` come from each engine's own maths library.
- **Solution / Workaround**: `film.ts` has `dexp` / `dlog` / `dpow` built from `+ − ×` only, and the sRGB tables and the `e^(−x)` table are made with them. Paper heights are quantised to 1/65536 and dab coverage to 1/4096 before they reach the simulation, so last-bit differences in the grain generator or the dab rasterizer (which use `Math.sin`) almost never matter. Flow maps use `dsincos`.

### [core/paint] A Glaze Must Be Shaded Over What Is Below as the Compositor Blends It

- **Issue / Symptom**: Blue glazed over a dried yellow wash came out blue-grey instead of green.
- **Root Cause**: The film was laid over the layer pixel mixed with the paper in *linear* light, but the compositor blends a semi-transparent pixel over the paper in *encoded* sRGB. A dark yellow channel at alpha 0.9 is 10 % of the paper in linear light (bright) but 0.1 × 255 encoded (dark), so the glaze saw a much lighter yellow than the screen showed.
- **Solution / Workaround**: `filmPixel` / `shadeTile` blend the pixel over the paper in encoded values first (`a·C + (1 − a)·P`) and only then convert to linear (`srgbByteToLinear` interpolates the byte table). The result goes back as colour plus alpha over the paper colour (exact over the paper), never lowering the pixel's own alpha.

### [core/paint] Web Workers From a Library: `Function.prototype.toString` Needs a Self-Contained Function

- **Issue / Symptom**: A worker built from a function's source failed with "x is not defined" in a consumer's minified bundle.
- **Root Cause**: `toString()` gives only the function body; anything it refers to outside itself (an imported constant, a helper) is not in the worker.
- **Solution / Workaround**: `wetWorkerMain` uses nothing outside its own body: every address and size arrives in the `init` message, and the kernel (halo exchange included) is in the wasm module. The pool runs it from a Blob URL, so hosts serve no extra file. CSPs that forbid `blob:` workers make the pool fail, and the world falls back to one thread with a warning.

### [core|demo/paint] Threads Need Cross-Origin Isolation; GitHub Pages Cannot Send the Headers

- **Issue / Symptom**: In the deployed demo wet paint runs on one thread and the Wet panel says why; locally it uses every core.
- **Root Cause**: Shared wasm memory needs `SharedArrayBuffer`, which browsers give only to cross-origin isolated pages (`Cross-Origin-Opener-Policy: same-origin` plus `Cross-Origin-Embedder-Policy: require-corp` or `credentialless`). GitHub Pages cannot set response headers.
- **Solution / Workaround**: The demo's Vite dev and preview servers send COOP `same-origin` and COEP `credentialless` (which, unlike `require-corp`, still loads cross-origin images without CORP headers). Without isolation the world steps on one thread (wasm SIMD, about 1/8 the speed on a 10-core machine) and `wetSupport().message` explains how to turn threads on. Results are identical either way.

### [core/paint-editor] Wet Layer Pixels Change Without Undo Steps, and Undo Restores a Snapshot

- **Issue / Symptom**: Undoing a watercolour stroke while other paint was still wet showed the wrong wet paint, and a fill on a wet layer could be overwritten by the next frame.
- **Root Cause**: A wet layer's pixels are the simulation's display: every frame replaces the layer's surface in the document (not an undo step). History entries hold documents, but the wet state lives in the world.
- **Solution / Workaround**: Every operation that changes wet paint takes a world snapshot before it (`beginWetOp`) and after it, kept on the history entry within `undoMemory` (oldest dropped: undoing past them leaves that paint dry). Undo and redo restore the snapshot with the document. Non-wet operations on a wet layer (a dry brush, fill, merge, duplicate, resize) dry it first inside the same undo step. Operations that touch the world while a worker batch runs throw; async callers (the agent tools, the Wet panel) `await controller.wetIdle()` first.

### [core/paint-editor] Thick Paint Is Lit at Render Time, So Relit Tiles Must Be Cached by Their Inputs' Identity

- **Issue / Symptom**: Moving the light, or painting one impasto dab, relit every tile of every thick layer and made strokes stutter on large canvases.
- **Root Cause**: A lit tile depends on its colour tile, its material tile, the light and the height of nine tiles (slopes reach across tile borders). Without a cache every composite relights everything.
- **Solution / Workaround**: `LitCache` keeps each lit tile with the identities of its inputs (colour, material, the 3 × 3 height tiles, the light key) and reuses it while they are the same objects. The live impasto stroke hands out new `Tile` objects for the height tiles it touched (`ThickStrokeDriver.channels()`), so only those and their neighbours relight. The layer's own pixels stay the unlit colour (albedo); exports, PSD layers and merges use the lit pixels, and merging drops the upper layer's relief.

### [core/paint-editor] A Replay Is Only Exact If Every Change Between Strokes Is Data, at the Right Place and Clock

- **Issue / Symptom**: A time-lapse of a painting with a ground fill showed strokes on bare paper; a replayed watercolour bloomed differently from the original.
- **Root Cause**: Strokes were recorded, but fills, clears and drying were not, and wet strokes replayed all their points at once although the simulation ran between them while the user painted.
- **Solution / Workaround**: Fills, clears and relief flattening are recorded as `paintEvents` with `at` (strokes recorded before them); wet events also carry `at` and their `clock`. Wet strokes record the clock of every point (`RecordedStroke.steps`), and `replayPainting` steps the scratch editor's simulation to each clock before pushing that point (`advanceWet` steps even when nothing is wet, so clocks stay in line). The replay test paints a live stroke with time passing between points and compares the replay byte for byte. Imported pixels, merges and transforms are still not data: those layers replay empty.

### Wet-media tests time out on CI when the scene is "small"
- **Issue / Symptom**: `paint-wet-kernel.test.ts` took ~130 s on CI (Ubuntu, Node 24) and the physics tests in `paint-wet.test.ts` 5–9 s each, although they looked modest locally.
- **Root Cause**: The TypeScript spec kernel costs ~45–70 ms per 256² tile-step, and a disc centred on a tile seam (e.g. 256, 256) wakes four tiles. A 600×420 scene for 160 steps is ~1000 TS tile-steps; CI runners are ~3× slower than a laptop and run test files in parallel.
- **Solution / Workaround**: Keep CI scenes to one tile (centre marks at 128 on a 256 grid) unless the test is about tiles, use `evaporation: 1` for tests that wait for drying, and keep the TS-vs-wasm parity scene to 2 tiles and a few steps (bit differences show from the first step). The full parity and batching scenes run with `WET_BENCH=1`.
