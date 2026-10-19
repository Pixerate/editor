---
"@pixerate/editor": minor
---

Open and save Photoshop shape and type layers as live layers. PSD import reads shape layers' paths (`vsms` / `vmsk`, with Photoshop's path operations and inverted shapes), fills (`vscg` or `SoCo` / `GdFl` / `PtFl`), strokes (`vstk`) and live rectangles, rounded rectangles, ellipses and lines (`vogk`), and type layers' `TySh` (text, character and paragraph runs from the EngineData, point or box frame, transform); type keeps Photoshop's pixels until it is edited, and `loadPsd` warns about fonts the text shaper lacks. PSD export writes shape and type layers as Photoshop shape and type layers, writing the blocks read from a file back byte for byte while a layer is unchanged and patching the file's EngineData when text changes.
