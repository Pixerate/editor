---
"@pixerate/editor": patch
---

Make the product-photo skill and its `grounding-shadow` eval agree on how a shadow can be made. The skill's principles already allowed "the shadow an effect or a layer", but its method and the eval accepted only a `drop-shadow` effect. The method now gives the drop-shadow effect as the default and a soft shadow layer (below the product, with a live `blur` filter) as the alternative, with a recipe for each. The eval passes either one, and a new check measures that the ground just under the product is darker.
