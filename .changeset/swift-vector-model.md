---
"@pixerate/swift": minor
---

**Swift:** the first part of the Swift vector editor (#622).

**Commands in `PixerateCore`**
- `CommandRegistry`, `createCommandToolProvider` (`list_commands`, `run_command`, `run_commands` with `$N.path` references and atomic batches) and the palette ranking (`rankCommands`), ported from the TS core with the same results and messages.
- Shortcut chords are formatted per platform.

**`PixerateVector`, a new target**
- **Document model:** `VectorDocument`, `VectorNode`, `VectorSymbol`, `VectorSubpath`, `VectorAnchor`. It reads and writes documents exactly as the TS core's `toJSON` does: key order, omitted keys, and unknown members kept.
- **Geometry:**
  - anchors ↔ Bézier;
  - SVG path data;
  - live corners;
  - bounds, transforms and anchor edits;
  - the shape builders.

Both are checked against vectors written by the TS core.
