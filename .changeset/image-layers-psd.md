---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Image editor: open and export Photoshop PSD / PSB files on top of the layer stack (a TypeScript port of a photocraft-psd subset). `loadPsd(bytes)` opens a file as the document (one undo step): pixel, group and adjustment layers (our ten kinds), user masks with density and feather, 26 blend modes, opacity, fill, clipping, visibility and locks map directly; type, smart-object, fill and shape layers come in as their stored pixels, and CMYK, Lab, grayscale, indexed, bitmap, 16- and 32-bit files are converted to 8-bit RGB, each loss reported as a warning naming the layers. `toPsd()` writes an 8-bit RGB PSD (PSB above 30 000 px) with real layers, groups, adjustment layers and masks, baking filters and depth masks. Documents without a source image (an opened PSD, a v3 document) now render. New agent tools `inspect_psd`, `import_psd` and `export_psd`; Open PSD… / Export PSD buttons in `<LayersPanel>` (React and Svelte, `psd` and `psdFileName` props); `readPsd`, `writePsd`, `importPsd`, `exportPsd`, `openPsdFile` and `downloadPsd` exports. `pnpm test:corpus` runs the reader and writer over 490 public PSDs.
