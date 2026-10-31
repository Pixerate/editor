---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Live edge colour on a cutout (#392, item 2). These are layer properties applied when compositing, so nothing is baked:
- **Decontamination:** unmixes the old background from a soft mask edge. It uses the pixels the mask hides.
- **Despill:** takes the old background's hue out of the edge and keeps luminance. It's a heuristic and leaves bounced light alone.
- **Live cast:** tints the edge with what is behind the layer, sampled live, or with a fixed colour.

API changes:
- **Core:** a generic `LayerEdgeColor` (`layer.edge`) in the raster engine. The 8-bit and 16/32-bit compositors apply the live cast. Decontamination and despill run with the layer's own filters, over the canvas (`applyEdgeUnmix`, `despillEdge`).
- **Controller:** `getEdgeColor` and `setEdgeColor`, which validate before changing anything and record one undo step.
- **Agent tools:** `get_edge_color`, `set_edge_decontamination`, `set_edge_despill` and `set_edge_ambient`.
- **Documents:** settings are saved in documents. PSD export bakes decontamination and despill into the pixels and warns that the live cast is left out.
- **React and Svelte:** an `EdgeColorPanel` (Edge Colour in the Layers panel) with one undo step per slider drag.
