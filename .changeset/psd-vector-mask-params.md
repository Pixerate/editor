---
'@pixerate/editor': patch
---

PSD export now writes a vector mask's density and feather into the layer's mask record, as Photoshop does, so they survive a round trip. A layer with only a vector mask gets a mask record that carries just those parameters, and no raster mask appears when it's read back. Before this, they were left out with a warning.
