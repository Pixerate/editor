# Layer effects: drop shadows, glows, bevels, overlays and strokes

Read this before `add_layer_effect`, `update_layer_effect`, `set_global_light` or
`set_layer_effects_enabled`.

1. **Effects are live and per layer**: drop and inner shadows, outer and inner glows,
   bevel & emboss, satin, colour / gradient / pattern overlays and strokes go on pixel,
   annotation and group layers (not adjustment layers) and follow the layer's pixels as they
   change. Add them with `add_layer_effect` (`kind` plus only the `settings` that differ from
   Photoshop's defaults), tune them with `update_layer_effect` and read them back with
   `list_layer_effects`. Each call is one undo step and returns the layer's effects. In the UI
   they are the **Layer Style** section of **Layer Properties**; the separate **Effects** panel is
   for provider effects (effect layers and filters), so say "layer style" when you tell the user
   where a drop shadow or stroke lives.
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
