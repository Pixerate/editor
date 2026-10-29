---
"@pixerate/editor": minor
"@pixerate/editor-svelte": minor
"@pixerate/editor-react": minor
---

Layer styles (drop shadow, stroke, glow…) are now part of Layer Properties, and Effects means provider effects only. `layerPanels()` no longer returns the `effects` (Layer Effects) or `smart-filters` panels, with or without an effects provider. The `properties` panel holds the layer's Layer Style, and Svelte's `<LayerPanel panelId="properties">` renders it for every layer except adjustment layers. `<ImageProviderEffectsPanel>` (React and Svelte) shows an effect layer's controls and the layer's filters, added with an "Add filter…" button. It no longer lists or adds layer styles. `<LayerEffectsPanel>` is titled "Layer Style", and its menu is labelled "Add style". `LayerPanel` still renders the `effects` and `smart-filters` ids for hosts that ask for them directly. Agent tools are unchanged.
