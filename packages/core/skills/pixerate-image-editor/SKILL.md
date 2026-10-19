---
name: pixerate-image-editor
description: How to colour-correct, composite and retouch a photo in the Pixerate image editor through its agent tools - layers (pixel, adjustment, group and annotation layers with masks, clipping, blend modes, opacity and fill; merge, flatten, layer via copy, filters), live layer effects (shadows, glows, bevel and emboss, satin, overlays, strokes), base adjustments (exposure, contrast, white balance, saturation, blur), adjustment layers (curves, levels, hue/saturation, vibrance, color balance, black and white, photo filter, invert, posterize, threshold), selections (wand, color range, grow, shrink, feather, refine edge) and layer masks, crop, rotate and flip, undo, PSD, histogram and PNG previews. Use when asked to edit, grade, correct, brighten, warm up, crop, straighten or mask an image, add a shadow, glow or outline, or open or save a PSD, or when get_adjustments, set_adjustments, add_adjustment_layer, list_layers, add_layer_effect, paint_stroke, select_by_color, import_psd or render_preview are available.
---

# Image editor

The image editor holds a layer stack over a canvas the size of the source image. Opening an
image gives one pixel layer, **Background**, whose pixels are the source and whose `develop`
filter holds the base adjustments; adjustment layers sit above it (bottom to top, each through
its mask, opacity and blend mode) and every annotation is its own layer on top. `list_layers`
shows the whole stack. Edits never touch the source pixels. The base controls edit the develop
filter of the active pixel layer (the Background unless another pixel layer is active); base
`blur` blurs that layer (or, in documents saved before layers with blur and adjustment layers,
the output after the layers), and base `opacity` is the output's alpha. Pixel, annotation and
group layers can carry live effects (shadows, glows, bevels, overlays, strokes). Also an optional
selection and crop/rotate/flip. See `pixerate-agent-tools` for errors, namespacing and command
batching.

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
4. **Local edits:** select (`select_region`, `select_by_color`), refine (`modify_selection`,
   `refine_selection`), check with `get_selection` (area, percent, bounds), then
   `apply_selection_as_mask` with a `kind` to create the masked layer in one step.
5. **Verify.** `render_preview` after each group of corrections, not after each slider, then
   `get_histogram` (it reads the last render) for clipping. Compare against the previous
   preview; read the `applied` and `clamped` lists that writes return. `undo_image` takes back a
   step that made things worse.

### Working with layers

1. **Read the stack** with `list_layers`. A photo opened in the editor has only the Background;
   documents made elsewhere may have pixel layers, groups and masks. Note which layer is
   `active`: `set_adjustments` base controls edit the active pixel layer's `develop` filter.
2. **New content goes on its own layer**: `add_pixel_layer` (empty, a colour fill or a PNG at
   `x`, `y`), `layer_via_copy` to lift a selection onto a layer, `duplicate_layer` before a
   risky change. Name layers by intent.
3. **Shape layers non-destructively**: masks (`add_layer_mask` from the selection, or
   reveal-all / hide-all, softened with `density` / `feather`) instead of deleting pixels;
   `clipped: true` (via `set_layer_properties`) to limit a layer or adjustment to the layer below;
   `blend`, `opacity` and `fillOpacity` instead of baking.
4. **Organise** with `group_layers` (pass-through by default: blend modes inside still see the
   layers below; give the group a blend mode to isolate them), `move_layer` and
   `offset_layer`.
5. **Bake only when asked** (`merge_down`, `merge_visible`, `flatten_image`, `apply_layer_mask`):
   they are destructive. `render_preview` with `layerId` shows one layer alone.

### Layer effects

1. **Effects are live and per layer**: drop and inner shadows, outer and inner glows,
   bevel & emboss, satin, colour / gradient / pattern overlays and strokes go on pixel,
   annotation and group layers (not adjustment layers) and follow the layer's pixels as they
   change. Add them with `add_layer_effect` (`kind` plus only the `settings` that differ from
   Photoshop's defaults), tune them with `update_layer_effect` and read them back with
   `list_layer_effects`. Each call is one undo step and returns the layer's effects.
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

1. **Paint on its own layer** (`add_pixel_layer`), never on the Background, unless asked: a
   layer can be faded, masked, blended or deleted later. Painting the Background bakes it.
2. **Retouch through masks**: to hide part of a layer, add a mask and paint black on it
   (`paint_stroke` with `channel: "mask"`, `color: "#000000"`); paint white to bring it back.
   A soft brush (`hardness` 0..0.3) gives soft transitions.
3. **One stroke is one call and one undo step.** Send the path's points in order (a few points
   per brush diameter is enough; dabs are spaced by `brush.spacing`). Use `opacity` for the
   overall strength and `flow` for gradual build-up within the stroke.
4. **Limit paint with a selection** (select first, then `paint_stroke` / `fill_pixels`), or lock
   transparency (`set_layer_properties` `locks.transparency`) to paint only where the layer
   already has pixels.

### Photoshop files

1. **Inspect before opening.** `inspect_psd` lists every layer with the type it would become and
   a status: `mapped` (held exactly), `approximated` (type, smart-object, fill and shape layers
   come in as their stored pixels; layer effects are not rendered; Dissolve becomes Normal) or
   `dropped` (Brightness/Contrast, Exposure, Channel Mixer, Gradient Map, Selective Color and
   Color Lookup adjustments). Tell the user what would be lost before `import_psd` when anything
   is not `mapped`.
2. **`import_psd` replaces the document** (one undo step). CMYK, Lab, grayscale, indexed, 16-bit
   and 32-bit files are converted to 8-bit RGB, and ICC profiles are ignored; the warnings say
   so. Afterwards work with `list_layers` as usual: there is no Background source image, every
   pixel comes from the layers.
3. **`export_psd` writes the stack as it is**, in the source frame: crop and rotation are not
   applied, layer filters and depth masks are baked, annotation layers are rasterized (only in
   a browser). Read its `warnings` and pass them on. The file comes back as base64 (`data`).

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
- **Masks: select, refine, then mask.** Clean the selection before masking: `smooth` for
  jagged wand edges, `refine_selection` for hair and soft edges, feather in proportion to the
  image (a few px for hard objects, tens of px for sky or vignette transitions). Use the mask's
  own `feather` and `density` on `apply_selection_as_mask` so softening stays adjustable.
- **Blend modes for tone-only or colour-only changes:** `luminosity` applies a curves or
  levels layer without shifting hue or saturation; `color` applies a tint without changing
  brightness; `soft-light` / `overlay` for gentle contrast.
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
| `list_layers` | Read the layer stack bottom to top as a tree: id, type (`pixel`, `adjustment`, `group`, `annotation`), name, document `bounds` of pixel layers, visibility, opacity, `fillOpacity`, blend, `clipped`, locks, a `mask` summary, an `effects` summary (master switch, scale, effect ids and kinds), pixel-layer `filters` (the Background's `develop` filter is the base adjustments), adjustment `kind` and `params`, group `children`, and which layer is `active`. Call it to understand a document with more than the Background before changing it; adjustment layer ids work with every adjustment-layer tool. |
| `list_layer_effects` | Read one layer's effects: `enabled` (master switch), `scale` (Scale Effects), `margin` (px they reach beyond the shape), `fromPsd`, and every effect with `id`, `kind`, `label` and all its settings. Also returns the `globalLight`, the `patterns` pattern effects can use and the effect `kinds`. Call before changing effects you did not add. |
| `get_image_info` | Read the geometry: source `image` size, `crop` box (source pixels, or null), `rotation` degrees, `flipH` / `flipV`, the `output` size after crop and rotation, the layer count and `canUndo` / `canRedo`. Call before cropping or selecting so coordinates are right. |
| `get_histogram` | Judge exposure numerically: per channel and luminance `mean`, `p1` and `p99` (0..255), and `clipping` percent at pure black and white per channel. Reads the last render, so call `render_preview` first. `bins` (16, 32, 64 or 256) adds the counts. Cheaper than another image for checking a tonal change. |
| `render_preview` | See the edited image (crop, adjustments, layers, annotations) as a PNG, or with `layerId` one layer alone. `maxSide` 16..2048 px, default 512. Images cost tokens: render after a group of edits, use 512 for overall look and 1024+ to judge clipping, edges and masks. Fails in environments without rendering. |
| `inspect_psd` | Read a PSD / PSB (`data` base64) without opening it: size, `depth`, `colorMode`, `resolution`, every layer bottom first with `psdKind`, the `type` it would become and `status` (`mapped`, `approximated`, `dropped`) with `notes`, and the import `warnings`. Call before `import_psd`. |
| `export_psd` | Save the document as an 8-bit RGB PSD (PSB above 30000 px) with layers, groups, adjustment layers and masks. Returns `data` (base64), `size` in bytes, `psb` and `warnings` (crop or rotation not applied, filters and depth masks baked, annotations rasterized or left out). Changes nothing. |
| `capture_view` | Inspect detail in natural image pixels (the space of `get_selection` and `select_region`, before crop and rotation): `region` `content` (whole image, default), `selection` or `rect`; small regions are enlarged up to 8× with hard pixel edges, so a 64 px rect shows real pixels. `includeOverlays: true` shades unselected pixels and outlines the crop: use it to check a mask's edge before `apply_selection_as_mask`. Returns the `rect` and `scale`. Use `render_preview` for the final framed result. |

### Write

| Tool | Use it to |
| --- | --- |
| `set_adjustments` | Set base controls and existing layer parameters in one undo step: `values` is a map of control id or `layers.<layerId>.<controlId>` path to number; `label` is echoed. Values are clamped to range; returns `applied` and `clamped` (and a note when `tint` is set on a process 1 edit). Unknown ids fail and change nothing. Cannot set curves points, booleans or colours. |
| `add_adjustment_layer` | Add a layer above the other adjustment layers and below annotations (or directly above `aboveId`, or at the top of group `parentId`): `kind` (curves, levels, hueSaturation, vibrance, colorBalance, blackWhite, photoFilter, invert, posterize, threshold), optional `params` merged with neutral defaults, `opacity` 0..1 (default 1), `blend` (default normal), `name`. Returns the layer (with its new id) and its stack index. The only tool that sets curves points, `colorize`, `preserveLuminosity`, a black and white `tint` or a photo filter `color`. |
| `select_region` | Select by `shape`: `rect` or `ellipse` (with `x`, `y`, `width`, `height` in natural pixels), `all`, `none` or `invert`. `mode` replace (default), add, subtract or intersect; `feather` px (default 0). Returns the selection summary. |
| `select_by_color` | Magic wand from a seed (`x`, `y`, `tolerance` 0..255 default 32, `contiguous` default true) or Color Range for every similar pixel (`color` "#rrggbb", `fuzziness` 0..200 default 40). `sampleMerged: true` samples the adjusted image instead of the source; `sample: "active-layer"` samples only the active pixel layer (pick it with `set_active_layer`) instead of the whole image. `mode` as above. Use it for skies, backdrops and flat-coloured objects. |
| `modify_selection` | Grow, shrink, feather, border or smooth the selection (`op`) by `radius` px (0..500). Use shrink then feather to keep an adjustment from bleeding over an edge; smooth to remove wand speckle. Fails when nothing is selected. |
| `refine_selection` | Refine Edge: snap the selection edge to image edges within `radius` px (0..64, default 8), with `smartRadius`, `smooth` 0..100, `feather` px, `contrast` 0..100 and `shiftEdge` -100..100 %. Use on hair, fur, foliage or after loading a coarse AI mask. |
| `update_adjustment_layer` | Change a layer's `enabled` (false hides it without deleting), `blend`, `opacity` (0..1) or `name` in one undo step. Returns the layer. Its parameters change with `set_adjustments`. Toggle `enabled` to compare a layer's effect before and after. |
| `move_adjustment_layer` | Move a layer to index `to` (0 = bottom, applied first; past the top means top). Order matters: a curves layer above a hue/saturation layer works on its output. Fails when the layer is already there. Returns the ids bottom to top. |
| `remove_adjustment_layer` | Delete a layer and its mask. Prefer hiding it with `update_adjustment_layer` when the user may want it back. Returns the remaining ids. |
| `set_crop` | Crop to `x`, `y`, `width`, `height` in source pixels of the un-rotated image (see `get_image_info`). Non-destructive; refused if the box leaves the image. For an aspect ratio, compute the largest box of that ratio inside the image and centre it on the subject. Returns the geometry. |
| `reset_crop` | Remove the crop and show the whole image again. |
| `set_rotation` | Set the absolute rotation in degrees clockwise (-360..360). Quarter turns keep every pixel; small angles straighten a horizon but add transparent corners to crop away. Returns the geometry. |
| `flip_image` | Mirror the image `horizontal` (left-right) or `vertical`. Avoid flipping images with text, logos or recognisable places. |
| `undo_image` | Undo the last edit (one tool call is one step). Returns `canUndo` / `canRedo`. |
| `redo_image` | Redo the edit you just undid. |
| `set_active_layer` | Make a layer active (`layerId`) and choose the paint `target` (`pixels` or `mask`). Base sliders then edit that pixel layer's develop filter. Not an undo step. Returns the layer. |
| `add_pixel_layer` | Add a pixel layer above the active layer (or at `aboveId` / `belowId` / `parentId` / `index`): empty, `color` `#rrggbb[aa]` over the canvas, or `image` (PNG data URL or base64; other formats only in a browser) at `x`, `y`; with `name`, `opacity`, `blend`. Returns the layer with its id and bounds. |
| `duplicate_layer` | Copy a layer (groups with their children) directly above it, e.g. before a destructive change. Returns the copy. |
| `remove_layer` | Delete a layer or group (refused when locked). Prefer hiding with `set_layer_properties`. Returns the remaining top-level ids. |
| `move_layer` | Reorder: give exactly one of `aboveId`, `belowId`, `parentId` (into a group, optional `index`) or `index` alone. Returns the new `parentId` and `index`. |
| `set_layer_properties` | Change `name`, `visible`, `opacity`, `fillOpacity`, `blend` (`pass-through` for groups), `clipped`, `locks` or `collapsed`. Only given fields change. Returns the layer. |
| `group_layers` | Put sibling layers (`layerIds`) into a new pass-through group at the topmost one's position. Returns the group and its children. |
| `add_group` | Add an empty group (pass-through unless `blend` is given) above the active layer or at a placement, then move layers into it with `move_layer` `parentId`. Returns the group. |
| `ungroup_layer` | Replace a group by its children (its own opacity, blend and mask are dropped). Returns the child ids. |
| `merge_down` | Composite a layer onto the pixel layer below it (masks, fill and filters baked). Destructive; see Best practices. Returns the merged layer. |
| `merge_visible` | Composite all visible top-level layers into one layer; hidden ones stay. Destructive. |
| `flatten_image` | Composite everything visible into one Background; hidden layers are discarded. Destructive; do it only when asked. |
| `offset_layer` | Move a pixel layer and its mask to `x`, `y` or by `dx`, `dy` (integers, document px). Refused when its position is locked. Returns the offset and bounds. |
| `add_layer_mask` | Mask any layer `from` `reveal-all`, `hide-all` or `selection`, with optional `density` / `feather`. Replaces an existing mask. Returns the mask summary. |
| `set_layer_mask_properties` | Change any layer mask's `density`, `feather` or `enabled` without touching its pixels. |
| `apply_layer_mask` | Bake a pixel layer's mask into its alpha and remove it. Destructive. |
| `remove_layer_mask` | Delete a mask without applying it; disable it instead to keep it. |
| `layer_via_copy` | Copy the selected pixels of a pixel layer (default the active one) to a new layer above it; `cut: true` removes them from the source. Needs a selection. Returns the new layer. |
| `rasterize_layer` | Turn an annotation layer into pixels (same id and properties; browser only) or bake a pixel layer's develop / blur filters into its pixels. Do it before painting over an annotation, or when the user wants the filters fixed. Destructive. |
| `add_layer_filter` | Add a live `develop` (brightness … tint) or `blur` (`radius`) filter to a pixel layer; one of each kind. Returns the filters with ids. |
| `update_layer_filter` | Change a filter's values (`filterId` from `list_layers`). Returns the filters. |
| `remove_layer_filter` | Remove a filter. Returns the remaining filters. |
| `add_layer_effect` | Add an effect to a pixel, annotation or group layer: `kind` (`drop-shadow`, `inner-shadow`, `outer-glow`, `inner-glow`, `bevel-emboss`, `satin`, `color-overlay`, `gradient-overlay`, `pattern-overlay`, `stroke`) and `settings` that differ from Photoshop's defaults (a setting the kind does not have is refused with its list of settings); optional `index` in the effect list. Returns `effectId` and the layer's effects. |
| `update_layer_effect` | Change settings of one effect (`effectId`); nested `fill`, `gradient`, `contour` and `texture` objects replace whole, `null` removes an optional `contour`, `glossContour`, `contourElement` or `texture`. The kind cannot change. Returns the effects. |
| `remove_layer_effect` | Delete one effect. To hide it and keep its settings, set `enabled: false` with `update_layer_effect` instead. Returns the remaining effects. |
| `set_layer_effects_enabled` | Switch all of a layer's effects on or off (`enabled`) and optionally set Scale Effects (`scale`, 1 = 100 %, multiplies sizes, distances and pattern scales). Returns the effects. |
| `set_global_light` | Set the document light (`angle`, `altitude` in degrees) that every shadow and bevel with `useGlobalLight` follows. Returns the light. |
| `paint_stroke` | Paint (`tool` brush) or erase (`tool` eraser) along `points` in document px (optional `pressure` 0..1) on a pixel layer or its mask (`channel`); `color` #rrggbb (on a mask: black hides, white reveals); `brush` `{size, hardness, spacing, angle, roundness, opacity, flow, smoothing, pressureSize, pressureOpacity, blend}`. The selection limits the paint. One undo step per call. Returns the layer, channel, changed `bounds` and dab count. |
| `fill_pixels` | Fill the selection (or the canvas without one / with `useSelection: false`) on pixels or a mask with `color`, `opacity`, `blend`. Returns the changed bounds. |
| `clear_pixels` | Remove the selected pixels (alpha to 0; a transparency-locked layer or a mask gets the background colour). Returns the changed bounds. |
| `import_psd` | Open a PSD / PSB (`data` base64, a `data:` URL is fine) as the document, replacing the layers, crop and rotation (one undo step). Returns the new `layers` tree with ids, `layerIds`, size and `warnings` naming the affected layers. Call `inspect_psd` first when losses matter. |
| `apply_selection_as_mask` | Mask a layer with the current selection: pass `layerId` to mask an existing layer, or `kind` (plus optional `params`) to create a new masked layer in one step. `density` 0..1 and `feather` px soften the mask non-destructively. Returns `layerId`, kind, mask info and the selection summary. |

## Pitfalls

- Effects need a shape: on an empty layer they draw nothing. They cannot go on adjustment
  layers. A clipped layer's effects stay inside the layer it is clipped to.
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
- `paint_stroke`, `fill_pixels` and `clear_pixels` need a visible pixel layer (or a layer with a
  raster mask and `channel: "mask"`); adjustment, group and annotation layers can only be
  painted through their masks. A layer with `locks.pixels` refuses paint.
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
- Selection coordinates ignore crop and rotation: they are source-image pixels. A rectangle in
  the cropped preview's coordinates lands in the wrong place on a cropped image.
- `select_by_color` without `x`/`y` or `color` fails. Large `tolerance` / `fuzziness` floods the
  selection: start low (wand 20..40, range 30..60), check `percent`, and add with `mode: add`.
- `modify_selection`, `refine_selection` and `apply_selection_as_mask` fail with "Nothing is
  selected." when the selection is empty; select first.
- Opacity values are 0..1, not percent. Curves and levels points are 0..255 levels; levels
  `gamma` is 0.1..9.99 (1 = neutral); hue is degrees -180..180.
