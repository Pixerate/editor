# Smart objects

How to work with smart objects in the image editor (see the main skill for the tool reference).

1. **Convert before repeated or uncertain changes**: `convert_to_smart_object` (one pixel layer, or
   several siblings that nest as a layer document). A converted pixel layer looks exactly the same
   and keeps its id; its filters become smart filters. From then on every transform and filter is
   re-rendered from the contents, so scaling down and back up, or rotating twelve times, loses
   nothing.
2. **Read it**: `get_smart_object` gives the contents (size, kind, instances), the placement
   (corners, warp, and scale / rotate in percent and degrees of the contents' own size) and the
   smart filters with their ids.
3. **Transform**: `set_smart_object_transform` sets the transform absolutely (scale 100 = the
   contents' own size, `x`, `y` = where its centre goes; or `corners`, `matrix`, and a `warp` in
   contents pixels, `null` to remove). `transform_layer`, `warp_layer`, `flip_layer` and
   `rotate_layer_90` also work on a smart object, relative to its current placement, and never
   degrade it. `offset_layer` moves it by whole pixels.
4. **Filter non-destructively**: `add_smart_filter` (`develop` or `blur`, each with its own
   `blend` and `opacity`; kinds can repeat), then `update_smart_filter`, `move_smart_filter`,
   `remove_smart_filter` and `set_smart_filters_enabled`. `set_smart_filter_mask` limits where the
   filters show; paint it with `paint_stroke` / `fill_pixels` `channel: "filter-mask"`.
5. **Contents**: `copy_smart_object` with `linked: true` shares the contents (edit once, both
   change), `linked: false` makes them independent. `edit_smart_object_contents` opens the
   contents as their own document: every tool then works inside them until
   `close_smart_object_contents` (`save: false` discards). `replace_smart_object_contents` swaps
   in a new image for every linked instance; `export_smart_object_contents` returns the file.
6. **Finish**: `rasterize_smart_object` only when the user wants plain pixels to paint on; the
   placement and filters are then gone.
