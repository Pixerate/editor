---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Smart object UI in React and Svelte, in parity. A new `<SmartObjectPanel>` shows the active smart object's contents (name, size, linked instances) with Edit Contents, Replace Contents… (an image or a PSD), Export Contents, New via Copy and Rasterize; its smart filter stack (add Develop or Blur, the stack switch, each filter's eye, order, remove, and blend mode, opacity and settings when expanded, a slider drag being one undo step); and the filter mask (add, from selection, enable, link, paint, remove). `<LayersPanel>` shows it for smart objects (`smartObjects` prop, default true), badges smart object thumbnails (linked instances marked; double-click to Edit Contents), lists the smart filters under the row with their eyes and the filter mask thumbnail, enables Fill for smart objects, and shows a bar with Save & Close / Discard while contents are open. The layer menu gains Convert to Smart Object, Edit Contents, New Smart Object via Copy and Add Smart Filter Mask. Core adds the shared view model (`smartObjectPanel`, `smartObjectBadge`, `smartFilterControls`, `SMART_FILTER_MENU`), the file helpers `replaceSmartObjectContentsFromFile` and `downloadSmartObjectContents`, and `getLayerThumbnail({ filterMask: true })`.
