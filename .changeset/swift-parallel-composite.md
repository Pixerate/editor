---
"@pixerate/swift": patch
---

The Swift paint view composites faster with the same pixels (#824): `blendTile` blends a tile's rows on several cores, ferrofluid lighting lights its tiles on every core, and wet light updates report the area they change (the changed light tiles grown by how far the spill reaches, or the old and new spill regions when the light's bounds move) instead of the whole canvas, so a dab stroke painted in the same frame keeps its sub-tile rectangles. Glow-wash's composite drops from 8.9 to 7.2 ms a frame on an M4 Pro.
