---
"@pixerate/swift": patch
---

Painting in the Swift paint canvas is smoother. `PaintCanvasPresenter` keeps the painting as one BGRA image per tile (`tiles()`), and `PaintCanvasView` shows the tiles as Core Animation layers, so a stroke rebuilds and uploads only the tiles it changed instead of converting and copying the whole canvas every frame. A live stroke tells the view where its dabs landed, so changed tiles are recomposited only there (as the TypeScript controller's `takeDirty` does), and each changed tile is finished once per frame instead of once per dab.
