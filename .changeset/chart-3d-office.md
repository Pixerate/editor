---
"@pixerate/editor": minor
"@pixerate/swift": minor
---

Office export of 3-D charts (#795): a chart with a 3-D view is written as Office's `bar3DChart`, `line3DChart` (with its hidden series axis) or `area3DChart`, with `c:view3D` (`rotX`, `rotY`, `depthPercent` in whole numbers), so it opens in 3-D in Office and reads back with its view. Office draws one 3-D group on one value axis, so a chart that mixes series types or uses the secondary axis is still saved flat, and the writer says why. Swift writes the same XML.
