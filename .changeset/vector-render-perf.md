---
"@pixerate/editor": minor
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
---

Faster vector rendering.

- **Reuse:** `getVectorSceneRenderData` reuses render data for nodes an edit did not touch.
- **Culling:** with `viewportSize`, nodes off screen are left out.
- **Level of detail:** groups, text and instances under 2 screen pixels draw as one rectangle. The `lod` option sets the threshold.
- **Canvases:** both canvases pass their size and skip unchanged nodes.
