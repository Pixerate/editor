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
   **Check:** `bounds` hug the subject. A bounds as large as the image means a leak.
3. **Look at the edge.** Use `capture_view` with `region: "selection"` and `includeOverlays: true`,
   or `set_selection_display` `quickMask`, to see soft edges as a tint.
   **Check:** no holes in the subject, no islands in the background, and edges on the subject's
   outline.
4. **Clean it up.**
   - `modify_selection` `smooth` (2–4 px) removes wand speckle.
   - `shrink` 1–2 px pulls the edge off a halo.
   - `refine_selection` snaps to real edges: radius 2–4 for hard edges, 8–20 for hair and fur;
     `smartRadius: true` for mixed edges.
   - `shiftEdge` −10..−30 % tightens a refined edge that picked up background.
   **Check:** `percent` changed by roughly what you intended (a few percent at most for a
   cleanup).
5. **Output.** Choose by goal:
   - A local adjustment: `apply_selection_as_mask` with `kind` (one step).
   - A cutout: `layer_via_copy` (the original stays), or `add_layer_mask` `from: "selection"` on
     the layer itself.
   - Painting or fills inside it: keep the selection active and paint.
   Soften with the mask's own `feather` / `density` rather than `modify_selection` `feather`, so
   it stays adjustable.
6. **Verify.** `render_preview` at 1024 px or more, and `capture_view` on the edge at 2–8×.
   **Check:** no fringe of the old background colour, no stair-steps, no visible line where an
   adjustment ends. Fix by loading the mask back (`load_selection_from_mask`), refining, and
   masking again.

## Decision table

| Subject | Method |
| --- | --- |
| Geometric areas: a frame, a screen, a band | `select_rect` / `select_ellipse`, with `feather` for soft transitions |
| A subject with a clear outline (product, person, animal) | `select_subject` if the host has a model; else `select_polygon` along the contour (20–60 points), then `refine_selection` |
| Flat backdrop or solid colour (studio white, green screen, sky without clouds) | `magic_wand` on the backdrop (`tolerance` 20–40; `distance: "perceptual"` for gradients), then `invert_selection` |
| A colour spread across the image (all the reds, a dress) | `select_color_range` with `samples` (several picks) or a hue `preset`; `localized` to keep one area |
| Tones (shadows, highlights, a luminosity mask) | `select_color_range` with `preset` `shadows` / `midtones` / `highlights` |
| Skin for retouching | `select_color_range` `preset: "skinTones"`, then `intersect` with a box around the face |
| An AI matte or saved mask from the host | `load_selection_from_image` (soft: no `threshold`), then `refine_selection` |
| An existing layer mask | `load_selection_from_mask` |

## Recipes

- **Cut out a subject onto a new background:** select (table), refine, then `layer_via_copy`.
  Add the new background with `add_pixel_layer` and move it under the cutout (`move_layer`).
  `render_preview` and look for a halo; if there is one, load the copy's pixels back as a
  selection, `shrink` 1 px, and mask.
- **Replace the sky:** `magic_wand` or `select_color_range` `preset: "blues"` on the sky,
  `add` missed patches, `refine_selection` radius 8–16 along the horizon and trees, then
  `add_layer_mask` on the new sky layer. Match it with a clipped curves layer (`clipped: true`).
- **Adjust only part of an image:** select, then `apply_selection_as_mask` with `kind` and
  `params`, and `feather` in proportion to the image (a few px for objects, 50–200 px for
  broad light).
- **Vignette:** `select_ellipse` inset 5–10 % from the edges, `invert_selection`, then
  `apply_selection_as_mask` `kind: "curves"` (darken), with the mask `feather` at 15–25 % of
  the short side.
- **Graduated filter:** `select_rect` over the top third with a large `feather`, then a curves or
  hue/saturation layer through the mask.
- **Dodge and burn through masks:** an adjustment layer with a `hide-all` mask
  (`add_layer_mask`), then paint white on it with `paint_stroke` `channel: "mask"`, at low
  opacity.
- **Selective sharpening or blur:** select, then `set_smart_filter_mask` `from: "selection"` on
  a smart object's filters.
- **Clip a texture or colour to a layer:** put it directly above and set `clipped: true` with
  `set_layer_properties`; no selection is needed.
- **Picture inside a frame:** mask the picture with the frame's shape, then
  `set_layer_mask_properties` `linked: false` so the picture moves under a fixed mask; link it
  again afterwards.

## Pitfalls

- **Flooding:** a wand or range that covers most of the image. Start low (wand 20–40, range
  30–60), check `percent`, and grow with `mode: "add"`.
- **Box instead of outline:** `select_rect` around a subject masks its background too. Trace
  the contour.
- **Over-feathering hard objects:** a 10 px feather on a product looks like a glow. Keep hard
  edges at 0–2 px and refine soft ones instead.
- **Halo:** the old background shows as a light or dark fringe. `shrink` 1–2 px or
  `shiftEdge` negative before masking.
- **Baking too early:** `apply_layer_mask`, `merge_down` and `layer_via_copy` with `cut: true`
  are hard to revise. Keep masks until the user is happy.
- **Empty selection:** `modify_selection`, `refine_selection` and `apply_selection_as_mask` fail
  on it. Select first.
- **Hidden selection still applies:** with `set_selection_display` `none`, paint and fills are
  still limited to it. `deselect` before a whole-layer edit.
- **Wrong coordinates:** use natural image pixels, not preview pixels. On a cropped or rotated
  image, a rectangle measured in the preview lands in the wrong place.
- **Deprecated tools:** `select_region` and `select_by_color` still work, but use the tools
  below.

## Tools used

- `get_selection`: empty, bounds, area and percent after every step
- `select_all`, `deselect`, `invert_selection`: whole-image selections
- `select_rect`, `select_ellipse`: marquees
- `select_polygon`: the lasso, along a contour
- `magic_wand`: similar colour from a seed
- `select_color_range`: colour samples, hue, tone and skin presets
- `select_subject`: a subject by description (needs a host model)
- `load_selection_from_image`: AI or saved mattes
- `load_selection_from_mask`: a layer mask back to a selection
- `set_selection_display`: ants, Quick Mask tint or hidden
- `modify_selection`: grow, shrink, feather, border, smooth
- `refine_selection`: snap the edge to the image
- `transform_selection`: move or scale the outline only
- `capture_view`: inspect the edge at pixel level
- `render_preview`: check the result
- `apply_selection_as_mask`: a masked adjustment layer in one step
- `add_layer_mask`, `set_layer_mask_properties`, `apply_layer_mask`, `remove_layer_mask`: layer masks
- `set_smart_filter_mask`: limit smart filters
- `layer_via_copy`: lift the selection onto a new layer
- `paint_stroke`: paint on a mask with `channel: "mask"`
- `set_layer_properties`: clipping
