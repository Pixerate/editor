---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Paint with provider effects in the paint editor. `PaintEditorController.setEffectPaint({ effect, values, time })` renders a generator, overlay or title effect once at the canvas size, and dab, particle and bristle brushes then take each pixel's colour (and alpha) from it, fixed to the canvas; the Mixer Brush and pick-up brushes sample it per dab. Wet, impasto and sticker brushes refuse it with a fix, and erasers, blenders and smudges ignore it. `setColor` and `setPaint` end it, and a stroke's own `paint` can be an effect. Strokes record the effect in `stroke.paint`; `replayStrokes`, time-lapses and high-resolution exports render missing effects first (`prepareEffectPaints`, `prepareStrokeEffects`) and name the effect and provider when they cannot. New agent tool `set_effect_paint`; `list_applied_effects`, `update_effect` and `remove_effect` take the target `paint`. `PaintEffectsPanel` (React and Svelte) has a Paint placement with the effect's controls, and the `ColorPanel` paint well shows the effect's thumbnail.
