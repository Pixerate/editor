---
"@pixerate/editor": minor
"@pixerate/swift": minor
---

Effect paint keeps translucent effects translucent, and stroke strips can keep their proportions.

- **Effect alpha is a ceiling.** A dab used to multiply its coverage by the effect's alpha, and overlapping dabs then built a 20%-alpha glow up to solid colour. `sampleEffectField` now hands the alpha to `CoverageBuffer.accumulate` as a per-pixel ceiling (`limits`), so a stroke ends at the effect's own alpha however densely its dabs overlap.
- **`map.width` for stroke strips.** A stroke-mapped effect strip was rendered `map.length` px wide, so its 256 rows squeezed across the tip with an aspect that was right only for a 256 px brush. The optional `width` (16..4096) sets the strip's rendered width apart from `length`, the stroke px per repeat: a host keeps the effect's proportions by setting `length` to `width × tip / EFFECT_STRIP_HEIGHT`.
