# Provider effects in the image editor

The host may register an effects provider (for example Flair). The tools then reach its catalog:
filter effects become **smart filters**, and generator, overlay and title effects become
**effect layers**. These are not the layer styles of `add_layer_effect` (drop shadow, stroke, glow).
In the UI, the **Effects** panel holds an effect layer's controls and the layer's filters; layer
styles are the **Layer Style** section of **Layer Properties**. Use those names when you tell the
user where to find what you changed.

## Working method

1. `search_effects` with a `use`: `filter` for a look on existing pixels; `generator`, `overlay` or
   `title` for new content.
2. `describe_effect` for its controls, ranges and presets.
3. `apply_effect` on the layer (a smart filter), or `add_effect_layer` (a new layer at the
   document's size and bit depth).
4. Tune with `update_effect`. Use a smart filter's `opacity` and the stack's filter mask
   (`set_smart_filter_mask`, `paint_stroke` channel `filter-mask`) to limit where it shows. Use a
   layer mask, opacity and blend mode for an effect layer.
5. `render_preview` once the effect has rendered.

## Best practices

- Prefer smart filters to baking: they stay editable, reorderable and maskable.
- For light leaks and glows, add an overlay effect layer with blend `screen` or `add`. For
  textures, use `multiply`.
- Several effect filters render in order: each waits for the one below it.

## Pitfalls

- **Effects render in the background.** Right after `apply_effect` or `update_effect`, the smart
  object shows the pixels without the new effect until the provider's result lands. This is a
  redraw, not an undo step. Render a preview after the effect has rendered.
- **Smart filters run on 8-bit pixels.** Effect layers render at the document's bit depth.
- **Without a provider,** effect filters pass pixels through and effect layers keep their last
  pixels. Both keep their effect ids and values and save unchanged. The write tools refuse.
- **An effect layer's pixels are redrawn** by `update_effect` (`generator`), which replaces any
  painting on it. Paint on a layer above, or `remove_effect` `generator` first to keep the pixels.
