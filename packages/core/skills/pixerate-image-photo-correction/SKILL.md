---
name: pixerate-image-photo-correction
description: The global photo correction workflow in the Pixerate image editor - straightening and cropping, then exposure and white balance, black and white points, contrast and tone curves, colour and saturation, local fixes and finally a look, each checked in numbers (histogram, clipping, neutral greys) before the next. Use when asked to fix, correct, enhance, edit, brighten, darken, warm up, cool down or colour-correct a photo, remove a colour cast, recover shadows or highlights, add contrast or punch, straighten a horizon or crop to a ratio, or when set_adjustments, add_adjustment_layer, get_histogram or measure_region are available. Load with pixerate-image-editor, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-image-editor
---

# Correcting a photo

A correction is a sequence where each step changes what the next one sees, so the order
matters: frame, then light, then colour, then local, then style. The base controls
(`set_adjustments`) edit the Background's develop filter; adjustment layers stack above it and
can be masked, faded and blended later. Judge with numbers as well as eyes: `measure_region`
measures any rectangle of the composited image without a render (mean colour, cast, percentiles,
clipping), and `get_histogram` summarises the last `render_preview`.

This skill is the method. `pixerate-image-editor` has the full tool reference and control ids.

## Goal and quality bar

- Nothing important clips: under about 0.5 % of pixels at pure black or white per channel on a
  normal photo (`clipping` in `measure_region` or `get_histogram`), unless a light source or a
  specular highlight is meant to.
- Things that should be neutral are: a white wall, a grey card or clouds within about ±4 levels
  of cast (`cast.redBlue`, `cast.greenMagenta`).
- The tones span the range the scene has: shadows near but above 0, highlights near but below
  255 (`stats.luminance.p1` / `p99`), midtones where the subject reads well.
- Every correction is still adjustable: base sliders for global light and white balance, layers
  for the rest, named by intent. Nothing is merged or flattened unless asked.

## Inputs to confirm

- **The intent:** a faithful correction (the default) or a look (warm, moody, high contrast).
- **A neutral reference** if there is one: a grey card, white paper, a wall the user knows is
  white. Ask when the scene has none and the "right" colour is a matter of taste.
- **Output ratio** if the user mentions a destination (Instagram 4:5, a print size, 16:9).

## Working method

1. **Read.** `get_image_info` (size, crop, rotation), `get_adjustments` (what is already set),
   `list_layers`, then `measure_region` with no rectangle (the whole frame) and on the subject.
   **Check:** you know where the image clips, its overall cast and where the subject is.
2. **Straighten and crop first**, so every later judgement is on the final frame. Level a
   horizon or vertical with `set_rotation` (small angles, -3..3), then `set_crop` inside the
   transparent corners at the asked ratio; keep the subject's space to look or move into.
   **Check:** `get_image_info` `crop` has the ratio you meant and contains the subject.
3. **Exposure and white balance** with one `set_adjustments` call (`exposure`, `temperature`,
   `tint`, with a `label`). Set white balance from the neutral reference: `measure_region` on
   it, move `temperature` against `cast.redBlue` and `tint` against `cast.greenMagenta`, measure
   again. For a precise fix, a `levels` layer with per-channel `inWhite` scales each channel so
   the reference comes out grey (scale each channel to the same level).
   **Check:** the reference's `cast` is within ±4; the frame does not clip.
4. **Black and white points, then contrast.** A `levels` layer with `master.inBlack` /
   `master.inWhite` just inside where the data starts (`p1` / `p99`), never past it. Then a
   gentle S-curve `curves` layer (quarter-tones moved 10..25 levels, endpoints fixed). To lift
   dark areas without touching bright ones, raise `master.gamma` (1.2..1.8) instead of exposure.
   **Check:** `clipping` stays under 0.5 % per channel; shadows and highlights still have detail.
5. **Colour.** `vibrance` before `saturation` (it spares skin and colours already strong),
   `hueSaturation` per range for one colour, `colorBalance` for a cast left in the shadows or
   highlights. Small moves: real corrections are ±10..30.
   **Check:** neutrals still neutral; skin has red above green above blue and no orange or magenta.
6. **Local fixes** through masks: a sky darkened, a face lifted. Select (see
   `pixerate-image-selection-masking`), then `add_adjustment_layer` while the selection is
   active, or `apply_selection_as_mask` with a `kind`.
   **Check:** `measure_region` inside and just outside the mask: the change stops where it should.
7. **Look last**, if asked: `photoFilter`, `blackWhite`, a split tone with `colorBalance`, at
   reduced `opacity`. Correct before you stylise.
8. **Verify the whole.** `measure_region` on the frame and the reference again; `render_preview`
   and `get_histogram` where a canvas is available to look as well as measure. `undo_image` any
   step that made it worse, and report the settings you used.

## Decision table

| Problem | Fix |
| --- | --- |
| Whole image too dark or bright, nothing clipping | `exposure` (base), ±10..30 |
| Dark shadows, bright sky or window | `levels` `master.gamma` 1.2..1.8, or a curves lift in the lower quarter; never exposure, which clips the sky |
| Bright areas blown, shadows fine | Lower the top of a curve, or `levels` `master.outWhite` a little; clipped detail cannot come back |
| Flat, grey, low contrast | `levels` points at `p1` / `p99`, then a gentle S-curve |
| Colour cast, with a neutral reference | Per-channel `levels` `inWhite` (precise), or `temperature` / `tint` (quick) |
| Colour cast, no reference | `temperature` / `tint` until whites and clouds look clean; ask whether warmth is wanted |
| Cast only in the shadows or highlights | `colorBalance` shadows or highlights |
| Dull colour | `vibrance` +10..25; `saturation` only for non-portrait scenes |
| One colour wrong (green grass too yellow, sky too cyan) | `hueSaturation` on that range |
| Contrast change shifts colours | Put the curves or levels layer in `luminosity` blend (`set_layer_properties`) |
| Tilted horizon | `set_rotation`, then `set_crop` inside the corners |

## Recipes

**Neutral from a grey card.** `measure_region` on the card gives mean levels per channel (from
`stats`). Pick the target (the green level, or the mean), and set each channel's `inWhite` to
`255 × channel / target` in one `add_adjustment_layer` `levels` call (`params: { red: { inWhite },
green: { inWhite }, blue: { inWhite } }`). Measure the card again, and the whole frame for clipping.

**Lift shadows, keep the sky.** `add_adjustment_layer` `levels` with `params: { master: { gamma:
1.6 } }`; measure the sky's `clipping` and the foreground's luminance mean; raise or lower gamma.
For a lift limited to the foreground, add it while a selection of the foreground is active.

**Crop to a ratio, as large as possible.** The largest crop with ratio `w:h` inside an image of
`W × H` is `W` wide when `W / H` < `w / h`, else `H` tall; position it to keep the subject in
frame and give it room on the side it faces.

## Pitfalls

- **Correcting in the wrong order.** Colour judged before exposure or white balance gets redone;
  a crop after grading changes what the histogram meant.
- **Exposure for shadows.** Raising exposure to open shadows clips the sky; use gamma or curves.
- **Points past the data.** `inBlack` above `p1` or `inWhite` below `p99` crushes or blows
  everything beyond; `clipping` shows it.
- **Saturation on skin.** It turns skin orange fast; use vibrance, and measure a skin patch.
- **Trusting the screen alone.** Measure neutrals and clipping; a preview at 512 px hides small
  clipped areas.
- **Stacking corrections in base sliders.** They cannot be masked or faded; use layers for
  anything beyond global exposure and white balance.
- **`get_histogram` before a render.** It reads the last `render_preview` and fails without one;
  `measure_region` needs no render.

## Tools used

- `get_image_info`, `get_adjustments`, `list_controls`, `list_layers`: read the frame, settings, control ids and stack
- `measure_region`: mean colour, cast, percentiles and clipping of any rectangle, without a render
- `render_preview`, `get_histogram`, `capture_view`: look at the result and read its histogram
- `set_rotation`, `set_crop`, `reset_crop`: straighten and frame
- `set_adjustments`: exposure, white balance and other base controls, one undo step per call
- `add_adjustment_layer`, `update_adjustment_layer`, `remove_adjustment_layer`: levels, curves, vibrance, hue and colour balance as layers
- `set_layer_properties`: blend mode (luminosity), opacity and name of a correction layer
- `apply_selection_as_mask`: a masked adjustment layer for a local fix
- `undo_image`: take back a step
