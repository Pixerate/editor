---
"@pixerate/editor": patch
---

`list_layers` in the image editor now reports a vector mask's `density` and `feather`, as it already does for a raster mask, so agents and eval checks can see whether a vector mask is soft without calling `get_vector_mask` on every layer.

The product-photo skill and its `grounding-shadow` eval now also accept a shadow layer softened by a feathered vector mask (`add_vector_mask`, then `set_vector_mask_properties` `feather`), alongside a live blur filter or a feathered layer mask. A vector mask with no feather is still refused.
