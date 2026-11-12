---
"@pixerate/swift": patch
---

Live biopaint growth is lighter on the main thread. Each growth frame now redraws only the tiles its new threads and digested paint touched, instead of the whole colony, and it no longer rescans each colony's occupancy for bounds it doesn't use. `runCultureClock(frameInterval:)` lets a host grow at a lower frame rate; growth speed stays the same.
