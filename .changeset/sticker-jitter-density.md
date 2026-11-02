---
"@pixerate/editor": patch
---

Paint editor stickers: colour jitter now shifts hue and lightness in OKLCH (up to ±40° and ±0.15 at 1) and lowers chroma instead of clipping, so sprays with colour jitter come out in slightly different colours than before. The sticker `density` setting now documents its real rate: about `density × 4` stickers per tip diameter.
