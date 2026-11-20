---
"@pixerate/editor": patch
"@pixerate/swift": patch
---

Paint documents now save `wet.clock` whenever their stroke log has wet paint, not only when the clock is past the log. When a document saved without complete `unlogged` marks is opened, a layer whose document saved its wet clock is checked exactly, wet areas included, so pixels imported or merged entirely under paint that was still wet are found and the layer keeps its colours instead of being replayed without them (#883). Older documents without `wet.clock` are checked as before.
