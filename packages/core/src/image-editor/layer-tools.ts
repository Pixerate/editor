import type { AgentTool } from '../tools/registry.js';
import type { ImageEditorController } from './controller';
import { contentBounds } from '../raster/surface';
import type { CropBox } from './types';
import type { ImageLayer, RasterMask } from './layers/model';
import { adjustmentKindLabel } from './adjustment-layers';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const round = (n: number, digits = 3) => Math.round(n * 10 ** digits) / 10 ** digits;

/** A short description of a mask for agents (no pixels). */
export function maskSummary(mask: RasterMask | undefined): Record<string, unknown> | null {
  if (!mask) return null;
  const out: Record<string, unknown> = {
    kind: mask.source ? 'depth' : 'raster',
    enabled: mask.enabled !== false,
    density: mask.density ?? 1,
    feather: mask.feather ?? 0,
  };
  if (!mask.source) {
    out.defaultValue = mask.defaultValue;
    out.paintedBounds = contentBounds(mask.surface);
  }
  return out;
}

/**
 * A plain description of a layer (and its children) for agents: ids, types, names, document
 * bounds, visibility, opacity, fill, blend, clipping, locks, mask summary and whether it is
 * active. `boundsOf` gives a pixel layer's document bounds.
 */
export function describeLayer(
  layer: ImageLayer,
  activeId: string | null,
  boundsOf: (layer: ImageLayer) => CropBox | null
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: layer.id,
    type: layer.type,
    name: layer.name || (layer.type === 'adjustment' ? adjustmentKindLabel(layer.kind) : ''),
    visible: layer.visible,
    opacity: round(layer.opacity),
    blend: layer.blend,
    clipped: Boolean(layer.clipped),
    locks: layer.locks ? { ...layer.locks } : {},
    mask: maskSummary(layer.mask),
    active: layer.id === activeId,
  };
  switch (layer.type) {
    case 'pixel': {
      out.bounds = boundsOf(layer);
      out.offset = { ...layer.offset };
      out.fillOpacity = round(layer.fillOpacity ?? 1);
      out.filters = (layer.filters ?? []).map((f) => ({ ...f }));
      if (layer.source === 'document') out.source = 'document';
      break;
    }
    case 'adjustment':
      out.kind = layer.kind;
      out.params = JSON.parse(JSON.stringify(layer.params));
      break;
    case 'annotation':
      out.annotation = { id: layer.annotation.id, type: layer.annotation.type };
      break;
    case 'group':
      out.collapsed = Boolean(layer.collapsed);
      out.children = layer.children.map((c) => describeLayer(c, activeId, boundsOf));
      break;
  }
  return out;
}

/**
 * Agent tools for the image editor's layer stack: `list_layers` (read). Layer writes arrive with
 * the layer operations.
 */
export function createImageLayerTools(controller: ImageEditorController): AgentTool[] {
  const listLayers: AgentTool = {
    name: 'list_layers',
    title: 'List image layers',
    description:
      'Returns the layer stack bottom to top as a tree: id, type (pixel, adjustment, group, annotation), name, document bounds (pixel layers), visible, opacity, fillOpacity, blend, clipped, locks, a mask summary, filters (pixel layers), kind and params (adjustment layers), children (groups) and which layer is active. Also returns the active layer id and target (pixels or mask) and the canvas size.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'List image layers', ...READ },
    handler: () => {
      const s = controller.getState();
      return {
        canvas: { ...s.imageDimensions },
        activeLayerId: s.activeLayerId,
        activeTarget: s.activeTarget,
        layers: s.layers.map((l) => describeLayer(l, s.activeLayerId, (x) => controller.getLayerBounds(x.id))),
      };
    },
  };
  return [listLayers];
}
