---
name: pixerate-image-editor
description: How to colour-correct, composite and retouch a photo in the Pixerate image editor through its agent tools - layers (pixel, adjustment, group, shape, type, annotation and smart object layers; masks, clipping, blend modes, merge, filters), smart objects and smart filters, shape and type layers, layer effects, adjustments, selections and masks, Free Transform, crop, rotate, flip, painting and the Mixer Brush, retouching (Clone Stamp, Healing Brush, Spot Healing, Smudge, Dodge, Burn, Sponge), undo, PSD, histogram and previews. Use when asked to edit, grade, correct, crop, straighten or mask an image, remove a blemish or spot, clone, dodge or burn, add a shadow, glow or outline, transform or warp a layer, draw a shape or arrow, add or edit text, make a smart object, or open or save a PSD, or when list_layers, set_adjustments, add_layer_effect, transform_layer, add_shape_layer, add_text_layer, paint_stroke, clone_stamp, spot_heal, import_psd or render_preview are available.
---

# Image editor

The image editor holds a layer stack over a canvas the size of the source image. Opening an
image gives one pixel layer, **Background**, whose pixels are the source and whose `develop`
filter holds the base adjustments; adjustment layers sit above it (bottom to top, each through
its mask, opacity and blend mode) and every annotation is its own layer on top (pen, rectangle,
ellipse, line and arrow annotations are shape layers, text annotations type layers, that remember
them). `list_layers`
shows the whole stack. Edits never touch the source pixels. The base controls edit the develop
filter of the active pixel layer (the Background unless another pixel layer is active); base
`blur` blurs that layer (or, in documents saved before layers with blur and adjustment layers,
the output after the layers), and base `opacity` is the output's alpha. Pixel, annotation, group
and smart object layers can carry live effects (shadows, glows, bevels, overlays, strokes). A smart
object places contents (pixels or a nested layer document) through a transform and smart filters,
re-rendered from the contents on every change. A shape layer holds vector paths with a fill and a
stroke, rendered again from the paths on every change, so it stays sharp through any transform. A
type layer holds live, styled text (point or paragraph) drawn with the editor's fonts.
Also an optional selection and crop/rotate/flip. See `pixerate-agent-tools` for errors and batching.

- **Control ids** for base adjustments: `brightness`, `contrast`, `exposure`, `temperature`,
  `tint`, `saturation` (all -100..100, default 0), `blur` (0..30 px) and `opacity` (0..1).
  `list_controls` is the source of truth for ranges, steps and defaults.
- **Layer ids** (e.g. `adj_1`) come from `add_adjustment_layer` / `apply_selection_as_mask`
  and `get_adjustments`. Layer parameters are addressed as `layers.<layerId>.<controlId>`,
  where nested params use dots: `layers.adj_2.master.gamma` (levels),
  `layers.adj_3.ranges.0.saturation` (hue/saturation reds), `layers.adj_4.shadows.2`
  (color balance yellow-blue), `layers.adj_1.opacity`.
- **Coordinates** for selections are natural pixels of the source image (before crop, rotate
  or flip). Read `get_selection` bounds or the image size, never screen pixels.

## Working method

1. **Read.** `get_adjustments` for the current values, process version and layers;
   `get_image_info` for the image size, crop and rotation; `list_controls` once for control
   ids, ranges, layer kinds and blend modes; `render_preview` (default 512 px) to see the
   image, then `get_histogram` to judge exposure and clipping in numbers.
2. **Plan the order of corrections** (see Best practices): straighten and crop first (so
   later judgements are on the final frame), then global tone and white balance,
   then contrast and tone curves, then colour, then local fixes through masks, then creative
   looks.
3. **Write in few steps.** Put every base change of one correction into one `set_adjustments`
   call (one undo step) with a `label`. Create layers with their `params` in the same
   `add_adjustment_layer` call rather than adding a neutral layer and then setting it.
4. **Local edits:** select, refine, check with `get_selection`, then `apply_selection_as_mask`
   with a `kind`. Load `pixerate-image-selection-masking` for cutouts, masks and local edits.
5. **Verify.** `render_preview` after each group of corrections, not after each slider, then
   `get_histogram` (it reads the last render) for clipping. Compare against the previous
   preview; read the `applied` and `clamped` lists that writes return. `undo_image` takes back a
   step that made things worse.

### Working with layers

1. **Read the stack** with `list_layers`. A photo opened in the editor has only the Background
   (active); others may have pixel layers, groups and masks. Note which layer is `active`:
   `set_adjustments` base controls edit the active pixel layer's `develop` filter.
2. **New content goes on its own layer**: `add_pixel_layer` (empty, a colour fill or a PNG at
   `x`, `y`), `layer_via_copy` to lift a selection onto a layer, `duplicate_layer` before a
   risky change. Name layers by intent. Split out a subject by its outline, not its box
   (`select_subject`, or a `select_polygon`, then `refine_selection`), then `layer_via_copy`.
3. **Shape layers non-destructively**: masks (`add_layer_mask` from the selection, or
   reveal-all / hide-all, softened with `density` / `feather`) instead of deleting pixels;
   `clipped: true` (via `set_layer_properties`) to limit a layer or adjustment to the layer below;
   `blend`, `opacity` and `fillOpacity` instead of baking.
4. **Organise** with `group_layers` (pass-through by default: blend modes inside still see the
   layers below; give the group a blend mode to isolate them), `move_layer` and
   `offset_layer`.
5. **Bake only when asked** (`merge_down`, `merge_visible`, `flatten_image`, `apply_layer_mask`):
   they are destructive. `render_preview` with `layerId` shows one layer alone.

### Free Transform

`get_transform_frame` first, pick `content` (`layer`, `selection`, `selection-copy`, `auto`), and
put every change into one `transform_layer` call (each call resamples). Read
[references/free-transform.md](references/free-transform.md) before transforming.

### Smart objects

Convert a pixel layer with `convert_to_smart_object` before repeated or uncertain transforms and
filters: from then on everything re-renders from the contents and nothing degrades. Read
[references/smart-objects.md](references/smart-objects.md) for the steps (reading, transforming,
smart filters, linked contents, rasterizing).

### Shapes and text

Draw boxes, badges, arrows and callouts as shape layers (`add_shape_layer` with a live `shape`,
then `set_shape_component` / `update_shape` / `add_shape_component`), and text as type layers
(`add_text_layer`, then `set_text`, `set_text_style`, `set_paragraph_style` by `start` / `end`
range). Both stay sharp through transforms and take effects, masks and blend modes; rasterize only
to paint on them. Read [references/shapes-and-type.md](references/shapes-and-type.md) before
drawing or editing either.

### Layer effects

1. **Effects are live and per layer**: drop and inner shadows, outer and inner glows,
   bevel & emboss, satin, colour / gradient / pattern overlays and strokes go on pixel,
   annotation and group layers (not adjustment layers) and follow the layer's pixels as they
   change. Add them with `add_layer_effect` (`kind` plus only the `settings` that differ from
   Photoshop's defaults), tune them with `update_layer_effect` and read them back with
   `list_layer_effects`. Each call is one undo step and returns the layer's effects. In the UI
   they are the **Layer Style** section of **Layer Properties**; the separate **Effects** panel is
   for provider effects (effect layers and filters), so say "layer style" when you tell the user
   where a drop shadow or stroke lives.
2. **Keep the ids**: `add_layer_effect` returns `effectId`; `update_layer_effect` and
   `remove_layer_effect` need it. `list_layers` shows which layers have effects (ids and kinds
   only).
3. **Light consistently**: shadows and bevels follow the document's global light while
   `useGlobalLight` is true (the default). Change the light for all of them with
   `set_global_light`; give one effect its own `angle` only when it must differ.
4. **Compare and size as a whole**: `set_layer_effects_enabled` with `enabled: false` hides
   every effect of a layer (each keeps its own `enabled`); `scale` resizes them all (Scale
   Effects), e.g. after resizing a layer's content.
5. **Look after each change**: `render_preview` (with `layerId` for one layer alone).

### Painting

1. **Paint on its own layer** (`add_pixel_layer`), not on the Background (active on a new image, so
   strokes without `layerId` land there) unless asked: a layer can be faded, masked or deleted.
2. **Retouch through masks**, not the eraser (see `pixerate-image-selection-masking`).
3. **One stroke is one call and one undo step.** Send the path's points in order (a few points
   per brush diameter is enough; dabs are spaced by `brush.spacing`). Use `opacity` for the
   overall strength and `flow` for gradual build-up within the stroke.
4. **Limit paint with a selection**, or lock transparency (`set_layer_properties`
   `locks.transparency`) to paint only where the layer already has pixels.
5. **Mixing paint, the Mixer Brush and gradient paint**: `mix_colors` mixes named paints like
   pigment; `paint_stroke` `tool: "mixer"` picks up and smears the layer's colours; gradient paint
   changes colour along a stroke. Read [references/painting.md](references/painting.md) first.

### Colour management

The working space, Assign / Convert to Profile with intents, soft proofing with a gamut warning
and colour conversions for print briefs: read [references/color-management.md](references/color-management.md).
### Retouching

Clone Stamp, Healing Brush, Spot Healing, Smudge, Dodge, Burn, Sponge, Blur, Sharpen and the
History Brush: retouch on an empty layer with `sample: "current-below"`, pick `spot_heal` for small
spots, `heal_brush` for larger flaws and `clone_stamp` to copy exactly (`set_clone_transform` scales,
rotates or flips the source), and keep strokes short and soft. Read [references/retouching.md](references/retouching.md) first.

### Photoshop files

`inspect_psd` before `import_psd`, then work with `list_layers`; `export_psd` writes the stack
in the source frame at the document's bit depth, colour mode and profile. Read
[references/photoshop-files.md](references/photoshop-files.md) before opening or saving a PSD.

## Best practices

- **Non-destructive first.** Prefer an adjustment layer over pushing a base slider to its
  limit: layers can be masked, faded with `opacity`, blended and stacked. Use base sliders for
  global exposure and white balance, layers for everything you may want to tune later.
- **Order of corrections** (as in a raw / Photoshop workflow): exposure and white balance
  (`exposure`, `temperature`, `tint`) → black and white points and contrast (a `levels` layer,
  then a gentle S-curve `curves` layer) → colour (`vibrance` before `saturation`,
  `hueSaturation` per range, `colorBalance`) → local adjustments through masks → creative looks
  (`photoFilter`, `blackWhite`, `posterize`). Correct before you stylise.
- **Avoid clipping.** Set levels black and white points (`master.inBlack`, `master.inWhite`)
  just inside where the image data starts (the histogram's `p1` / `p99`), not past it; large
  `exposure` or `contrast` values blow highlights and crush shadows in the output. More than
  about 0.5% of pixels in `clipping.highlightsPercent` or `shadowsPercent` on a normal photo
  means detail is lost; check bright skies, skin and deep shadows in `render_preview` too.
- **Straighten, then crop.** Level horizons with `set_rotation` (small angles such as -2.5);
  any angle that is not a quarter turn leaves transparent corners, so crop inside them with
  `set_crop` afterwards. Keep a standard aspect ratio (3:2, 4:3, 16:9, 1:1, 4:5) unless asked
  otherwise, and do not crop away the subject's space to look or move into.
- **Small moves.** Real corrections are usually within ±10..30 on these scales. Prefer
  `vibrance` over `saturation` for portraits (it protects already-saturated colours and skin).
- **Contrast through curves.** A curves S-curve keeps endpoints fixed and avoids the flat
  greys that a big `contrast` value with low `exposure` produces. Curve points are levels
  0..255 (`{ input, output }`); keep `(0,0)` and `(255,255)` and move quarter-tones by 10..25.
- **Neutral greys.** Use `temperature` / `tint` (or `colorBalance` midtones) so known-neutral
  areas (white walls, grey roads, clouds) have no cast; then add warmth deliberately if wanted.
- **Masks:** select, refine, then mask; see `pixerate-image-selection-masking`.
- **Blend modes for tone-only or colour-only changes:** `luminosity` applies a curves or
  levels layer without shifting hue or saturation; `color` applies a tint without changing
  brightness; `soft-light` / `overlay` for gentle contrast.
- **`pigment` mixes like paint.** On a layer, a fill or a brush, `pigment` mixes the colour into
  what is below as real paint would (Kubelka-Munk): blue into yellow gives green, white gives
  tints, and opacity is the share of new paint (0.5 is half and half). Use it for glazes,
  natural colour mixing and painterly strokes; it is not a Photoshop mode, so keep it off
  layers that must survive a PSD round trip. It costs about ten times a normal blend.
- **Name layers** (`name`) by intent ("Sky darken", "Warm skin"), so the stack stays readable.
- **Effects: subtle first.** A drop shadow reads as natural with a small `distance` (2..10 px),
  a `size` a little larger than the distance, `opacity` 0.3..0.6 and the default multiply; a
  hard, dark, far shadow looks pasted on. Glows want `screen` and a light colour; strokes on
  text 1..4 px. Bevels: `depth` 1..2 and `size` a fraction of the shape's thickness.
- **Outline-only looks** (an outlined title, a glass button): set the layer's `fillOpacity` to
  0 with `set_layer_properties` and keep its effects; fill opacity hides the layer's own pixels,
  layer `opacity` fades the effects too.
- **Prefer an effect over painted pixels** for shadows, glows, outlines and colour fills of a
  shape: it follows later edits and stays adjustable.
- **Transforms: one resample, bicubic, whole pixels when you can.** Combine a scale, rotation and
  move into one `transform_layer` call; use `rotate_layer_90` / `flip_layer` (exact) instead of
  `rotate: 90` or `scaleX: -100`. `interpolation: "nearest"` keeps hard pixel art crisp; bicubic
  (default) is right for photos, bilinear is a little softer. Enlarging past about 200 % shows
  softness: prefer a larger source.
- **Scale proportionally** unless asked to stretch: give `scaleX` and `scaleY` the same value.
  Keep the subject in frame: after a scale about `center` the layer can run past the canvas,
  which `bounds` in the result shows.
- **Smart objects for anything you may scale again.** Convert first, then transform as often as
  needed; set exact sizes with `set_smart_object_transform` `scaleX` / `scaleY` (percent of the
  contents) rather than chaining relative scales. Prefer smart filters over layer filters when
  the user may want to mask, blend or reorder them later.
- **Linked or not**: duplicate a smart object `linked: true` for repeated elements that must stay
  identical (a logo placed twice); use `linked: false` when the copies will be edited apart.
- **Merge Down only onto an opaque, 100 % lower layer** when the result must look the same:
  the merged layer keeps the lower layer's opacity and blend, so a faded lower layer fades the
  merged content too, and a blend mode on the upper layer stops seeing what was below the lower
  layer where the lower one is transparent. Check with `render_preview` after merging.

## Tool reference

### Read

| Tool | Use it to |
| --- | --- |
| `get_adjustments` | Read the current state: `values` by control id, `process` version (1 or 2), and `layers` bottom to top with id, kind, params, opacity, blend, enabled and mask. Call first, and to find layer ids. |
| `list_controls` | Get every base control (id, label, section, min, max, step, default, `requiresProcess`), each layer kind's settable controls (plus `opacity`), the blend mode ids and the `layers.<layerId>.<controlId>` path format. Call once per session before writing. |
| `get_selection` | Read the active selection: `empty`, `bounds` (natural pixels), `area` in pixels, `percent` of the image and a description. Check it after every select or modify step and before masking: a wand that covered 90% of the image is the wrong selection. |
| `list_channels` | Read the alpha channels (saved selections): id, name, bounds, percent, overlay and visibility, and whether Quick Mask mode is on. |
| `select_subject` | Select › Subject. With a host segmentation model, `target` describes what to select ("the dog", "the sky") and the model's outlines are selected (`maxSegments` 1 for one). Without one, the subject that stands out most is found classically; `target` can't choose it (`method: "saliency"`, `note`). Combined by `mode`. Returns the selection, `found` (label, bounds) and `method`; nothing found leaves the selection unchanged. |
| `list_layers` | Read the layer stack bottom to top as a tree: id, type (`pixel`, `adjustment`, `group`, `shape`, `annotation`, `smart`; smart objects add their `contents`, `smartFilters` and `filterMask`; shapes a `shape` summary of component ops and kinds and paint types, and `annotation` when migrated from one), name, document `bounds` of pixel layers, visibility, opacity, `fillOpacity`, blend, `clipped`, locks, a `mask` summary, an `effects` summary (master switch, scale, effect ids and kinds), pixel-layer `filters` (the Background's `develop` filter is the base adjustments), adjustment `kind` and `params`, group `children`, and which layer is `active`. Call it to understand a document with more than the Background before changing it; adjustment layer ids work with every adjustment-layer tool. |
| `list_layer_effects` | Read one layer's effects: `enabled` (master switch), `scale` (Scale Effects), `margin` (px they reach beyond the shape), `fromPsd`, and every effect with `id`, `kind`, `label` and all its settings. Also returns the `globalLight`, the `patterns` pattern effects can use and the effect `kinds`. Call before changing effects you did not add. |
| `get_image_info` | Read the geometry: source `image` size, `crop` box (source pixels, or null), `rotation` degrees, `flipH` / `flipV`, the `output` size after crop and rotation, `bitDepth` (8, 16 or 32), the layer count and `canUndo` / `canRedo`. Call before cropping or selecting so coordinates are right. |
| `get_histogram` | Judge exposure numerically: per channel and luminance `mean`, `p1` and `p99` (0..255), and `clipping` percent at pure black and white per channel. Reads the last render, so call `render_preview` first. `bins` (16, 32, 64 or 256) adds the counts. Cheaper than another image for checking a tonal change. |
| `render_preview` | See the edited image (crop, adjustments, layers, annotations) as a PNG, or with `layerId` one layer alone. `maxSide` 16..2048 px, default 512. Images cost tokens: render after a group of edits, use 512 for overall look and 1024+ to judge clipping, edges and masks. Fails in environments without rendering. |
| `inspect_psd` | Read a PSD / PSB (`data` base64) without opening it: size, `depth`, `colorMode`, `resolution`, every layer bottom first with `psdKind`, the `type` it would become (`smart`, `shape` and `type` for Photoshop smart objects, shapes and text) and `status` (`mapped`, `approximated`, `dropped`) with `notes`, and the import `warnings`. Call before `import_psd`. |
| `export_psd` | Save the document as an RGB PSD at its bit depth (PSB above 30000 px) with layers, groups, adjustment layers and masks. Returns `data` (base64), `size` in bytes, `psb` and `warnings` (crop or rotation not applied, filters and depth masks baked, annotations rasterized or left out, Pigment blends written as Normal). Shape and type layers are written as real Photoshop shape and type layers. Changes nothing. |
| `get_transform_frame` | Before a transform: what it would move (`content`, `moved`: pixels, mask, selection), its `frame` (document bounds of the content), `corners` (top-left, top-right, bottom-right, bottom-left) and `center`. `meshColumns` / `meshRows` also return an identity warp `mesh` over the frame to edit for `warp_layer`. Changes nothing. |
| `get_smart_object` | Read a smart object: `contents` (`id` shared by linked instances, `name`, `kind` raster or document, `width` / `height`, `decoded`, `fileType`, `linkedPath`, `instances`), `placement` (`corners`, `warp` in contents px, `interpolation`, and when `affine` the `scaleX` / `scaleY` in percent of the contents, `rotate`, `skewX`, `center`, `bounds`) and `smartFilters` (`enabled`, `filters` bottom to top with ids, settings, `blend`, `opacity`; kind `psd` is a Photoshop filter kept but not drawn; the filter `mask`). Call before changing a smart object. |
| `list_fonts` | Read the font families type layers can use here (generic families always work) and which shaper draws them. Call before choosing a font. |
| `get_text_layer` | Read a type layer: `text`, character `runs` and `paragraphs` as `start` / `end` ranges (UTF-16 code units, end exclusive) with their styles, the `frame` (point, or box with its size), the text-to-document `transform`, laid-out `lines` (range, baseline, width), `bounds`, `missingFonts`, and `rendering` (`live`, or `stored` pixels from a file until the next edit). Call before editing text you did not write. |
| `get_shape_layer` | Read a shape layer: `components` bottom to top (`index`, `op`, `live` shape parameters or null, `subpaths` with absolute anchors and handles, `bounds`), `fillRule`, `fill` and `stroke` (paint and settings), `geometryBounds` (the paths) and `bounds` (rendered pixels, stroke included), and `annotationId` while it is still a migrated annotation. Call before editing a shape you did not draw. |
| `export_smart_object_contents` | Export Contents: the contents as a file (`name`, `mimeType`, `byteLength`, `base64`): the file they came from while unedited, else a PNG (raster) or PSD / PSB (nested document). Changes nothing. |
| `search_effects` | Find provider effects (when the host registered an effects provider; else `available: false`): `query`, `kind`, `category`, `use` (filter for smart filters; generator, overlay, title for effect layers). See `references/provider-effects.md`. |
| `describe_effect` | Read an effect's `controls` (strict JSON Schema with ranges and units), `defaults`, `presets` and `inputs` before applying it. |
| `list_applied_effects` | Read the provider effects per layer: effect smart filters (`role: smart filter`, with blend and opacity) and an effect layer's own effect (`generator`), with `available` false when the provider lacks one. Works without a provider. |
| `capture_view` | Inspect detail in natural image pixels (the space of `get_selection` and the select tools, before crop and rotation): `region` `content` (whole image, default), `selection` or `rect`; small regions are enlarged up to 8× with hard pixel edges, so a 64 px rect shows real pixels. `includeOverlays: true` shades unselected pixels and outlines the crop: use it to check a mask's edge before `apply_selection_as_mask`. Returns the `rect` and `scale`. Use `render_preview` for the final framed result. |

### Write

| Tool | Use it to |
| --- | --- |
| `set_adjustments` | Set base controls and existing layer parameters in one undo step: `values` is a map of control id or `layers.<layerId>.<controlId>` path to number; `label` is echoed. Values are clamped to range; returns `applied` and `clamped` (and a note when `tint` is set on a process 1 edit). Unknown ids fail and change nothing. Cannot set curves points, booleans or colours. |
| `add_adjustment_layer` | Add a layer above the other adjustment layers and below annotations (or directly above `aboveId`, or at the top of group `parentId`): `kind` (curves, levels, hueSaturation, vibrance, colorBalance, blackWhite, photoFilter, invert, posterize, threshold), optional `params` merged with neutral defaults, `opacity` 0..1 (default 1), `blend` (default normal), `name`. With a selection the layer is masked by it (`useSelection`, default true; `false` for a global layer; `masked` in the result). Returns the layer (with its new id) and its stack index. The only tool that sets curves points, `colorize`, `preserveLuminosity`, a black and white `tint` or a photo filter `color`. |
| `select_all` | Select › All. Returns the selection summary (`empty`, `bounds`, `area`, `percent`). |
| `deselect` | Clear the selection so edits apply to the whole layer. Returns the empty summary. |
| `invert_selection` | Select › Inverse (soft edges stay soft; with nothing selected, selects all). Returns the summary. |
| `select_rect` | Rectangular marquee: `x`, `y`, `width`, `height` (natural px), `mode` (replace, add, subtract, intersect), `feather` px, `antiAlias`. Returns the summary. |
| `select_ellipse` | Elliptical marquee inscribed in `x`, `y`, `width`, `height`; same options. A feathered ellipse makes a vignette. Returns the summary. |
| `select_line` | Single row or column marquee: `orientation` `row` (at y) or `column` (at x), `position` in natural px, `mode`. A 1 px line across the image. Returns the summary. |
| `quick_select` | Quick Selection: `strokes` (brush paths of `{x, y}`), `size` (diameter, default 30), `mode`, `sampleAllLayers`, `enhanceEdge`. Each stroke grows out to its region's edges; with `replace` the first replaces and the rest add. Paint inside the area, then check and fix with `add` / `subtract` strokes. Returns the summary. |
| `select_object` | Object Selection: `rect` (a box around the object) or `point` (on it), `mode`, `sampleAllLayers`, `enhanceEdge`, `useModel`. Uses the host model when set (else, or when nothing fits, GrabCut; outside the box is background). Make the box a little larger than the object. Returns the summary and `method`. |
| `select_focus_area` | Select › Focus Area: the in-focus (sharp) parts, edge fitted to the image. `range` 0..100 (higher takes in softer areas), `noise` 0..100 (raise when grain is selected), `softness` px, `mode`. Returns the summary and `noiseLevel`. |
| `select_sky` | Select › Sky: the sky, from the host model when set, else classically (blue or overcast, from the top down, with patches through gaps). `threshold` 0..100 (higher takes in haze) and `softness` px for classical, `mode`, `useModel`. Returns the summary, `method`, and `note` when none was found. |
| `select_polygon` | The lasso: `points` (at least 3 `{x, y}` along the outline, closed automatically), `mode`, `feather`, `antiAlias`; `snapToEdges: {width, contrast}` makes it the Magnetic Lasso (points snap to edges, the outline follows them). Trace a subject's contour, not its box. Returns the summary (plus `outlinePoints` when snapped). |
| `magic_wand` | Select similar colour from `x`, `y`: `tolerance` 0..255 (default 32), `contiguous` (default true), `distance` `rgb` or `perceptual`, `sampleMerged`, `sample` (`composite` or `active-layer`), `mode`, `feather`. For flat backdrops and solid colours. Returns the summary. |
| `select_color_range` | Color Range, soft: `samples` (`[{color, x?, y?}]`) or a `preset` (reds … magentas, highlights, midtones, shadows, skinTones); `fuzziness` (samples 0..200, default 40; tone presets' falloff, default 20), `localized` px radius around positioned samples, `invert`, `sample`, `mode`, `feather`. Returns the summary. |
| `load_selection_from_image` | Load a mask image (`image` data URL or URL; white = selected) by `channel` (luminance, alpha, red, green, blue), with `threshold`, `invert`, `mode`. For AI or saved mattes; then `refine_selection`. Returns the summary. |
| `select_layer_transparency` | Select a layer's pixels (Ctrl/⌘-click its thumbnail): its alpha, soft where partly transparent, for pixel, shape, type and smart object layers; `mode`, `feather`. Returns the summary. |
| `load_selection_from_mask` | Load a layer's mask as the selection (`layerId`, `invert`, `mode`); fails without a painted mask. Returns the summary. |
| `set_selection_display` | Show the selection as `ants`, `quickMask` (tint over the unselected area, to judge soft edges) or `none`. View only, no undo step. |
| `select_region` | Deprecated alias (removed next minor): `shape` rect, ellipse, polygon, all, none or invert. Use the tools above. |
| `select_by_color` | Deprecated alias (removed next minor): wand (`x`, `y`) or one `color`. Use `magic_wand` or `select_color_range`. |
| `modify_selection` | Expand, contract, feather, border or smooth the selection (`op`; `grow` / `shrink` are old names for expand / contract) by `radius` px (0..500). Contract then feather keeps an adjustment off an edge; smooth removes wand speckle. Fails when nothing is selected. |
| `grow_selection` | Select › Grow: add connected pixels within `tolerance` (default 32) of a selected colour; follows colour, not distance. `sample`, `sampleMerged`. Fails when nothing is selected. Returns the summary. |
| `select_similar` | Select › Similar: add every pixel in the image within `tolerance` of a selected colour, connected or not. Fails when nothing is selected. Returns the summary. |
| `reselect` | Bring back the last selection `deselect` cleared (one undo step). Fails when there is none. Returns the summary. |
| `refine_selection` | Select and Mask: snap the selection edge to image edges within `radius` px (0..64, default 8), with `smartRadius`, `smooth` 0..100, `feather` px, `contrast` 0..100 and `shiftEdge` -100..100 %, then `output` to `selection` (default), `layer-mask`, `new-layer`, `new-layer-with-mask` (on `layerId`, default active; new layers hide the source), or `new-document` / `new-document-with-mask` (host must open documents; returns `documentId`), with `decontaminate` 0..100 for new layers and documents. `edits` (`quick-select`, `brush`, `lasso`, `object` add/subtract; `refine-brush` over hair) apply first; `refineMode: "object"` uses the host model. One step; returns `refineMode`, `layerId` / `newLayerId`. Use on hair, fur, foliage or a coarse AI mask. |
| `update_adjustment_layer` | Change a layer's `enabled` (false hides it without deleting), `blend`, `opacity` (0..1) or `name` in one undo step. Returns the layer. Its parameters change with `set_adjustments`. Toggle `enabled` to compare a layer's effect before and after. |
| `move_adjustment_layer` | Move a layer to index `to` (0 = bottom, applied first; past the top means top). Order matters: a curves layer above a hue/saturation layer works on its output. Fails when the layer is already there. Returns the ids bottom to top. |
| `remove_adjustment_layer` | Delete a layer and its mask. Prefer hiding it with `update_adjustment_layer` when the user may want it back. Returns the remaining ids. |
| `set_crop` | Crop to `x`, `y`, `width`, `height` in source pixels of the un-rotated image (see `get_image_info`). Non-destructive; refused if the box leaves the image. For an aspect ratio, compute the largest box of that ratio inside the image and centre it on the subject. Returns the geometry. |
| `reset_crop` | Remove the crop and show the whole image again. |
| `set_rotation` | Set the absolute rotation in degrees clockwise (-360..360). Quarter turns keep every pixel; small angles straighten a horizon but add transparent corners to crop away. Returns the geometry. |
| `set_bit_depth` | Image › Mode: `depth` 8, 16 or 32 (float, linear light). Up costs nothing; down rounds the layers' extra precision away (32 → 16 clips colour above 1). One undo step. Returns `bitDepth` and `changedLayerIds`. |
| `flip_image` | Mirror the image `horizontal` (left-right) or `vertical`. Avoid flipping images with text, logos or recognisable places. |
| `undo_image` | Undo the last edit (one tool call is one step). Returns `canUndo` / `canRedo`. |
| `redo_image` | Redo the edit you just undid. |
| `set_active_layer` | Make a layer active (`layerId`) and choose the paint `target` (`pixels`, `mask`, or a smart object's `filter-mask`). Base sliders then edit that pixel layer's develop filter. Not an undo step. Returns the layer. |
| `add_pixel_layer` | Add a pixel layer above the active layer (or at `aboveId` / `belowId` / `parentId` / `index`): empty, `color` `#rrggbb[aa]` over the canvas, or `image` (PNG data URL or base64; other formats only in a browser) at `x`, `y`; with `name`, `opacity`, `blend`. Returns the layer with its id and bounds. |
| `duplicate_layer` | Copy a layer (groups with their children) directly above it, e.g. before a destructive change. Returns the copy. |
| `remove_layer` | Delete a layer or group (refused when locked). Prefer hiding with `set_layer_properties`. Deleting the active layer makes the nearest paintable pixel layer below it active. Returns the remaining top-level ids and the new `activeLayerId`. |
| `move_layer` | Reorder: give exactly one of `aboveId`, `belowId`, `parentId` (into a group, optional `index`) or `index` alone. Returns the new `parentId` and `index`. |
| `set_layer_properties` | Change `name`, `visible`, `opacity`, `fillOpacity`, `blend` (`pass-through` for groups), `clipped`, `locks` or `collapsed`. Only given fields change. Returns the layer. |
| `group_layers` | Put sibling layers (`layerIds`) into a new pass-through group at the topmost one's position. Returns the group and its children. |
| `add_group` | Add an empty group (pass-through unless `blend` is given) above the active layer or at a placement, then move layers into it with `move_layer` `parentId`. Returns the group. |
| `ungroup_layer` | Replace a group by its children (its own opacity, blend and mask are dropped). Returns the child ids. |
| `merge_down` | Composite a layer onto the pixel layer below it (masks, fill and filters baked). Destructive; see Best practices. Returns the merged layer. |
| `merge_visible` | Composite all visible top-level layers into one layer; hidden ones stay. Destructive. |
| `flatten_image` | Composite everything visible into one Background; hidden layers are discarded. Destructive; do it only when asked. |
| `offset_layer` | Move a pixel layer or smart object and its linked mask to `x`, `y` (a smart object's top-left corner) or by `dx`, `dy` (integers, document px; an unlinked mask stays put). Refused when its position is locked. Returns the offset and bounds. |
| `transform_layer` | Free Transform a pixel layer or smart object (with its linked mask; a smart object re-renders from its contents and always moves whole), the selected pixels (`content` `selection`), a copy of them on a new layer (`selection-copy`) or an unlinked mask (`channel` `mask`). Give the transform one way: `scaleX` / `scaleY` (percent), `rotate`, `skewX` / `skewY` (degrees), `dx` / `dy` (px) about `reference` (an anchor or `{x, y}`, default `center`); or `matrix` `[a, b, c, d, e, f]`; or `corners` (the frame's new corners: distort / perspective, kept convex). `interpolation` nearest, bilinear or bicubic (default). One undo step. Returns `layerId` (the new layer for a copy), `moved`, `frame`, `corners` and the new `bounds`. |
| `warp_layer` | Warp the same targets as `transform_layer` through a preset (`style` arc … twist, `bend` −100..100 default 50, `horizontal` / `vertical` distortion, `orientation`) or a `mesh` (`columns`, `rows`, (3·columns + 1) × (3·rows + 1) `points` in document px; start from `get_transform_frame`'s identity mesh). One undo step. Returns the new `bounds`. |
| `transform_selection` | Transform only the selection outline (Transform Selection): the same numeric fields, `matrix` or `corners` as `transform_layer`, over the selection's bounds. Pixels do not change. Needs a selection. Returns the new selection `bounds`. |
| `flip_layer` | Mirror a pixel layer, its selected pixels or a copy (`content`) `horizontal` or `vertical` about the frame's centre, exactly. For the whole image use `flip_image`. Returns the new `bounds`. |
| `rotate_layer_90` | Turn a pixel layer, its selected pixels or a copy by `turn` 90 (clockwise), -90 or 180 about the frame's centre, landing on whole pixels (no resampling). For the whole image use `set_rotation`. Returns the new `bounds`. |
| `add_layer_mask` | Mask any layer `from` `reveal-all`, `hide-all`, `selection`, `hide-selection` (its inverse) or `transparency` (the layer's own alpha), with optional `density` / `feather`. Replaces an existing mask. Returns the mask summary. |
| `set_layer_mask_properties` | Change any layer mask's `density`, `feather`, `enabled` or `linked` (false: the mask stays put when the layer moves or transforms) without touching its pixels. |
| `apply_layer_mask` | Bake a pixel layer's mask into its alpha and remove it. Destructive. |
| `set_mask_view` | Show a layer's mask to check it (`view` `gray` alone, `overlay` red tint over what it hides, `off`; `layerId`, default active). View state only; look with `capture_view` `includeOverlays: true`, then `off`. Returns `{view, layerId}`. |
| `remove_layer_mask` | Delete a mask without applying it; disable it instead to keep it. |
| `layer_via_copy` | Copy the selected pixels of a pixel layer (default the active one) to a new layer above it; `cut: true` removes them from the source. Needs a selection. Returns the new layer. |
| `rasterize_layer` | Turn a shape layer into a pixel layer showing the same pixels (same id, mask, effects, opacity, blend; the paths are gone), an annotation layer into pixels (browser only), a smart object into a pixel layer (as `rasterize_smart_object`), or bake a pixel layer's develop / blur filters into its pixels. Do it before painting over a shape or annotation, or when the user wants the filters fixed. Destructive. |
| `add_text_layer` | Add live type above the active layer and make it active: `text`, `x`, `y`, optional `box` (paragraph text), `orientation` (`vertical`: columns down from `x`, `y`, right to left, for Japanese / Chinese / Korean), `style`, `paragraph`, `rotation`, `name`, `opacity`, `blend`, placement. Returns the `layer` and `text` (with `orientation`, `lines` and `missingFonts`). One undo step. |
| `set_text` | Replace text `start`..`end` (default all) with `text`; start = end inserts. New text takes the style at `start`. Returns the text layer. |
| `set_text_style` | Set character style fields over `start`..`end` (default all): `fontFamily`, `fontWeight`, `italic`, `fontSize`, `color`, `opacity`, `tracking`, `leading`, `baselineShift`, `underline`, `strikethrough`, `upright` (vertical text: Latin upright instead of turned) (`null` resets optional ones). Returns the runs. |
| `set_paragraph_style` | Set `align`, `autoLeading`, indents, `spaceBefore` / `spaceAfter` on every paragraph `start`..`end` touches (default all). Returns the text layer. |
| `set_text_frame` | `kind: point` (one line per paragraph) or `kind: box` with `width` and `height` (wrapping paragraph text), or resize a box; the first line stays put. Returns the text layer and its lines. |
| `set_text_orientation` | Type › Orientation: `horizontal` or `vertical` (columns top to bottom, right to left; CJK upright, Latin turned sideways unless `upright`). Text, styles, frame and origin stay. Returns the text layer with its new lines (columns). One undo step. |
| `convert_text_to_shape` | Type › Convert to Shape: glyph outlines become a shape layer with the same id (text no longer editable; fill from the first run's colour; `warnings` lists losses). Needs an outline font shaper. Destructive. |
| `select_text_shape` | Horizontal / Vertical Type Mask: select the shape of `text` at `x`, `y` (style, box, rotation as `add_text_layer`; `orientation` `vertical` lays it out as vertical type: columns down from `x`, `y`, right to left, CJK upright, Latin turned), by `mode`, with `feather`. No layer is added. Returns the selection. |
| `add_shape_layer` | Add a vector shape layer above the active layer (or placed with `aboveId` / `belowId` / `parentId` / `index`) and make it active: `shape` (live rect, ellipse, polygon, star or line, document px), `subpaths` (SVG path data or anchors) or several `components` with path ops; `fill` (colour, gradient or pattern, default the foreground colour; `null` none), `stroke` (`width`, `paint`, `align`, `cap`, `join`, `miterLimit`, `dashes` in widths), `fillRule`, `name`, `opacity`, `blend`. Returns the `layer` and the `shape`. One undo step. |
| `update_shape` | Restyle a shape: `fill` (replace, `null` removes), `stroke` (only the settings given change; `null` removes; a new stroke needs `width` and `paint`), `fillRule`. Geometry is unchanged. Returns the shape. |
| `set_shape_component` | Change component `componentIndex` (from `get_shape_layer`): `shape` fields (without `kind`, or with the same kind, unset fields keep their values), new `subpaths` (ends the live shape), or `op`. Returns the shape. |
| `add_shape_component` | Add a live shape or path to a shape layer with `op` (`combine`, `subtract`, `intersect`, `exclude`), on top unless `index`. Use it for cut-outs, rings, badges. Returns the shape. |
| `remove_shape_component` | Delete one component (not the last: delete the layer instead). Returns the shape. |
| `merge_shape_components` | Merge Shape Components: the combined area becomes one plain component (live shapes become paths); the look does not change. Returns the shape. |
| `get_vector_mask` | Read-only. A layer's vector mask: enabled, linked, inverted, fill rule, density, feather, bounds and components (subpaths in document px), or null. Read it before editing the path. |
| `add_vector_mask` | Layer › Vector Mask on any layer but a shape: `from` `path` (a `shape`, `subpaths` or `components`, like `add_shape_layer`), `selection` (traced, `tolerance` px), `reveal-all` or `hide-all` (empty path). Reveals inside the path, sharp at any size; it combines with the raster mask. Returns the vector mask. |
| `set_vector_mask_path` | Replace the vector mask's path (properties kept). Returns the vector mask. |
| `set_vector_mask_properties` | `enabled`, `linked` (false: stays put when the layer moves), `inverted`, `density`, `feather` px; the path is kept. Returns the vector mask. |
| `rasterize_vector_mask` | Multiply the path into the raster mask (adding one) and drop the vector mask, so it can be painted. Returns the mask summary. |
| `remove_vector_mask` | Delete the vector mask (the raster mask stays). |
| `selection_to_path` | Read-only. Make Work Path: the selection's outline as closed Bézier subpaths (`tolerance` px, `cornerRoundness`, `minArea`); returns `svg` and `fillRule: "evenodd"` to pass to `add_vector_mask`, `set_vector_mask_path` or `add_shape_layer`. |
| `path_to_selection` | Make Selection: fill a path (`shape`, `subpaths`, `components`) into the selection by `mode`, with `feather` and `antiAlias`. Returns the selection. |
| `convert_to_smart_object` | Convert sibling `layerIds` (default the active layer) to one smart object at the top one's position, optional `name`. One pixel layer keeps its id, look and properties (filters become smart filters); several layers, groups or adjustments nest as a layer document. Returns the `layer` and the `smartObject` summary. |
| `rasterize_smart_object` | Turn a smart object into a pixel layer holding what it shows now (smart filters baked; same id, mask, effects, opacity, blend). Destructive: the contents and filters are gone. Returns the layer. |
| `set_smart_object_transform` | Set a smart object's transform absolutely: `corners`, `matrix` (contents → document), or `scaleX` / `scaleY` (percent of the contents), `rotate`, `skewX`, `skewY`, `x`, `y` (where the contents' centre goes; unset numbers keep their values); `warp` preset or mesh in contents px, `null` removes it; `interpolation`. Re-renders from the contents. Returns `placement`, `masksMoved` and `bounds`. |
| `replace_smart_object_contents` | Replace Contents with `image` (PNG data URL or base64; other formats in a browser) for the smart object and every linked instance; each keeps its scale and rotation about the centre. Returns `contentsId`, the new size and `layerIds` changed. |
| `copy_smart_object` | Duplicate a smart object above it: `linked: true` shares the contents (edits show in both), `linked: false` (default, New Smart Object via Copy) gives independent contents. Returns the copy and its `contentsId`. |
| `edit_smart_object_contents` | Open a smart object's contents as their own document (raster contents as one pixel layer, "Layer 0") with their own undo; all tools then act inside them. Returns the size, `layerIds`, `layers` and `editing` (the open path). Always close it. |
| `close_smart_object_contents` | Close the innermost open contents: `save` true (default) writes them back and re-renders every linked instance (one undo step), false discards. Returns `layerId`, `changed`, `layerIds` and what is still `editing`. |
| `add_smart_filter` | Add a `develop` (brightness … tint) or `blur` (`radius`) smart filter with its own `blend` and `opacity`, at `index` (default top); kinds may repeat. With a selection the filter mask is set from it (`useSelection`, default true). Returns the `filter` (with id), the stack and `masked`. |
| `update_smart_filter` | Change one smart filter's settings, `enabled`, `blend` or `opacity` (`filterId` from `get_smart_object`); kind `psd` filters take only the last three. Returns the filter and the stack. |
| `remove_smart_filter` | Remove one smart filter (the filter mask goes with the last one). Returns the stack. |
| `move_smart_filter` | Move a smart filter to `index` (0 = bottom, applied first). Returns the stack. |
| `set_smart_filters_enabled` | Switch the whole smart filter stack off or on (`enabled`); each filter keeps its own flag. Returns the stack. |
| `set_smart_filter_mask` | Set the smart filter mask `from` `reveal-all`, `hide-all`, `selection`, `none` (remove) or `keep` (properties only), with `density`, `feather`, `enabled`, `linked`. Paint it with `channel: "filter-mask"`. Returns the mask summary. |
| `add_layer_filter` | Add a live `develop` (brightness … tint) or `blur` (`radius`) filter to a pixel layer; one of each kind. Returns the filters with ids. |
| `update_layer_filter` | Change a filter's values (`filterId` from `list_layers`). Returns the filters. |
| `remove_layer_filter` | Remove a filter. Returns the remaining filters. |
| `add_layer_effect` | Add an effect to a pixel, annotation or group layer: `kind` (`drop-shadow`, `inner-shadow`, `outer-glow`, `inner-glow`, `bevel-emboss`, `satin`, `color-overlay`, `gradient-overlay`, `pattern-overlay`, `stroke`) and `settings` that differ from Photoshop's defaults (a setting the kind does not have is refused with its list of settings); optional `index` in the effect list. Returns `effectId` and the layer's effects. |
| `update_layer_effect` | Change settings of one effect (`effectId`); nested `fill`, `gradient`, `contour` and `texture` objects replace whole, `null` removes an optional `contour`, `glossContour`, `contourElement` or `texture`. The kind cannot change. Returns the effects. |
| `remove_layer_effect` | Delete one effect. To hide it and keep its settings, set `enabled: false` with `update_layer_effect` instead. Returns the remaining effects. |
| `set_layer_effects_enabled` | Switch all of a layer's effects on or off (`enabled`) and optionally set Scale Effects (`scale`, 1 = 100 %, multiplies sizes, distances and pattern scales). Returns the effects. |
| `set_global_light` | Set the document light (`angle`, `altitude` in degrees) that every shadow and bevel with `useGlobalLight` follows. Returns the light. |
| `paint_stroke` | Paint (`tool` brush), blend with the Mixer Brush (`tool` mixer) or erase (`tool` eraser) along `points` in document px (optional `pressure` 0..1) on a pixel layer or its mask (`channel`; the mixer paints pixels only); `color` #rrggbb (on a mask: black hides, white reveals; for the mixer, the reservoir colour) or `paint` (brush only: a gradient for this stroke); `brush` `{size, hardness, spacing, angle, roundness, opacity, flow, smoothing, pressureSize, pressureOpacity, blend}`; `mixer` `{wet, load, mix, loadEachStroke, cleanEachStroke, mixing: rgb \| pigment}` (tool mixer only). The selection limits the paint. One undo step per call. Returns the layer, channel, changed `bounds`, dab count and, for the mixer, `mixerLoad` `{reservoir, amount, pickup}`. |
| `set_paint` | Set what the brush paints: one colour (it becomes the foreground) or gradient paint (`stops` sorted by offset, `space` pigment / oklab / srgb, `map`, `softness`). Errors say what is wrong. Returns `paint`, `foreground`, `background`, `brush`. |
| `get_paint` | Read-only. What the brush paints (`paint`), the foreground and background colours and the brush settings. |
| `get_mixer_brush` | Read-only. The Mixer Brush settings and what it carries (`reservoir` #rrggbb or null, `amount` left 0..1, `pickup` #rrggbb or null). Call it before a mixer stroke with `loadEachStroke: false`. |
| `load_mixer_brush` | Fill the Mixer Brush reservoir with `color` (default the foreground), amount 1; keeps the pickup. View state, not an undo step. Use before strokes with `loadEachStroke: false`. Returns the load. |
| `clean_mixer_brush` | Empty the Mixer Brush pickup well (`emptyReservoir: true` also drops the loaded paint, so it only smears). View state, not an undo step. Returns the load. |
| `get_color_profile` | Read-only. The document's profile (`name`, `builtin` id or null, `colorSpace`, `srgb`), the Proof Setup or null, and the built-in profiles. |
| `assign_profile` | Make the document's numbers mean colours in `profile` (built-in id or `icc:<base64>`; RGB only). The look changes, pixels do not. One undo step. Returns the profile. |
| `convert_to_profile` | Convert the document into `profile` keeping its look (`intent`, `bpc`): pixel layers, shape and text colours, effect and annotation colours. Then assign it. One undo step. Returns the profile, `convertedLayerIds` and `unconvertedLayerIds` (smart objects). |
| `set_proof_setup` | Soft-proof the viewport through `profile` (`intent`, `bpc`, `simulatePaper`, `gamutWarning`), or `off: true`. View state. Returns the setup. |
| `set_color_mode` | Image › Mode: `rgb`, `cmyk` (with the press `profile`, default coated-cmyk, and the separation `intent`) or `lab`. Pixels stay RGB; CMYK documents proof through their profile and `export_psd` writes CMYK / Lab channels. One undo step. Returns the profile summary with `mode`. |
| `convert_colors` | Read-only. `colors` #rrggbb from the document's profile (or `from`) to `to`: channel `values` 0..1 (CMYK, RGB, grey), `hex` for RGB, and `lab`. |
| `clone_stamp` | Copy pixels from the clone source along `points`: each point paints what is at point + offset (source − first point, whole px). `source` `{x, y}` sets the source for this stroke (else the current one, see `set_clone_source`); `aligned` keeps the offset for later strokes; `sample` current \| current-below \| all; `brush` `{size, hardness, spacing, opacity, flow, smoothing, pressureSize, pressureOpacity}`; `layerId`, `channel` (a mask clones from itself). One undo step. Returns the layer, channel, `bounds`, dabs and `clone` `{offset, source, aligned}`. Call `set_clone_source` or pass `source` first. |
| `heal_brush` | As `clone_stamp`, then blends the cloned texture into the colour and light around the stroke (Poisson seamless cloning, when the stroke ends). Use for blemishes, wrinkles, dust and seams where the surroundings have the right tone. Returns as `clone_stamp`. |
| `spot_heal` | Remove what `points` cover with no source: `type` proximity-match (default: copies the best matching nearby patch, then heals it in), content-aware (synthesises texture, continues lines and patterns) or smooth (fills from the edges). `sample`, `brush`, `layerId`, `channel`. One undo step. Returns the layer, channel, `bounds`, dabs and `spotHeal` `{offset}` (null for a smooth fill). |
| `smudge` | Drag colour along `points` like a finger in wet paint; `strength` 0..1 (default 0.5) is how far. Works on masks too. One undo step. Returns the layer, channel, `bounds` and dabs. |
| `dodge` | Lighten what `points` cover, most in `range` shadows \| midtones \| highlights, at `exposure` 0..1 (overlaps in one stroke never exceed it); `protectTones` keeps hue and saturation. Alpha kept. One undo step. Returns the layer, channel, `bounds` and dabs. |
| `burn` | As `dodge`, darkening. |
| `sponge` | Desaturate (`mode` desaturate, default) or saturate what `points` cover; `vibrance` damps clipping; passes compound, `brush.flow` sets each pass's strength. Pixels only. One undo step. Returns the layer, channel, `bounds` and dabs. |
| `blur_stroke` | Soften what `points` cover (`strength` 0..1 × brush opacity) on pixels or a mask. One undo step. Returns the layer, channel, `bounds` and dab count. Check with `capture_view`. |
| `sharpen_stroke` | Crisp what `points` cover (an unsharp mask at `strength`; keep it 0.2..0.5). One undo step. Returns the layer, channel, `bounds` and dab count. |
| `history_brush` | Paint the layer (or mask) back as it was `historySteps` undo steps ago (0 = oldest kept state) along `points`. Fails if the layer did not exist then. One undo step. Returns the layer, channel, `bounds` and dab count. |
| `get_retouch_options` | Read-only. The retouching defaults (`aligned`, `sample`, `spotType`, `range`, `exposure`, `protectTones`, `spongeMode`, `vibrance`, `strength`, `historySteps`) and the `cloneSource` `{x, y, offset}` or null (an aligned stroke samples at the brush plus `offset`; the editors show it as a crosshair). Call before a clone or heal stroke without `source`. |
| `set_retouch_options` | Set those defaults (view state, not an undo step); each stroke tool can override them per call. Changing `aligned` clears the kept offset. Returns the options. |
| `set_clone_source` | Set the clone source `{x, y}` in document px (the Alt-click), or remove it with `clear: true`. View state. The next `clone_stamp` / `heal_brush` fixes the offset from its first point. Returns the source. |
| `set_clone_transform` | The Clone Source panel: clone and heal strokes lay the source scaled (`scaleX` / `scaleY` in %, negative or `flipHorizontal` / `flipVertical` to mirror) and rotated (`rotate`°) about the stroke start; `reset: true` for 100 %, 0°. View state. Returns `{scaleX, scaleY, rotate}`. Use it for a reflection, a smaller copy or a tilted patch; read it back with `get_retouch_options`. |
| `fill_pixels` | Fill the selection (or the canvas without one / with `useSelection: false`) on pixels or a mask with `color`, `opacity`, `blend`. Returns the changed bounds. |
| `mix_colors` | Read-only. Mix 1 to 16 `colors` (`{color: #rrggbb, weight, strength?}`) like paint (Kubelka-Munk over reflectance spectra). Returns `mixed` (#rrggbb), `rgbLerp` (the plain RGB average, for comparison) and the normalised `weights`. Call it before `paint_stroke` / `fill_pixels` to pick a paint colour. |
| `clear_pixels` | Remove the selected pixels (alpha to 0; a transparency-locked layer or a mask gets the background colour). Returns the changed bounds. |
| `import_psd` | Open a PSD / PSB (`data` base64, a `data:` URL is fine) as the document, replacing the layers, crop and rotation (one undo step). Returns the new `layers` tree with ids, `layerIds`, size and `warnings` naming the affected layers. Call `inspect_psd` first when losses matter. |
| `apply_effect` | Run a provider filter effect on a layer as a smart filter (`target`, `effect`, `values`, `index`, `enabled`, `opacity`); a pixel, shape or type layer becomes a smart object in the same undo step (`converted`). With a selection the filter mask is set from it (`masked`): deselect first to filter the whole layer. Returns the filter id. |
| `update_effect` | Change an effect smart filter (`values` merged, `null` resets; `enabled`, `opacity`, `index`) or redraw an effect layer (`effect: "generator"`, values only). |
| `remove_effect` | Remove an effect smart filter, or (`generator`) keep an effect layer's pixels as a plain layer. |
| `add_effect_layer` | Add a layer drawn by a generator, overlay or title effect at the document's size and bit depth (`values`, `time`, `animate`, `name`, `aboveId` / `belowId`, `opacity`, `blend`). An effect with its own background (`backgroundOpacity` in `describe_effect`) starts with it transparent when there are layers below. Returns the layer id. |
| `set_effect_layer` | Change an effect layer: swap its `effect` (its defaults plus `values`), pick the still frame (`time`, ms), or make it play in an animation (`animate: { duration }`; `null` for a still frame). The longest animating layer sets the animation's length. |
| `apply_selection_as_mask` | Mask a layer with the current selection: pass `layerId` to mask an existing layer, or `kind` (plus optional `params`) to create a new masked layer in one step. `density` 0..1 and `feather` px soften the mask non-destructively. Returns `layerId`, kind, mask info and the selection summary. |
| `stroke_selection` | Edit › Stroke: a band `width` px (≤ 250) `outside` (default), `inside` or `center` on the selection edge, with `color`, `opacity`, `blend`, on a layer's pixels or mask (`channel`). One undo step. Returns the changed `bounds`. |
| `crop_to_selection` | Set the crop box to the selection's bounds (non-destructive; `reset_crop` undoes it). Returns the `crop`. |
| `content_aware_fill` | Remove what is selected by synthesising texture from around it on a pixel layer; `output` `new-layer` (keeps the fill separate, recommended) or `current`; `sampleRadius`, `seed` (another seed, another fill); the sampling area with `sampleRects`, `samplingChannelId` and `excludeRects` (never copy from these). Select with a 2–4 px margin. 8-bit only. Returns `layerId` and `bounds`. |
| `copy_pixels` | Copy the selected pixels of a layer (or with `merged` the visible image) to the editor clipboard, cropped to the selection with its soft edge. No undo step. Returns `width`, `height`, `x`, `y`. |
| `cut_pixels` | Copy, then clear the selected pixels (one undo step). Returns the size and position. |
| `paste_pixels` | Paste the clipboard as a new layer: `mode` `new-layer` (centred on the selection or canvas), `in-place`, `into` (masked by the selection) or `outside` (masked by its inverse). One undo step. Returns `layerId`, `bounds`, `masked`. |
| `save_selection` | Save the selection to a new alpha channel (`name`), or into `channelId` by `mode`. Saved with the document and in PSD. Returns the `channel`. |
| `load_selection_from_channel` | Load an alpha channel as the selection (`channelId`, `invert`, `mode`). Returns the summary. |
| `set_channel_properties` | Rename a channel or change its overlay `color`, `opacity`, `indicates` (`masked` / `selected`) and `visible`. Returns the `channel`. |
| `duplicate_channel` | Copy a channel (`name`, default "<name> copy"). Returns the copy. |
| `delete_channel` | Delete a channel (undoable). Returns the remaining channels. |
| `export_mask_image` | Read-only. The selection, a channel (`channelId`) or a layer's painted mask (`layerId`) as a greyscale PNG (white = selected), `invert`, `maxSide` (default 1024). Returns the image and its size. |
| `load_channel_from_image` | Store a mask image (`image` data URL / URL; `channel`, `threshold`, `invert`, `name`) in a new channel without changing the selection. Returns the `channel`. |
| `set_quick_mask` | Quick Mask mode (`enabled`): paint, fill and retouch tools without `layerId` edit the selection (white selects, black deselects); turn it off before painting layers. Returns the mode. |

### Save and open

The host may add the shared document tools (see `pixerate-agent-tools`). An image document is the saved state (layers, adjustments, crop, selection...) with layer pixels, masks and patterns as asset references; the source image stays the host's.

| Tool | Use |
| --- | --- |
| `get_image_document` | Take a copy of the whole image document as `{ kind, formatVersion, revision, document }` before a risky change, or to hand it on. Images in it are asset references (`pixerate-asset:...`), never pixel data, so it stays small. To look at the pixels use `render_preview` or `capture_view`. |
| `load_image_document` | Put back a copy from `get_image_document` in this session (its `document`, or the whole result). Checked first: a document whose assets are not loaded, or from a newer build, is refused and nothing changes. One undo step (`undo_image` brings the previous document back). To change part of the image use the layer and adjustment tools. |
| `save_image_document` | Save the image document and its assets under a `name` in the host's storage (the same name replaces that copy). Returns the `key`. Only listed when the host has storage. Save when the user asks, not after every edit. |
| `list_saved_image_documents` | List saved image documents (`key`, `name`, `savedAt`), newest first. |
| `open_saved_image_document` | Replace the image document with a saved one by `key`; its assets are read from storage first. Ask before opening over changes the user has not saved. |
| `find_unreferenced_image_assets` | See how much stored image data (assets of any saved image or paint document) nothing refers to any more, without deleting it. Returns `unreferenced`, `unreferencedChars` and up to 100 `refs`. The open document's assets always count as used. Only listed when the host's storage can list keys. Call it before `delete_unreferenced_image_assets`. |
| `delete_unreferenced_image_assets` | Free storage by deleting that data, all of it or only the `refs` from `find_unreferenced_image_assets`. Saved documents and autosave snapshots keep everything they use. Returns `removed`, `freedChars`, `kept`, `remaining`. Use it when the user asks to clean up or free space, not after every save: removing a saved document already collects its assets. A ref that is no longer unreferenced makes the call fail with nothing deleted; find again. |

## Pitfalls

- Agent playback (if on) opens each write's panel, then traces `points`, drags boxes or visits the layers and sliders named; results are unchanged.
- Effects need a shape: on an empty layer they draw nothing. They cannot go on adjustment layers. A clipped layer's effects stay inside the layer it is clipped to.
- `bevel-emboss` has no `blend` / `opacity`: it uses `highlightBlend`, `highlightOpacity`,
  `shadowBlend` and `shadowOpacity`. Inner shadows and inner glows use `choke`, not `spread`.
- Glows paint a colour or a gradient, never a pattern; strokes take all three. Pattern effects
  need a pattern id from `list_layer_effects.patterns`; an unknown id paints nothing.
- Effect angles are where the light comes *from*: 120° (top left) casts a shadow down and to
  the right. With `useGlobalLight` true an effect's own `angle` is ignored.
- A layer's `kind` cannot change; to switch kinds add a new layer and remove the old one.
  Curves points, `colorize` and colours are only set when the layer is added, so get them
  right in `add_adjustment_layer` (or replace the layer).
- Layer write tools refuse locked layers with the reason: unlock with `set_layer_properties`
  `locks` only when the user wants that layer changed.
- `merge_down`, `merge_visible` and `flatten_image` merge annotation layers only in a browser
  (they need a canvas); elsewhere they fail and say so.
- Retouching pitfalls (empty layers, sources, what ignores opacity): see references/retouching.md.
- `paint_stroke`, `fill_pixels` and `clear_pixels` need a visible pixel layer (or a layer with a
  raster mask and `channel: "mask"`); adjustment, group, shape, type, annotation and smart object layers can
  only be painted through their masks (and a smart object through `channel: "filter-mask"`).
  To paint a smart object's pixels, `edit_smart_object_contents` or rasterize it. A layer with
  `locks.pixels` refuses paint.
- Text ranges count UTF-16 code units (an emoji is two). Point text grows from its origin: centred
  text is centred on `x`. Type cannot be distorted, put in perspective or warped; it can be scaled,
  rotated and skewed. Where no font shaper exists (a server without one), type layers keep their
  stored pixels and edits are refused with a reason.
- Shape strokes are not layer-effect strokes: `stroke` on `add_shape_layer` / `update_shape`
  follows the path (and its dashes and caps); `add_layer_effect` `stroke` outlines the rendered
  pixels. Arrowheads belong to `line` live shapes (their `width` and `length` are pixels), not to
  strokes. A shape drawn over an annotation migrated from an old document (a shape layer with an
  `annotation` in `list_layers`) stops being that annotation once you edit it as a shape.
- Shapes render up to 512 px beyond the canvas; moving one in from far outside draws it again
  from its paths, so nothing is lost.
- While contents are open (`edit_smart_object_contents`), `list_layers` and every tool see the
  contents, not the document, and `export_psd` / saving write the document without the open
  edits. Close with `close_smart_object_contents` before anything else.
- Smart filters run over the canvas, like layer filters: a blur clamps at the canvas edge, and a
  smart object is drawn only up to 512 px beyond the canvas. `get_transform_frame` on a smart
  object returns the contents' rectangle (contents px) as the `frame`, and a warp `mesh` in
  contents px.
- `mix_colors` predicts a mix; it does not paint. To paint the mix, pass `blend: "pigment"` to
  `paint_stroke` (in `brush`) or `fill_pixels`, or set it on a layer.
- `pigment` has no PSD equivalent: `export_psd` writes those layers as Normal (the merged image
  keeps the look) and says so in `warnings`, naming the layers. `import_psd` never produces it.
  Over transparent pixels there is nothing to mix with, so it lays the colour down as Normal.
- The Mixer Brush ignores `brush.blend` (including `pigment`; use its own `mixer.mixing` instead) and the opacity ceiling: each dab lays paint at
  `flow × opacity` over the pixels as they are now, so overlapping dabs build up. At `flow` 1
  each dab covers what is under it, the pickup then sees mostly the brush's own paint, and the
  stroke drifts towards the loaded colour; lower the flow for more blending.
- An empty, dry mixer (no reservoir, `wet` 0) paints nothing; the call succeeds with
  `bounds: null`. A mixer stroke over transparent pixels has nothing to pick up.
- `export_psd` is in the source frame: a crop or rotation is not in the file (the warnings say
  so). Crop with `set_crop` only for PNG / JPEG output, or flatten the look you need first.
- PSD opacity, fill and mask density come in as whole percents (Photoshop stores bytes), so a
  layer at 0.8 exported and reopened is 0.8, but 0.333 becomes 0.33.
- `get_histogram` describes the last render, not the current state: render after edits, then
  read it.
- Crop coordinates are always in the un-rotated source; after `set_rotation` the output size
  swaps for quarter turns, but the crop box does not.
- `set_adjustments` clamps silently: always read `clamped`. If a value you needed was clamped,
  the correction needs a layer (e.g. levels or curves), not a bigger number.
- `tint` has no effect on process 1 edits (older saved documents); the result carries a note.
  Do not keep raising it; correct the green-magenta cast with a `colorBalance` layer instead.
- Base `opacity` fades the whole image, not an adjustment. Base `blur` blurs a whole layer (the
  Background by default, before the adjustment layers; in older documents with blur and
  adjustment layers, the output after them). It is not a local softening tool.
- New adjustment layers go above the other adjustment layers and below annotations, so they
  never tint arrows, labels or watermarks. `list_layers` shows where each one went.
- `invert` and `threshold` are destructive-looking creative effects; never use them for a
  correction the user did not ask for. Posterize `levels` below ~8 bands visibly.
- Transforms refuse hidden layers, layers with `locks.position` or `locks.pixels`, and adjustment,
  annotation and group layers (transform a layer's mask with `channel: "mask"` after unlinking
  it). A result larger than about 11 600 × 11 600 px is refused.
- `transform_layer` scale fields are percent (100 = unchanged), not factors; `rotate` is degrees
  clockwise. `corners` that cross or fold through the horizon are refused: keep the quad convex.
- With a selection, `content: "auto"` (the default) moves only the selected pixels, not the
  whole layer. Pass `content: "layer"` to move everything regardless of the selection.
- A Background transformed smaller leaves transparent canvas around it; fill it with a layer
  below or crop afterwards.
- Opacity values are 0..1, not percent. Curves and levels points are 0..255 levels; levels
  `gamma` is 0.1..9.99 (1 = neutral); hue is degrees -180..180.
