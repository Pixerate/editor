---
name: pixerate-image-selection-masking
description: The selection and masking workflow in the Pixerate image editor - cutting out a subject, removing or replacing a background, selecting hair, fur or sky, limiting an adjustment, filter or paint to part of an image, and making, feathering, refining, inverting, loading or checking masks. Use when asked to cut out, isolate, extract or mask something, replace a sky or background, adjust or sharpen only part of a photo, make a vignette, or when select_rect, magic_wand, select_color_range, select_subject, refine_selection or add_layer_mask are available. Load with pixerate-image-editor, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-image-editor
---

# Selection and masking

A selection is an 8-bit soft mask over the source image (0 = not selected, 255 = selected,
values between are partly selected). It limits painting, fills, Layer via Copy and Free
Transform, and becomes a layer mask with `apply_selection_as_mask` or `add_layer_mask`.
Coordinates are natural pixels of the source image, before crop, rotation and flips. Read
`get_selection` bounds or `get_image_info`, never screen pixels.

This skill is the method. `pixerate-image-editor` has the full tool reference.

## Goal and quality bar

- The selection covers the subject and nothing else. `percent` and `bounds` agree with what you
  expect before you mask anything.
- Edges match the subject: hard objects stay crisp (anti-aliased, 0–2 px feather), while hair,
  fur, foliage and glass have soft, refined edges.
- There is no halo of the old background around a cutout, and no hard line where a local
  adjustment stops.
- The result stays editable. Use masks rather than deleted pixels, and mask feather and density
  rather than a baked blur. Bake only when the user asks.

## Inputs to confirm

- **What** to select, in words, and **what for**: a cutout (layer), a local adjustment, a
  background swap, or a filter on part of the image.
- **Which layer** to act on (`list_layers`, `set_active_layer`).
- **Hard or soft edge** when it is not obvious (a product shot, or a portrait with loose hair).

## Working method

1. **Choose the method by subject** (see the decision table).
   **Check:** `get_selection` → `empty: false` and a plausible `percent` (for a person in a
   portrait, typically 15–50 %). A wand or range above about 80 % has flooded: undo, then lower
   `tolerance` / `fuzziness`.
2. **Build it in steps** with `mode`: start with `replace`, `add` what was missed, `subtract`
   what leaked, and `intersect` to limit it to a region (for example `select_rect` around the
   subject).
   **Check:** `bounds` hug the subject. A bounds as large as the image means a leak. Smart tools
   return `uncertainRegions` (edge with no image edge under it): look there, refine with `regions`.
3. **Measure the edge, then look.** `inspect_mask_edge` scores it: `haloScore` ≥ 0.35 is old
   background inside the edge, `edgeAlignment` < 0.5 is off the image's edges, `jaggedness` ≥ 15
   zigzags; it counts `holes` and `islands`, `issues` names fixes, `worst` gives `capture_view` rects.
   **Check:** `issues` is empty, or each one is intended (a deliberately soft edge or a second piece).
4. **Clean it up.**
   - `modify_selection` `smooth` (2–4 px) removes wand speckle.
   - `grow_selection` (tolerance 10–30) picks up the shades a wand click missed;
     `select_similar` adds the same colours elsewhere in the image.
   - `contract` 1–2 px pulls the edge off a halo.
   - Paint it directly: `set_quick_mask` `enabled: true`, then `paint_stroke` without
     `layerId` (white adds, black removes, a soft brush feathers; `blur_stroke` softens a part
     of the edge), then `set_quick_mask` `enabled: false`.
   - `refine_selection` snaps to real edges: radius 2–4 for hard edges, 8–20 for hair and fur;
     `smartRadius: true` for mixed edges. For flyaway hair beyond the radius, add `edits` with a
     `refine-brush` stroke along it (size covering the strands); fix misses and leaks in the same
     call with `quick-select`, `brush` or `lasso` strokes, or an `object` box (`mode:
     "subtract"` to remove). These are the Select and Mask workspace's own tools, so a person
     can open the same edits in the workspace. With a host model, `refineMode: "object"`
     refines from the model's outline.
   - `shiftEdge` −10..−30 % tightens a refined edge that picked up background.
   **Check:** `compare_selections` after the step: `added` / `removed` are what you meant and
   `iou` stays near 1 for a cleanup (it tints the change on the canvas).
5. **Output.** Choose by goal:
   - A local adjustment: `add_adjustment_layer` while the selection is active (it is masked
     by it), or `apply_selection_as_mask` with `kind`. Filters (`apply_effect`,
     `add_smart_filter`) are also limited to an active selection.
   - A cutout: `layer_via_copy` (the original stays), or `add_layer_mask` `from: "selection"` on
     the layer itself. For a hard geometric or traced edge that must stay sharp and editable
     (a product, a screen, a window), `add_vector_mask` with the path instead (`from:
     "selection"` traces the current selection); it moves and transforms with the layer, and
     `rasterize_vector_mask` turns it into paintable pixels. Trace with `tolerance` 0.5–1 px for
     a tight edge; check the result with `set_mask_view` before you go on.
   - Painting or fills inside it: keep the selection active and paint; `stroke_selection` for
     an outline that follows it.
   - Removing what it covers: `content_aware_fill` `output: "new-layer"`.
   - A copy elsewhere: `copy_pixels`, then `paste_pixels` (`into` masks it by a selection).
   Soften with the mask's own `feather` / `density` rather than `modify_selection` `feather`, so
   it stays adjustable.
6. **Store.** `save_selection` with a clear name before you change a selection that took
   work, and whenever it will be needed again (a second adjustment, a later refinement). Load
   it with `load_selection_from_channel`; channels are saved with the document and in PSDs.
   To hand a mask to another tool or service, or to look at it alone, `export_mask_image`
   writes the selection, a channel or a layer mask as a greyscale PNG; a matte that comes
   back goes into a channel with `load_channel_from_image` (or straight to the selection with
   `load_selection_from_image`).
7. **Verify.** `inspect_mask_edge` again (`target: "layer-mask"` and `layerId` for a mask),
   `render_preview` at 1024 px or more, and `capture_view` on `worst` regions at 2–8×.
   **Check:** no fringe of the old background colour, no stair-steps, no visible line where an
   adjustment ends. To judge a layer mask itself, `set_mask_view` `gray` (or `overlay`) and
   `capture_view` with `includeOverlays: true`; holes and stray grey show plainly there. Set it
   back to `off` afterwards. Fix by loading the mask back (`load_selection_from_mask`), refining, and
   masking again.

## Decision table

| Subject | Method |
| --- | --- |
| Geometric areas: a frame, a screen, a band | `select_rect` / `select_ellipse`, with `feather` for soft transitions |
| One object among others, where you can box it (a product on a table, a person in a group) | `select_object` with a `rect` a little larger than the object on every side; then `quick_select` add / subtract strokes for what it missed |
| A subject with a clear outline (product, person, animal) | `select_subject` (with a host model, by description; without one it takes whatever stands out most, so check `method` and the result); else `select_object` around it, or `select_polygon` with `snapToEdges` (12–30 points within `width` of the edge), then `refine_selection`; hard sides and loose hair in one mask: `add_vector_mask` `from: "selection"`, then `set_vector_mask_edge` `matte` on the hair segments |
| An area or subject that differs from its surroundings (a shirt, a sky, a car) | `quick_select` with strokes painted inside it, away from the edge (`size` a fraction of its width); `add` / `subtract` strokes where it fell short or leaked |
| The sky (to replace, recolour, or to leave out with `invert_selection`) | `select_sky`; raise `threshold` for haze or a sunset glow, lower it if pale buildings come in |
| A sharp subject on a blurred background (shallow depth of field) | `select_focus_area`; raise `range` if parts of the subject are missing, `noise` if grainy background comes in |
| A low-contrast or busy outline the edges don't follow | `select_polygon` without `snapToEdges`, along the contour (20–60 points) |
| Flat backdrop or solid colour (studio white, green screen, sky without clouds) | `magic_wand` on the backdrop (`tolerance` 20–40; `distance: "perceptual"` for gradients), then `invert_selection` |
| A colour spread across the image (all the reds, a dress) | `select_color_range` with `samples` (several picks) or a hue `preset`; `localized` to keep one area |
| Tones (shadows, highlights, a luminosity mask) | `select_color_range` with `preset` `shadows` / `midtones` / `highlights` |
| Skin for retouching | `select_color_range` `preset: "skinTones"`, then `intersect` with a box around the face |
| An AI matte or saved mask from the host | `load_selection_from_image` (soft: no `threshold`), then `refine_selection`; `load_channel_from_image` to keep it for later |
| An existing layer mask | `load_selection_from_mask` (`source: "vector"` for a vector mask) |
| A cutout, shape or text already on its own layer | `select_layer_transparency` (exact, soft where the layer is) |
| A dead pixel row or column | `select_line`, then fill or heal it |
| Smooth curves you can describe (a logo, a road, a lens) | `path_to_selection` with Bézier `subpaths` or SVG path data |
| Letters (photo-filled text, text cut out of the image) | `select_text_shape` (check fonts with `list_fonts`), then `add_layer_mask` or `layer_via_copy` |

## Recipes

- **Cut out a subject onto a new background:** select (table), `refine_selection` with `output:
  "new-layer-with-mask"`, put the new background under it (`add_pixel_layer`, `move_layer`). Fix
  the fringe live on the masked layer: `set_edge_decontamination` 80–100, `set_edge_despill` 50–100
  for a coloured backdrop, `set_edge_ambient` 20–50 to take on the new scene's colour. Re-run
  `inspect_mask_edge`; if `haloScore` stays high, `contract` the mask 1 px.
- **Replace the sky:** `select_sky` (or `magic_wand` / `select_color_range` `preset: "blues"`
  if it finds none), `add` missed patches, `refine_selection` radius 8–16 along the horizon and trees, then
  `add_layer_mask` on the new sky layer. Match it with a clipped curves layer (`clipped: true`).
- **Adjust only part of an image:** select, then `apply_selection_as_mask` with `kind` and
  `params`, and `feather` in proportion to the image (a few px for objects, 50–200 px for
  broad light).
- **Vignette:** `select_ellipse` inset 5–10 % from the edges, `invert_selection`, then
  `apply_selection_as_mask` `kind: "curves"` (darken), with the mask `feather` at 15–25 % of
  the short side.
- **Graduated filter:** `select_rect` over the top third with a large `feather`, then a curves or
  hue/saturation layer through the mask.
- **Hide part of a layer:** `add_layer_mask` (`hide-selection` hides what is selected), or paint
  black on the mask with `paint_stroke` `channel: "mask"` and a soft brush (`hardness`
  0..0.3); paint white to bring it back. Never erase.
- **Edit a cutout's edge:** `add_layer_mask` `from: "transparency"` moves the layer's alpha into
  a mask you can refine and repaint.
- **Dodge and burn through masks:** an adjustment layer with a `hide-all` mask
  (`add_layer_mask`), then paint white on it with `paint_stroke` `channel: "mask"`, at low
  opacity.
- **Selective sharpening or blur:** select, then `set_smart_filter_mask` `from: "selection"` on
  a smart object's filters.
- **Clip a texture or colour to a layer:** put it directly above and set `clipped: true` with
  `set_layer_properties`; no selection is needed.
- **Remove an object:** select it with a 2–4 px margin (`modify_selection` `expand`), then
  `content_aware_fill` `output: "new-layer"`; try another `seed` if the fill repeats texture,
  and mask out what is wrong. If it copies in something it shouldn't (a person, a sign), pass
  `excludeRects` over that, or `sampleRects` over the background it should continue.
- **Outline a cutout:** `select_layer_transparency` on it, then `stroke_selection`
  `location: "outside"` on a new layer below it.
- **Crop to a subject:** select it, then `crop_to_selection` (non-destructive).
- **Put a picture into a shape:** select the shape, `copy_pixels` the picture, `paste_pixels` `mode: "into"`.
- **Move, scale or relight a subject in its own scene:** select it, then `separate_subject`: a masked
  subject layer over a background plate with the hole filled; refill a bad patch from `fillChannelId`.
- **Picture inside a frame:** mask the picture with the frame's shape, then
  `set_layer_mask_properties` `linked: false` so the picture moves under a fixed mask; link it
  again afterwards.

## Pitfalls

- **Flooding:** a wand or range that covers most of the image. Start low (wand 20–40, range
  30–60), check `percent`, and grow with `mode: "add"`.
- **Box instead of outline:** `select_rect` around a subject masks its background too. Trace
  the contour.
- **Select Subject without a model picks the wrong thing:** it selects what stands out most from
  the image's border, which may be a bright sign rather than the person. When `method` is
  `saliency`, check with `capture_view`; if it's wrong, use `select_object` with a box.
- **Object Selection takes part of the background:** without a model, anything in the box unlike
  the background around it is the object (a shadow, mist). Leave background on every side (none
  past the image's edge), then `subtract` a `quick_select` stroke. `point` may stop at an inner
  edge, miss background-coloured parts, or take a patch a small object sits in: box small ones.
- **Quick Selection spills over a weak edge:** a stroke grows into neighbouring areas of a
  similar colour. Paint smaller strokes further from the edge, then a `subtract` stroke on the
  spill. Strokes near an edge also pull in the other side.
- **Magnetic outline jumps to the wrong edge:** `snapToEdges` follows the strongest edge near
  each point, which can be a shadow or a texture. Put points within `width` of the edge you
  want, add points where it turns or runs past another edge, raise `contrast` on a busy
  background, and drop `snapToEdges` where the edge is too faint.
- **Over-feathering hard objects:** a 10 px feather on a product looks like a glow. Keep hard
  edges at 0–2 px and refine soft ones instead.
- **Halo:** the old background shows as a light or dark fringe. `set_edge_decontamination` on the
  masked layer (live) for soft edges; for hard ones `contract` 1–2 px or
  `shiftEdge` negative before masking.
- **Baking too early:** `apply_layer_mask`, `merge_down` and `layer_via_copy` with `cut: true`
  are hard to revise. Keep masks until the user is happy.
- **Expand is not Grow:** `modify_selection` `expand` moves the edge by distance;
  `grow_selection` adds similar colour. Use the one that matches the problem.
- **Deselected by mistake:** `reselect` brings it back (or `undo_image`).
- **Empty selection:** `modify_selection`, `refine_selection` and `apply_selection_as_mask` fail
  on it. Select first.
- **A forgotten selection limits new layers and filters:** `add_adjustment_layer`,
  `apply_effect` and `add_smart_filter` mask themselves by it. `deselect` first for a global
  change, or pass `useSelection: false`.
- **Quick Mask left on:** while it is on, `paint_stroke` and `fill_pixels` without `layerId`
  edit the selection, not the image. Turn it off when the selection is done.
- **Hidden selection still applies:** with `set_selection_display` `none`, paint and fills are
  still limited to it. `deselect` before a whole-layer edit.
- **Wrong coordinates:** use natural image pixels, not preview pixels. On a cropped or rotated
  image, a rectangle measured in the preview lands in the wrong place.
- **Deprecated tools:** `select_region` and `select_by_color` still work, but use the tools
  below.

## Tools used

- `get_selection`: empty, bounds, area and percent after every step
- `select_all`, `deselect`, `invert_selection`: whole-image selections
- `select_rect`, `select_ellipse`, `select_line`: marquees, and a single row or column
- `select_polygon`: the lasso, along a contour; with `snapToEdges`, the Magnetic Lasso
- `quick_select`: brush strokes that grow out to the region's edges
- `select_object`: the object in a box or under a point
- `select_focus_area`: what is in focus
- `select_sky`: the sky
- `select_layer_transparency`: a layer's own pixels
- `grow_selection`, `select_similar`: add similar colour, connected or anywhere
- `reselect`: undo a deselect
- `save_selection`, `load_selection_from_channel`, `list_channels`, `set_channel_properties`, `duplicate_channel`, `delete_channel`: keep and manage selections as alpha channels
- `export_mask_image`: a selection, channel or layer mask as a greyscale PNG
- `load_channel_from_image`: a mask image into a new channel
- `set_quick_mask`: paint the selection
- `fill_pixels`, `blur_stroke`: fill or soften the selection in Quick Mask mode
- `magic_wand`: similar colour from a seed
- `select_color_range`: colour samples, hue, tone and skin presets
- `select_subject`: a subject by description with a host model; without one, the most salient subject
- `load_selection_from_image`: AI or saved mattes
- `load_selection_from_mask`: a layer mask back to a selection
- `set_selection_display`: ants, Quick Mask tint or hidden
- `set_mask_view`: a layer mask alone in grey or as a red overlay, to check it
- `add_vector_mask`, `set_vector_mask_path`, `set_vector_mask_properties`, `get_vector_mask`: sharp, editable path masks
- `rasterize_vector_mask`, `remove_vector_mask`: turn a vector mask into pixels, or drop it
- `selection_to_path`, `path_to_selection`: a selection's outline as Bézier paths, and a path back into a selection
- `select_text_shape`: the Type Mask, a selection in the shape of text
- `modify_selection`: expand, contract, feather, border, smooth
- `refine_selection`: snap the edge to the image
- `transform_selection`: move or scale the outline only
- `inspect_mask_edge`, `compare_selections`: measure an edge (halo, alignment, jaggedness, holes, islands) and what a step changed (IoU)
- `set_edge_decontamination`, `set_edge_despill`, `set_edge_ambient`, `get_edge_color`: live edge colour on a masked cutout
- `capture_view`, `render_preview`: look at the edge at pixel level; check the result
- `apply_selection_as_mask`: a masked adjustment layer in one step
- `add_layer_mask`, `set_layer_mask_properties`, `apply_layer_mask`, `remove_layer_mask`: layer masks
- `set_smart_filter_mask`: limit smart filters
- `layer_via_copy`: lift the selection onto a new layer
- `stroke_selection`, `crop_to_selection`: an outline along the selection edge; crop to its bounds
- `content_aware_fill`, `separate_subject`: remove what is selected; split a subject from a filled background
- `copy_pixels`, `cut_pixels`, `paste_pixels`: the editor clipboard
- `add_adjustment_layer`, `apply_effect`, `add_smart_filter`: masked by an active selection
- `paint_stroke`: paint on a mask with `channel: "mask"`
- `undo_image`: take back a step
- `set_layer_properties`: clipping
