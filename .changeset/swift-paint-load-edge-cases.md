---
"@pixerate/swift": patch
"@pixerate/conformance": patch
---

Swift paint documents now open the last three edge cases the way the TS core does (#742). Saved channels far off the canvas are no longer refused: their tiles get the keys TS gives them, including keys that round past 2^53 (`jsTileKey`; `tileKey` switches to it outside ±2^30 tiles). Deep 16- and 32-bit samples with a fractional, text, boolean or array `width` or `height` are written where JavaScript arithmetic puts them (`writeDeepRegionUnchecked`), and an array `deep` is reported as TS reports it. A saved wet event with a non-integer `at` (`1.5`, `"0.25"`, `true`) replays at that value among the strokes instead of at 0 (`WetEvent.replayAt`).

The new `document-load-edge-cases` paint scenario checks all three.
