---
"@pixerate/swift": patch
---

Swift's brush `degrade` now matches the TypeScript core: it removes a `colour` left empty, takes `ignored: true` to strip what a host paints without, and drops a palette's foreign colours. A new test compares Swift's host profiles and `checkBrush` on every preset with the brushes contracts (`profiles.json`, `checks.json`).
