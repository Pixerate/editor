---
"@pixerate/swift": patch
---

The Metal-vs-CPU pixel expression tests no longer fail on a cold iOS simulator. They compare pixels, so they now allow the GPU compile up to 120 s instead of the 2 s production budget. Metal's first compile on a fresh CI simulator could take longer than that. Renderer behaviour is unchanged.
