---
"@pixerate/swift": patch
---

Specialty paints cost far less per frame in the Swift paint editor, with the same pixels as before.

- **Light paint** (glow-wash, foxfire): a lit layer's glow tiles and spill are kept between frames (`LightCache`, as `light.ts` has), and the spill is blurred on every core. A 2048 × 1536 canvas with one long glow-wash stroke went from 116 ms to 20 ms a frame; foxfire growth from 52 ms to 3 ms.
- **Live patterns** (turing-wash, coral-ink): the Gray-Scott step runs on every core, swaps its fields instead of copying them, and reads which cells are wet a tile at a time (`WetTileMask`; `LivePatternField.step` takes `wetTile` and `threads`, and `steppedTiles` lists the tiles it advanced). Only those tiles are shaded again. turing-wash went from 37 ms to 9 ms a frame, coral-ink from 32 ms to 8 ms.
- **Pattern relief and thick paint**: relief is written only into tiles whose pattern or height changed, and stale thick-paint tiles are lit on every core.
- `readRegion` and `writeRegion` copy whole rows.
- `SpecialtyPaintBenchTests` measures a frame of each specialty brush (`SPECIALTY_BENCH=1 swift test -c release -Xswiftc -enable-testing --filter SpecialtyPaintBenchTests`).
