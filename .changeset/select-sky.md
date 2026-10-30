---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Select › Sky for the image editor. Each pixel is scored on colour (blue, or bright and grey when overcast), smoothness and height in the frame. The sky is grown down from the top rows through high-scoring pixels without crossing an edge, patches of the same colour seen through gaps are added, and the edge is fitted with the colour guided filter. React and Svelte have a Select Sky button in the selection options bar. Agents use `select_sky` (`threshold`, `softness`, `mode`), which returns a note when no sky is found. New exports: `findSky`, `controller.selectSky` and `SkyCommandOptions`.
