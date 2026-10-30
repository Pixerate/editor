---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Save and load selections and masks as image files. `exportMaskImage` writes the selection, an alpha channel or a layer's painted mask as a full-size greyscale PNG (white = selected; `invert`, `maxSide`), encoded in code so it works without a canvas, and `loadChannelFromImage` reads a mask image of any size into a new alpha channel. New agent tools `export_mask_image` (read-only) and `load_channel_from_image`. The React and Svelte `ChannelsPanel` gain Import… (a file into a new channel named after it) and Export PNG (the active channel, else the selection), built on the framework-free `openMaskFile` and `downloadMaskImage`. The image editor skill's painting detail moved to `references/painting.md`.
