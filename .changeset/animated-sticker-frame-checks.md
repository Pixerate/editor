---
"@pixerate/editor": patch
"@pixerate/swift": patch
---

fix(stickers,paint): a placed sticker's `frame` is checked against its art (`add_stickers` / `update_sticker` refuse a frame past the last, or above 0 on a static sticker, naming how many it has), frame 0 is left out instead of saved as `0` (also when a saved document has it), restamping a sticker without `frame` goes back to its first frame, and loading drops a `frame` that is not a whole number above 0. The brush editor has an "Animated frames" choice (`marks.frameMode`) for sticker brushes, in React, Svelte and the Swift brush panel. The paint conformance host takes `setup.stickers: "fake"` (the editor's stickers with the fake library), and a new `animated-stickers` scenario checks Swift against TypeScript for both frame modes (#728). In Swift, `canPaint` again leaves out brushes whose library stickers the sticker library doesn't have, or whose art failed to load.
