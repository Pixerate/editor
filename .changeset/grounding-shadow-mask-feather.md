---
"@pixerate/editor": patch
---

Make the product-photo skill and its `grounding-shadow` eval accept a shadow layer softened by a feathered layer mask, as well as one with a live `blur` filter. A mask's `feather` stays adjustable (`set_layer_mask_properties`), so it meets the same "soft shadow I can still adjust" bar. A mask with no feather is still refused, because it cuts the shadow off sharply. The check now locates a masked shadow layer by its mask's painted area. The skill describes the mask route and adds a pitfall for a hard-edged mask.
