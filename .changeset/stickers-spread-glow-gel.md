---
"@pixerate/editor": patch
"@pixerate/swift": patch
---

Large sticker brushes spread out, and thick paint that also paints light works in Swift.

- **Stickers at large sizes.** Past `STICKER_REACH` (64 px) a sticker brush's spacing now eases from its density toward `STICKER_LARGE_SPACING` (0.9 diameters) by `STICKER_SPREAD_SIZE` (256 px), so big stickers lie side by side along the path instead of piling onto one another. Scatter still stops at the reach, so they keep tracing the stroke. `stickerSpacing(density, size)` gives the spacing.
- **Swift: thick paint with light.** A stroke whose light twin paints with an engine other than dab, particle, bristle and the exchange engines (the glow gel, or any impasto brush on a layer that already holds light) now lays plain dabs as in `stroke.ts`, instead of failing with "…which the Swift paint editor does not paint with yet".
