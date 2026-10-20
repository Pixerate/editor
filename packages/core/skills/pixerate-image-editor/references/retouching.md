# Retouching

1. **Retouch on a new empty layer** above the photo with `sample: "current-below"` (or `"all"`):
   `clone_stamp`, `heal_brush` and `spot_heal` then paint onto that layer and the photo stays
   untouched, so a bad stroke is easy to mask or erase. Smudge, Dodge, Burn and Sponge change the
   pixels they touch, so run them on a duplicate (`duplicate_layer`) instead.
2. **Pick the tool by the job.** A small spot or blemish on skin, sky or a wall: `spot_heal` with
   a brush a little larger than the spot (`proximity-match` copies a nearby patch; `smooth` fills
   from the edges and suits flat areas). A larger flaw, or one next to an edge: `heal_brush` from a
   clean source of the same texture; it takes the colour and light around the stroke, so the source
   may be lighter or darker. Copy exactly (a repeat, a straight line, an edge): `clone_stamp`.
3. **Sources and offsets.** `set_clone_source` (or `source` on the stroke) is the Alt-click. The
   first stroke fixes the offset = source − its first point; with `aligned` (default) later strokes
   keep it, so the source moves with the brush; with `aligned: false` every stroke restarts at the
   source point. The result's `clone.offset` and `clone.source` say what was used. Choose a source
   that is clean for the whole length of the stroke: the stroke samples what was there before it,
   never what it just painted.
4. **Use soft, short strokes** (`brush.hardness` 0..0.5, a size just over the flaw), and check each
   with `capture_view` on the area (scale 2..4). Several small strokes heal better than one long one.
5. **Dodge and burn gently**: `exposure` 0.1..0.3, `range: "midtones"` for skin and form,
   `"highlights"` / `"shadows"` to lift or deepen only those tones. A stroke never goes past its
   exposure where its dabs overlap; another stroke builds on it. `protectTones` (default) keeps hue
   and saturation. `sponge` with `mode: "desaturate"` takes colour out (a colour cast on teeth or
   eyes), `saturate` adds it; passes compound, so use a low `brush.flow`.
6. **Smudge** drags colour along the stroke like a finger in wet paint (`strength` how far); for
   blending paint colours use the Mixer Brush instead.
7. **Blur and sharpen locally**: `blur_stroke` softens (a background, a harsh edge, skin texture)
   and `sharpen_stroke` crisps (eyes, a detail). Keep `strength` low (sharpen 0.2..0.5) and check
   with `capture_view`; for the whole layer use a layer filter instead. Dabs in one stroke do not
   compound; another stroke goes further.
8. **Take back part of a change** with `history_brush`: it paints the layer as it was
   `historySteps` undo steps back (0, the default, is the oldest state history keeps). Filter or
   grade the whole layer, then paint the original back where it should not apply. It fails when the
   layer did not exist in that state; read `historySteps` from how many steps you have made since.

## Pitfalls

- The retouching tools need a source to be useful: `clone_stamp` / `heal_brush` refuse without a
  clone source, and with `sample: "current"` an empty layer has nothing to copy (the stroke then
  changes nothing). Sample `current-below` or `all` to retouch onto an empty layer.
- `heal_brush` and `spot_heal` show a plain clone or a dark trail while a person draws and blend
  when the stroke ends; through the tools the result is already blended.
- `dodge`, `burn`, `sponge` and `smudge` ignore `brush.opacity` (exposure, flow and strength set
  their strength) and `brush.blend`; `blur_stroke` and `sharpen_stroke` multiply it by `strength`. The Sponge refuses masks, which have no colour.
