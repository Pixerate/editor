---
'@pixerate/editor': patch
'@pixerate/editor-svelte': patch
---

Serialize WebGPU wet-paint tile shading and await in-flight lead-frame display shading before starting post-batch shading so the `"wet shaded read"` readback buffer is never submitted while mapped.
