---
"@pixerate/editor": patch
"@pixerate/swift": patch
"@pixerate/conformance": patch
---

Vector masks stored as SVG path data now save → reopen → save unchanged: anchor lists keep their anchor `type` (`corner`, `smooth`, `symmetric`), and the closing anchor merged from SVG path data writes `in` before `out`, like every other anchor. The Swift paint editor reads and writes them the same way, and `document-load-vector-layers` now reloads its SVG-path masks.
