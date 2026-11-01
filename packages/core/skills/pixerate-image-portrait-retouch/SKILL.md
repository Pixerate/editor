---
name: pixerate-image-portrait-retouch
description: The portrait retouching workflow in the Pixerate image editor - removing blemishes, spots and stray hairs, healing larger flaws, evening skin while keeping its texture, dodging and burning, brightening eyes and teeth, and keeping the result natural and reversible on separate layers. Use when asked to retouch, clean up, airbrush or touch up a portrait, headshot or face, remove spots, pimples, acne, wrinkles, stray hairs or dust, smooth or even skin, brighten eyes or whiten teeth, or when spot_heal, heal_brush, clone_stamp, dodge or burn are available. Load with pixerate-image-editor, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-image-editor
---

# Retouching a portrait

Good retouching removes what is temporary (a spot, a stray hair, a shine) and keeps what makes
the person look like themselves (moles they keep, freckles, pores, laughter lines). Work from
the global to the small, on layers above the photo, so every step can be faded or taken back.
The healing tools paint onto an empty layer when they sample `current-below`; tonal tools
(dodge, burn, sponge, smudge) change the pixels they touch, so they work on a duplicate.

This skill is the method. `pixerate-image-editor` has the tool reference, and its
`references/retouching.md` the detail of each retouching tool.

## Goal and quality bar

- Temporary flaws are gone: a blemish area measures like the skin around it (`measure_region`
  on a small box around it: luminance `p1` close to the surrounding skin).
- Skin keeps its texture: no flat, plastic patches. Heal and clone copy real texture; blur only
  locally and lightly.
- Tone and colour are natural: skin has red above green above blue, eyes and teeth brightened
  only a little (they stay off-white).
- The photo layer is unchanged: retouching lives on named layers ("Retouch", "Dodge & burn",
  "Eyes") the user can fade or switch off.

## Inputs to confirm

- **How much:** a light clean-up (temporary flaws only, the default), a polished commercial
  retouch, or something specific.
- **What to keep:** moles, freckles, scars and features that are part of the person stay unless
  the user asks.
- **Where:** the flaws to fix when the user has named them (positions or a description).

## Working method

1. **Global correction first.** Exposure and white balance as in `pixerate-image-photo-correction`,
   so retouching is judged on the final tones.
   **Check:** skin `measure_region` has a plausible colour (red > green > blue, no strong cast).
2. **Find the flaws.** `capture_view` the face at 2-4× scale in parts; list spots, hairs and
   flaws with positions. `measure_region` on a small box around a suspect spot compared with a
   box of clean skin beside it tells a spot from a shadow.
   **Check:** a list of flaws with coordinates and sizes.
3. **Make a retouch layer.** `add_pixel_layer` named "Retouch" above the photo; all healing goes
   on it with `sample: "current-below"`.
   **Check:** `list_layers` shows it active above the photo.
4. **Heal small to large.** `spot_heal` for spots (one dab, `hardness` 0.2-0.5, `brush.size`
   2.5-3× the spot's width: a soft brush heals fully only in its middle, so one just over the
   spot leaves a dark ring); a short stroke of dabs along a stray hair. `heal_brush` from a clean
   source of the same texture for larger flaws; `clone_stamp` near edges (lips, eyes, hairline)
   where healing would pull colour across.
   **Check:** `measure_region` around each flaw: its `p1` is near the clean skin's; `capture_view`
   shows texture, not a smear.
5. **Even tone (dodge and burn)**, only if asked for more than a clean-up. Duplicate the photo
   (`duplicate_layer`) and `dodge` / `burn` at `exposure` 0.1-0.2, `range: "midtones"`, along
   shadows under the eyes or uneven patches; or paint on a layer in `soft-light` blend.
   **Check:** the area's luminance moved by a few levels, not tens.
6. **Eyes and teeth.** Select them (`select_ellipse`, `select_polygon`), feather 1-2 px, and add a
   `levels` or `curves` layer while the selection is active (`master.gamma` 1.2-1.6). For yellow
   teeth, a `hueSaturation` layer lowering the yellows' saturation, masked the same way.
   **Check:** `measure_region` inside rises; just outside (skin, lips) does not change.
7. **Review the whole face** at normal scale (`render_preview` or `capture_view` at 1×). Lower a
   layer's `opacity` where it went too far (`set_layer_properties`). Report what you removed.

## Decision table

| Flaw | Tool |
| --- | --- |
| Spot, pimple, dust (smaller than about 15 px) | `spot_heal`, `proximity-match` or `content-aware` |
| Stray hair across skin | `spot_heal` along it, short strokes; `clone_stamp` where it crosses an edge |
| Larger blemish, scar the user wants gone | `heal_brush` from clean skin of the same texture and light |
| Flaw next to an edge (lip line, eyelid, hairline) | `clone_stamp`, with a source along the same edge |
| Shine on forehead or nose | `heal_brush` at reduced brush opacity from matte skin nearby |
| Dark circles, uneven patches | `dodge` (midtones, exposure 0.1-0.2) on a duplicate, or a masked curves layer |
| Dull eyes | Masked `levels` gamma 1.2-1.6; `sharpen_stroke` lightly on the iris |
| Yellow teeth | Masked `hueSaturation` (yellows, saturation -20..-40), then a little brightness |
| Redness | Masked `hueSaturation` (reds, saturation down a little) |

## Recipes

**Clean-up pass.** `add_pixel_layer` "Retouch" → one `spot_heal` per spot (`points: [{x, y}]`,
`sample: "current-below"`, `brush: { size: 3 × the spot, hardness: 0.3 }`) → `measure_region` on
a box about 3× the spot around each. The spot is gone when the box's `stats.luminance.p1` is
within about 10 levels of the skin's around it; if not, the edge is left: dab again one size up.

**Stray hair.** `spot_heal` with `points` every 8-10 px along the hair and a brush 1.5-2× its
width; check the whole length with one `measure_region` box over it.

**Brighter eyes.** `select_ellipse` each eye (`mode: "add"` for the second) → `modify_selection`
`feather` 1 → `add_adjustment_layer` `levels` with `params: { master: { gamma: 1.4 } }` →
`measure_region` on an eye and on the skin beside it.

## Pitfalls

- **Healing on the photo layer.** Mistakes become permanent; heal onto an empty layer with
  `current-below`.
- **An empty layer with `sample: "current"`** has nothing to copy, so the stroke does nothing.
- **Over-smoothing.** Blurring skin removes pores and looks fake; heal flaws instead.
- **Brush size.** Too small a soft brush leaves a faint ring of the flaw (its edge falls in the
  brush's soft falloff); much larger than about 4× the flaw pulls in colour from around it. Aim
  for 2.5-3× the flaw's width with a soft brush, or about 1.5× with `hardness` near 1.
- **Healing across an edge** smears lips or lashes into skin; clone along edges instead.
- **Removing features.** Moles, freckles and scars are part of a face; ask before removing them.
- **Bright white eyes and teeth** look unnatural; small gamma moves, and measure.

## Tools used

- `list_layers`, `capture_view`, `render_preview`, `measure_region`: find flaws, check each fix, review
- `add_pixel_layer`, `duplicate_layer`, `set_layer_properties`: retouch and dodge-and-burn layers; fade them
- `spot_heal`, `heal_brush`, `clone_stamp`, `set_clone_source`: remove spots, hairs and flaws
- `dodge`, `burn`, `sponge`: even tone and colour on a duplicate
- `sharpen_stroke`, `blur_stroke`: crisp eyes, soften a harsh edge, locally
- `select_ellipse`, `select_polygon`, `modify_selection`: select eyes and teeth
- `add_adjustment_layer`: masked brightening or colour change of eyes and teeth
- `undo_image`: take back a step
