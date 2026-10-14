---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add Freeform-style canvas arrangement features. Core (`@pixerate/editor/canvas`) gains `alignNodes`, `distributeNodes` (equal gaps or equal centres), `matchSize`, node locking (`lockNodes` / `unlockNodes` / `isLocked`), z-order helpers (`reorderNodes` for bring forward / send backward / bring to front / send to back), smart guides with snap-to-shape (`computeSnapGuides`, `createGuideIndex`, `snapNodeDrag`, edge, centre and equal-spacing guides), connector snapping (`findConnectorSnap`, `nearestHandlePositions`), a headless Scenes store (`CanvasScenesStore`, `fitViewportToNodes`), arrange keyboard shortcuts (`matchArrangeShortcut`) and a shared `createCanvasArrangeController` with optional `HistoryManager` undo. React adds `useCanvasArrange`, `useCanvasArrangeShortcuts`, `useCanvasScenes` and `<CanvasGuidesLayer>`. Svelte adds `createCanvasArrange`, `createCanvasArrangeShortcuts`, `createCanvasScenes` and `<CanvasGuidesLayer>`.
