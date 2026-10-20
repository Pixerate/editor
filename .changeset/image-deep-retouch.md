---
"@pixerate/editor": minor
---

Image editor at 16 and 32 bits: the Mixer Brush, Smudge, Sponge, Clone Stamp, Healing Brush and Spot Healing now keep a deep layer's precision. They run on float working tiles, and Clone and healing sample the layer's deep samples or the float composite. The paint engine's `TileMedium` and `TilePixelSource` accept float tiles (`PaintPixels`, `put255`); 8-bit behaviour is unchanged.
