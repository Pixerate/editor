---
"@pixerate/swift": patch
---

The first wet frame after a stroke no longer stalls (#826): tiles the water spreads into fill their paper heights on every core and read the paper's height function once per tile instead of once per cell, which took the first step from 25–35 ms to 4–10 ms on a 2048 × 1536 canvas with the same pixels. The specialty paint benchmark now covers vortex and antimatter (over paint laid first), reports the first frame and which frame was worst, and takes `SPECIALTY_BENCH_CORES` to run the engine on fewer cores as a stand-in for an iPad.
