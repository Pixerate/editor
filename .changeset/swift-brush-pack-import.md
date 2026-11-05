---
"@pixerate/swift": minor
---

Swift paint editor: brush pack import. `importBrushPack` / `readBrushPack` read Photoshop `.abr` (versions 1, 2, 6, 7 and 10) and Procreate `.brush` / `.brushset` packs into brushes and image sources, with the `unsupported` list and licence notes, through defensive `.abr`, ZIP and binary plist readers; the `import_brush_pack` tool adds them to the library in one import. The `brush-pack-import` paint scenario passes, so no paint scenario is skipped in Swift any more (#646).
