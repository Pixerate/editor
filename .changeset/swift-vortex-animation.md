---
'@pixerate/swift': minor
---

Vortex paint winds on screen in Swift (#733): `integrateVelocityFieldFrames` keeps `VORTEX_KEYFRAMES` snapshots of the integration, `vortexWindingField` blends neighbouring keyframes, and the controller plays the view-only animation (`marks.duration`) from `stepVortexAnimations`, which `PaintEditorModel.tick` calls on the editor clock. It ends on the committed pixels, and undo, redo or another stroke on the layer drops it, as in TypeScript.
