---
"@pixerate/editor": minor
---

Image editor at 16 and 32 bits: Free Transform, warps, flips and moves resample a deep layer's samples (16-bit sRGB, 32-bit linear light; whole-pixel moves are exact), and Dodge and Burn tone them. The tools that still compute in 8 bits (Mixer Brush, Smudge, Sponge, Clone Stamp, healing, filters, mask painting) now keep the deep samples of every pixel they leave alone instead of dropping whole tiles to 8 bits. New `keepDeepSamples` in `/raster`.
