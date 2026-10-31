---
'@pixerate/editor': minor
---

`extendCanvas` (and `extend_canvas`) keeps wet paint wet when `left` and `top` are whole 256 px tiles: the wet simulation moves with the picture and flows on exactly as if the canvas had not grown, so a host that grows a canvas while someone paints no longer dries their strokes and stops them mixing. Other shifts still dry the paint first. Adds `moveWetSnapshot` (`@pixerate/editor/paint`) and `PaintWetLayers.canExtend` / `extend`.
