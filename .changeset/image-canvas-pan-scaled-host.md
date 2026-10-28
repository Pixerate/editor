---
'@pixerate/editor-svelte': patch
---

`ImageEditorCanvas` pans by the distance the pointer moves on screen when its host is scaled (e.g. an expanded studio inside a zoomed-out canvas), instead of overshooting by the host's scale.
