---
"@pixerate/editor": minor
---

Image editor: the Clone Stamp and Healing Brush show their source on the canvas as a crosshair. It sits on the source point, and once an aligned stroke has fixed the offset, it follows the brush. The new `controller.cloneSourceMarker(cursor)` gives the position, and the renderer's new `cloneSourceMarker` render option draws it (filled from the brush cursor automatically, so the React and Svelte editors both show it).
