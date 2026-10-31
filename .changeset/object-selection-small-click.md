---
'@pixerate/editor': patch
---

Object Selection without a model: a click on a small object inside a large region of another colour (a boulder in a river, a tree in a forest) no longer selects the region. When the first search runs into the band around it, a cut from a small disk at the click is kept, and used if the search ends up reaching three sides of the image. Checked on the demo's photos: clicks on a boulder and a tree in the lake photo now select just them (before: the whole image).
