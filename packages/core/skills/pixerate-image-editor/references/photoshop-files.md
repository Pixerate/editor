# Photoshop files

1. **Inspect before opening.** `inspect_psd` lists every layer with the type it would become and
   a status: `mapped` (held exactly), `approximated` (type, fill and shape layers come in as their
   stored pixels; linked smart objects as their stored pixels; Photoshop smart filters other than
   Box Blur are kept but not drawn; Dissolve becomes Normal; effects with gradient midpoints or
   smoothness, noise gradients, glow jitter, legacy bevels or patterns missing from the file are
   drawn approximately) or
   `dropped` (Brightness/Contrast, Exposure, Channel Mixer, Gradient Map, Selective Color and
   Color Lookup adjustments). Tell the user what would be lost before `import_psd` when anything
   is not `mapped`.
2. **Layer effects come in live**: every Photoshop layer style maps to an effect you can read
   with `list_layer_effects` and change as usual, with the file's patterns (listed in
   `list_layer_effects.patterns`) and its global light. An effects block the editor cannot read
   is kept and written back by `export_psd`, but not drawn; the warnings say so.
3. **`import_psd` replaces the document** (one undo step). 16- and 32-bit files keep their
   depth (`get_image_info.bitDepth`). CMYK files are converted to RGB through their embedded (or
   the default coated) CMYK profile and stay in CMYK mode, Lab files stay in Lab mode, so
   `export_psd` writes them back as they came (`set_color_mode`); grayscale and indexed files are
   converted to RGB; an RGB file's ICC profile becomes the document's colour profile. The
   warnings say what changed. `export_psd` writes at the document's depth, mode and profile.
   Change the depth with `set_bit_depth`: 16-bit for smooth gradients and strong grades, 32-bit
   for linear-light HDR (layers blend in linear light there). Adjustment layers, blend modes,
   merges and the exported merged image keep the depth; layer effects, layer filters, painting
   and transforms still work in 8 bits on what they change, so grade a deep file with adjustment
   layers rather than repainting it when the depth matters. Afterwards work with `list_layers` as
   usual: there is no Background source image, every pixel comes from the layers.
4. **Smart objects come in live**: embedded contents (a PSB opens as a nested document you can
   edit with `edit_smart_object_contents`, a PNG as raster contents), the placement and warp, the
   smart filters and the filter mask; the layer shows Photoshop's own pixels until you change it.
   JPEG, TIFF and SVG contents are decoded only in a browser, so elsewhere such a smart object
   cannot be transformed (the error says so). Photoshop filters we do not model stay in the list
   (kind `psd`): hide, reorder, re-blend or remove them, and `export_psd` writes them back.
5. **`export_psd` writes the stack as it is**, in the source frame: crop and rotation are not
   applied, layer filters and depth masks are baked, annotation layers are rasterized (only in
   a browser). Effects are written as Photoshop layer styles: an effects block opened from a PSD
   goes back byte for byte while its effects are unchanged, and the patterns effects use (the
   built-in ones too) are embedded. Only the first outer glow, inner glow, bevel, satin and
   pattern overlay of a layer fit in a PSD. Smart objects are written as smart objects (an
   unchanged one byte for byte); a Develop smart filter has no Photoshop filter and is left out of
   the list (the pixels still show it). Read its `warnings` and pass them on. The file comes back as base64 (`data`).
