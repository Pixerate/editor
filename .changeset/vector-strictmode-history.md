---
"@pixerate/editor": patch
---

Fix the vector editor's History buttons lagging one step under React StrictMode: `VectorEditorController.subscribe()` now reconnects to the history after `destroy()`, so a controller kept by `useVectorEditorController` survives StrictMode's double effect.
