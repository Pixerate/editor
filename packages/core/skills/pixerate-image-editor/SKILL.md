---
name: pixerate-image-editor
description: How to colour-correct and retouch a photo in the Pixerate image editor through its agent tools - base adjustments (exposure, contrast, white balance temperature and tint, saturation, blur), non-destructive adjustment layers (curves, levels, hue/saturation, vibrance, color balance, black and white, photo filter, invert, posterize, threshold) with blend modes and opacity, selections (rectangle, ellipse, magic wand, color range, grow, shrink, feather, refine edge) and layer masks, crop, rotate and flip, undo, reading the histogram for clipping, and rendering a PNG preview to check the result. Use when asked to edit, grade, correct, brighten, warm up, desaturate, crop, straighten or mask an image, or when get_adjustments, set_adjustments, add_adjustment_layer, select_by_color or render_preview are available.
---

# Image editor

The image editor holds one source image plus a stack of edits that never touch the source
pixels: base adjustments (one value per control id), adjustment layers applied bottom to top
on top of the base, an optional selection, crop/rotate/flip and annotations. Rendering order:
base adjustments, then layers bottom to top (each through its mask, opacity and blend mode),
then blur. See `pixerate-agent-tools` for errors, namespacing and command batching.

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

## Tool reference

### Read

| Tool | Use it to |
| --- | --- |
| `get_adjustments` | Read the current state: `values` by control id, `process` version (1 or 2), and `layers` bottom to top with id, kind, params, opacity, blend, enabled and mask. Call first, and to find layer ids. |
| `list_controls` | Get every base control (id, label, section, min, max, step, default, `requiresProcess`), each layer kind's settable controls (plus `opacity`), the blend mode ids and the `layers.<layerId>.<controlId>` path format. Call once per session before writing. |
| `get_selection` | Read the active selection: `empty`, `bounds` (natural pixels), `area` in pixels, `percent` of the image and a description. Check it after every select or modify step and before masking: a wand that covered 90% of the image is the wrong selection. |
| `get_image_info` | Read the geometry: source `image` size, `crop` box (source pixels, or null), `rotation` degrees, `flipH` / `flipV`, the `output` size after crop and rotation, the layer count and `canUndo` / `canRedo`. Call before cropping or selecting so coordinates are right. |
| `get_histogram` | Judge exposure numerically: per channel and luminance `mean`, `p1` and `p99` (0..255), and `clipping` percent at pure black and white per channel. Reads the last render, so call `render_preview` first. `bins` (16, 32, 64 or 256) adds the counts. Cheaper than another image for checking a tonal change. |
| `render_preview` | See the edited image (crop, adjustments, layers, annotations) as a PNG. `maxSide` 16..2048 px, default 512. Images cost tokens: render after a group of edits, use 512 for overall look and 1024+ to judge clipping, edges and masks. Fails in environments without rendering. |

### Write

| Tool | Use it to |
| --- | --- |
| `set_adjustments` | Set base controls and existing layer parameters in one undo step: `values` is a map of control id or `layers.<layerId>.<controlId>` path to number; `label` is echoed. Values are clamped to range; returns `applied` and `clamped` (and a note when `tint` is set on a process 1 edit). Unknown ids fail and change nothing. Cannot set curves points, booleans or colours. |
| `add_adjustment_layer` | Add a layer on top of the stack: `kind` (curves, levels, hueSaturation, vibrance, colorBalance, blackWhite, photoFilter, invert, posterize, threshold), optional `params` merged with neutral defaults, `opacity` 0..1 (default 1), `blend` (default normal), `name`. Returns the layer (with its new id) and its stack index. The only tool that sets curves points, `colorize`, `preserveLuminosity`, a black and white `tint` or a photo filter `color`. |
| `select_region` | Select by `shape`: `rect` or `ellipse` (with `x`, `y`, `width`, `height` in natural pixels), `all`, `none` or `invert`. `mode` replace (default), add, subtract or intersect; `feather` px (default 0). Returns the selection summary. |
| `select_by_color` | Magic wand from a seed (`x`, `y`, `tolerance` 0..255 default 32, `contiguous` default true) or Color Range for every similar pixel (`color` "#rrggbb", `fuzziness` 0..200 default 40). `sampleMerged: true` samples the adjusted image instead of the source. `mode` as above. Use it for skies, backdrops and flat-coloured objects. |
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
| `apply_selection_as_mask` | Mask a layer with the current selection: pass `layerId` to mask an existing layer, or `kind` (plus optional `params`) to create a new masked layer in one step. `density` 0..1 and `feather` px soften the mask non-destructively. Returns `layerId`, kind, mask info and the selection summary. |

## Pitfalls

- A layer's `kind` cannot change; to switch kinds add a new layer and remove the old one.
  Curves points, `colorize` and colours are only set when the layer is added, so get them
  right in `add_adjustment_layer` (or replace the layer).
- `get_histogram` describes the last render, not the current state: render after edits, then
  read it.
- Crop coordinates are always in the un-rotated source; after `set_rotation` the output size
  swaps for quarter turns, but the crop box does not.
- `set_adjustments` clamps silently: always read `clamped`. If a value you needed was clamped,
  the correction needs a layer (e.g. levels or curves), not a bigger number.
- `tint` has no effect on process 1 edits (older saved documents); the result carries a note.
  Do not keep raising it; correct the green-magenta cast with a `colorBalance` layer instead.
- Base `opacity` fades the whole image, not an adjustment. Base `blur` blurs the whole output
  after all layers; it is not a local softening tool.
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
