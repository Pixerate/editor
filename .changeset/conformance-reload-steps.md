---
"@pixerate/editor": minor
---

Conformance scenarios can reopen documents: a step with `reload: true` saves the document and opens the save again before its call, and a step with `load` opens a given document. What opening reported (the problems, or the error) is recorded in `expect.loaded`. `ConformanceHost` gains optional `save` and `load`, which the paint host implements with `toJSON` / `loadJSON`.
