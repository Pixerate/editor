import type { AgentTool } from '../tools/registry.js';
import type { ImageEditorController } from './controller';
import { describeLayer } from './layer-tools';
import { base64ToBytes, bytesToBase64 } from '../raster/png';
import { PsdError } from './psd/binary';
import { importPsd } from './psd/import';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const DATA = {
  type: 'string',
  minLength: 1,
  description: 'The PSD or PSB file as base64 (a `data:` URL prefix is accepted).',
} as const;

/** Base64 (or a data URL) → bytes, refusing anything that is not base64 text. */
export function psdBytesFromBase64(data: unknown): Uint8Array {
  if (typeof data !== 'string' || !data.trim()) throw new PsdError('data is required: the PSD file as base64.');
  const body = data.trim().replace(/^data:[^,]*;base64,/i, '');
  if (!/^[A-Za-z0-9+/=_\s-]+$/.test(body)) throw new PsdError('data is not base64; send the PSD file bytes base64-encoded.');
  const bytes = base64ToBytes(body);
  if (bytes.length < 26) throw new PsdError(`data decodes to ${bytes.length} bytes, too short for a PSD (at least 26).`);
  return bytes;
}

/**
 * Agent tools for Photoshop files: `inspect_psd` (what a file holds and how it would map),
 * `import_psd` (open it as the document) and `export_psd` (the document as a PSD).
 */
export function createImagePsdTools(controller: ImageEditorController): AgentTool[] {
  const inspect: AgentTool = {
    name: 'inspect_psd',
    title: 'Inspect a PSD',
    description:
      'Reads a PSD / PSB without opening it: size, bit depth, colour mode, resolution, and every layer (bottom first, a group before its children) with its PSD kind, the layer type it would become and its status (mapped, approximated or dropped, with notes), plus the import warnings. Changes nothing. Call before import_psd to see what would be lost.',
    inputSchema: { type: 'object', properties: { data: DATA }, required: ['data'], additionalProperties: false },
    annotations: { title: 'Inspect a PSD', ...READ },
    handler: ({ data }) => {
      const res = importPsd(psdBytesFromBase64(data), { skipPixels: true });
      return {
        width: res.width,
        height: res.height,
        ...res.info,
        resolution: res.resolution ?? null,
        layers: res.summary.map(({ id: _id, ...s }) => s),
        warnings: res.warnings,
      };
    },
  };

  const open: AgentTool = {
    name: 'import_psd',
    title: 'Open a PSD as the document',
    description:
      'Opens a PSD / PSB as the document, replacing the current layers, crop and rotation (one undo step; undo brings the previous document back). Pixel, group and adjustment layers, masks, blend modes, opacity, fill, clipping, visibility, locks, layer effects (with the patterns and global light of the file) map directly; type, smart-object, fill and shape layers come in as their pixels; unsupported adjustments are left out. Returns the new layer tree with ids, the size and the warnings (each names the affected layers).',
    inputSchema: { type: 'object', properties: { data: DATA }, required: ['data'], additionalProperties: false },
    annotations: { title: 'Open a PSD as the document', ...DESTRUCTIVE },
    handler: ({ data }) => {
      const res = controller.loadPsd(psdBytesFromBase64(data));
      const s = controller.getState();
      return {
        width: res.width,
        height: res.height,
        layerIds: res.layerIds,
        layers: s.layers.map((l) => describeLayer(l, s.activeLayerId, (x) => controller.getLayerBounds(x.id))),
        activeLayerId: s.activeLayerId,
        warnings: res.warnings,
      };
    },
  };

  const save: AgentTool = {
    name: 'export_psd',
    title: 'Export the document as a PSD',
    description:
      'Writes the document as an 8-bit RGB PSD (a PSB above 30000 px) with real layers, groups, adjustment layers, masks and layer effects (an effects block opened from a PSD is written back unchanged while its effects are; the patterns effects use are embedded), in the source frame (crop and rotation are not applied). Layer filters and depth masks are baked, annotation layers are rasterized (in a browser; elsewhere left out), and the merged image is the editor\'s composite. Changes nothing. Returns the file as base64, its size in bytes, whether it is a PSB, and warnings for everything that was changed or left out.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Export the document as a PSD', ...READ },
    handler: async () => {
      const res = await controller.toPsd();
      return {
        data: bytesToBase64(res.bytes),
        mimeType: 'image/vnd.adobe.photoshop',
        size: res.bytes.length,
        psb: res.psb,
        width: res.width,
        height: res.height,
        warnings: res.warnings,
      };
    },
  };

  return [inspect, open, save];
}
