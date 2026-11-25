---
"@pixerate/swift": minor
---

Swift paint editor: port `createPaintChangeFeed` as `PaintChangeFeed`, with what it needs from `PaintEditorController`: history origins (`withOrigin`, `currentOrigin`), commit events (`onCommit`, heard before `subscribe`'s listeners, as in TS), and `stroking`. `PaintProposals` gains `subscribe` and `clear(origin:)`, and `accept` records its step under the proposal's origin, notifying after the step has committed.
