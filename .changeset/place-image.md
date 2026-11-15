---
"@pixerate/editor": minor
"@pixerate/swift": minor
---

Place an image on a layer of its own to paint over: `placeImage` (and the `place_image` agent tool) decodes a PNG, scales it to fit inside the canvas (`contain`, the default) or to fill it and crop (`cover`), centred, and puts it on a new pixel layer above the active one in one undo step. `resampleImage` scales RGBA on premultiplied colour, averaging when shrinking. Swift matches, with a conformance scenario.
