---
"@pixerate/editor": patch
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
---

Keep GPU effect providers within the browser's WebGL context limit. `EffectRendererPool` keeps at most four live renderers (`maxRenderers`) and disposes the least recently used one once its renders finish; the video and image effects engines render through it. `renderEffectThumbnail` renders one thumbnail at a time and caches the results per provider. Before this, browsing Flair's catalog lost contexts and left thumbnails and clip effects blank. `<EffectsBrowser>` now scrolls its grid within a fixed height.
