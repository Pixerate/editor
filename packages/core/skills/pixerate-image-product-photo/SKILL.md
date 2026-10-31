---
name: pixerate-image-product-photo
description: The product photo workflow in the Pixerate image editor - cutting a product out of its backdrop, putting it on pure white or a brand colour, grounding it with a soft shadow, keeping its colours accurate, cropping and centring it to marketplace ratios with consistent margins, and checking the result before export. Use when asked to prepare product shots, packshots or e-commerce, marketplace, Amazon, Etsy or catalogue images, put a product on white, remove or replace a product background, add a product shadow, or crop and centre products consistently, or when select_subject, add_layer_mask, add_layer_effect or set_crop are available. Load with pixerate-image-editor, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-image-editor
---

# Preparing a product photo

A product shot is a cutout on a controlled background: the product's edge and colour must be
exact, the background uniform, and every image in a set framed the same way. Build it as layers
so each part stays adjustable: the photo with a mask hiding its backdrop, a background fill
layer below it, a shadow (an effect, or its own layer) between, and the crop on top.

This skill is the method. `pixerate-image-editor` has the full tool reference, and
`pixerate-image-selection-masking` the detail of selecting and refining the edge.

## Goal and quality bar

- The background is uniform: pure white is 255 in every channel (`measure_region` `stats`
  luminance `p1` ≥ 250 and a cast within ±2), or exactly the brand colour asked for.
- The product's colour is unchanged by the cutout (measure it before and after) and its edge
  has no halo of the old backdrop (`inspect_mask_edge` `haloScore` under 0.35).
- The product sits on something: a soft shadow below it, unless the user wants it floating.
- The frame matches the destination: ratio, product centred (or as the set requires), and the
  product filling a consistent share of the frame (about 75-85 % of the longer side for most
  marketplaces).
- Everything stays editable: masked, not erased; the shadow an effect or a layer.

## Inputs to confirm

- **Background:** pure white (the default for marketplaces), a colour (hex), or transparent.
- **Destination ratio and margin:** 1:1 (most marketplaces), 4:5, 3:2, or a size in pixels; how
  much of the frame the product should fill. For a set, the same for every image.
- **Shadow:** a soft contact or drop shadow (the default), a reflection, or none.
- **Colour reference:** a swatch or hex the product must match, when colour accuracy matters.

## Working method

1. **Read and measure the product.** `list_layers`, `get_image_info`, then `measure_region` on a
   flat part of the product: its mean colour is the reference you will protect.
   **Check:** you have the product's bounds and colour.
2. **Correct the photo first** if it needs it (white balance from the backdrop, exposure): the
   cutout and the measure should be on corrected colours (`pixerate-image-photo-correction`).
   **Check:** the backdrop is neutral before you remove it.
3. **Select the product.** On a plain backdrop, `magic_wand` on the product (`contiguous: true`)
   or on the backdrop and `invert_selection`; on a busy one, `select_subject` or `select_object`
   with a box, then `refine_selection`. Hard-edged products want a crisp edge (refine radius
   1-3, no feather).
   **Check:** `get_selection` bounds hug the product; `inspect_mask_edge` `issues` is empty.
4. **Hide the backdrop, do not delete it.** `add_layer_mask` `from: "selection"` on the photo
   layer (or `add_vector_mask` for a geometric product that must stay razor sharp). Then
   `add_pixel_layer` with the background `color` placed `belowId` the photo layer.
   **Check:** `measure_region` on a corner: `p1` ≥ 250 (white) or the brand colour; on the
   product: the colour from step 1.
5. **Fix the edge colour** if the old backdrop tints it: `set_edge_decontamination`, or
   `modify_selection` `contract` 1 px before masking.
   **Check:** `inspect_mask_edge` with `target: "layer-mask"` shows no halo.
6. **Ground it.** With the product on its own layer (`layer_via_copy`, or the masked photo),
   `add_layer_effect` `drop-shadow` with `angle` 90 (light from above), a small `distance`
   (3-10 px at web sizes), a `size` larger than the distance and `opacity` 0.25-0.45.
   **Check:** `list_layers` shows the effect; the shadow reads as contact, not as a cutout.
7. **Frame it.** `set_crop` at the ratio, centred on the product's bounds, with the margin asked.
   **Check:** `get_image_info` `crop`: ratio right, centre within a pixel or two of the
   product's centre, product share of the side as intended.
8. **Final check.** `measure_region` on the background corners and the product; `render_preview`
   where available. Report the crop, the background colour and the shadow settings so the rest
   of the set can match.

## Decision table

| Backdrop | Selection |
| --- | --- |
| Plain, contrasting | `magic_wand` on the product or backdrop (tolerance 10-30) |
| Plain but close to the product colour | `select_color_range` on the backdrop with low fuzziness, then refine |
| Busy or textured | `select_subject`, or `select_object` with the product's box |
| Glass, transparent or reflective product | Select the outline, then lower the mask's `density` where it should show through; ask how it should look |
| Product with straight edges (a box, a screen) | `add_vector_mask` from the selection, or a path |

| Destination | Frame |
| --- | --- |
| Marketplace main image | 1:1, white, product about 85 % of the frame |
| Catalogue or site grid | The grid's ratio, the same margin on every image |
| Social post | 4:5 or 1:1, room for text if the user asks |

## Recipes

**On white.** `magic_wand` on the product → `inspect_mask_edge` → `add_layer_mask` (`layerId`
of the photo, `from: "selection"`) → `add_pixel_layer` (`color: "#ffffff"`, `belowId` the photo)
→ `measure_region` on a corner and on the product.

**Centred square crop.** Product bounds `x, y, w, h`; side `S = max(w, h) / share` (share 0.7-0.85,
no larger than the image allows); `set_crop` with `x + w/2 - S/2`, `y + h/2 - S/2`, `S`, `S`.

**Contact shadow.** `layer_via_copy` the selected product (or use the masked layer), then
`add_layer_effect` `kind: "drop-shadow"` with `settings: { angle: 90, distance: 6, size: 10,
opacity: 0.4 }`; adjust with `update_layer_effect`.

## Pitfalls

- **Off-white that looks white.** 245 grey reads as white on screen and fails a marketplace
  check; measure `p1`, not the mean.
- **Erasing the backdrop.** Deleted pixels cannot be fixed later; mask instead.
- **Colour shift from the cutout.** A decontamination or a colour adjustment above the product
  changes it; measure the product before and after, and keep corrections below the product.
- **A halo of the old backdrop** shows on white more than anywhere; inspect the edge and
  decontaminate or contract by a pixel.
- **A shadow that floats.** A large distance or a sideways angle looks pasted on; keep it short
  and below.
- **Inconsistent sets.** Each image cropped by eye drifts; compute the crop from the product's
  bounds with the same share for every image.

## Tools used

- `list_layers`, `get_image_info`, `measure_region`: read the stack, the frame and the colours
- `magic_wand`, `select_color_range`, `select_subject`, `select_object`, `invert_selection`: select the product
- `refine_selection`, `modify_selection`, `get_selection`, `inspect_mask_edge`: refine and check the edge
- `add_layer_mask`, `add_vector_mask`, `set_layer_mask_properties`: hide the backdrop, editably
- `set_edge_decontamination`: remove the backdrop's colour from the edge
- `add_pixel_layer`: the background fill below the product
- `layer_via_copy`: the product on its own layer
- `add_layer_effect`, `update_layer_effect`: the shadow
- `set_crop`, `reset_crop`: the frame
- `render_preview`: look at the result
- `undo_image`: take back a step
