---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

`ImageEditorCanvas` draws the crop box (crop mode) and the marquee (select mode) while an agent drags them out, as it does for a user's drag. New in `@pixerate/editor/tools`: `trackPresenceDrag`, which follows a presence store for an agent's drag. New in `@pixerate/editor/image-editor`: `agentDragDraft`, which turns that drag into the canvas's draft crop or selection path.
