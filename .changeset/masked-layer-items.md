---
'@pixerate/editor': patch
---

Layer items (`extractNormalizedLayerItems`) show a masked pixel layer through its masks, so Separate Subject's subject is the subject alone instead of a copy of the whole photo. New `controller.getMaskedLayerImage(id)` gives a layer's masked pixels as a cropped PNG with its bounds.
