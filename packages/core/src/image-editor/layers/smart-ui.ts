/**
 * The smart object section of the layers panel, shared by the React and Svelte panels: what to
 * show for the active smart object (contents, linked instances, the smart filter stack and its
 * mask), the controls of one smart filter, and the file helpers behind Replace Contents and
 * Export Contents. Framework-free.
 */

import type { ImageEditorController } from '../controller';
import { BLEND_MODES } from '../blend';
import { blobBytes } from '../psd/ui';
import { bytesToBase64, decodePng, isPng } from '../../raster/png';
import { isLayerLocked, type ImageLayer, type SmartFilter, type SmartObjectLayer } from './model';
import { smartFilterRows, type SmartFilterRow } from './panel';
import type { EffectControl } from './effects-ui';
import { instancesOf } from './smart';

/** What the smart object section shows. */
export interface SmartObjectPanelModel {
  /** False when the layer is not a smart object (`reason` says why). */
  available: boolean;
  reason?: string;
  layerId?: string;
  contents?: {
    name: string;
    kind: 'raster' | 'document';
    width: number;
    height: number;
    /** False for a file that could not be decoded here. */
    decoded: boolean;
    /** The external file of linked contents. */
    linkedPath: string | null;
    /** Smart objects placed from these contents (this one included). */
    instances: number;
  };
  /** The stack's master switch. */
  filtersEnabled: boolean;
  /** Top filter first. */
  filters: SmartFilterRow[];
  /** The filter mask, or `null`. */
  mask: { enabled: boolean; linked: boolean } | null;
  /** False while the layer is locked: everything shows, nothing changes. */
  editable: boolean;
}

/** The smart object section for `layerId` (default the active layer). */
export function smartObjectPanel(controller: ImageEditorController, layerId?: string | null): SmartObjectPanelModel {
  const layer = layerId ? controller.getLayer(layerId) : controller.getActiveLayer();
  if (!layer || layer.type !== 'smart') return { available: false, reason: 'Select a smart object (Convert to Smart Object in the layer menu).', filtersEnabled: true, filters: [], mask: null, editable: false };
  const c = layer.contents;
  const decoded = c.kind === 'raster' ? Boolean(c.raster) : Boolean(c.document);
  return {
    available: true,
    layerId: layer.id,
    contents: { name: c.name, kind: c.kind, width: c.width, height: c.height, decoded, linkedPath: c.linked?.path ?? null, instances: instancesOf(controller.getLayers(), c.id).length },
    filtersEnabled: layer.smartFilters?.enabled ?? true,
    filters: smartFilterRows(layer),
    mask: layer.smartFilters?.mask ? { enabled: layer.smartFilters.mask.enabled !== false, linked: layer.smartFilters.mask.linked !== false } : null,
    editable: !isLayerLocked(layer, 'all'),
  };
}

/** A short badge for smart object rows (with the number of linked instances when shared), or `null`. */
export function smartObjectBadge(layers: readonly ImageLayer[], layer: ImageLayer): { label: string; instances: number } | null {
  if (layer.type !== 'smart') return null;
  const n = instancesOf(layers, (layer as SmartObjectLayer).contents.id).length;
  return { label: n > 1 ? `Smart object, linked to ${n - 1} other${n > 2 ? 's' : ''}` : 'Smart object', instances: n };
}

/** The filters the "Add smart filter" menu offers. */
export const SMART_FILTER_MENU: ReadonlyArray<{ kind: 'develop' | 'blur'; label: string }> = [
  { kind: 'develop', label: 'Develop' },
  { kind: 'blur', label: 'Blur' },
];

const BLENDS = BLEND_MODES.filter((m) => m.id !== 'pigment').map((m) => ({ value: m.id as string, label: m.label }));

/**
 * The controls of one smart filter: blend mode and opacity (Blending Options), then its own
 * settings. A Photoshop filter we keep but do not draw has only the first two.
 */
export function smartFilterControls(f: SmartFilter): EffectControl[] {
  const out: EffectControl[] = [
    { key: 'blend', label: 'Mode', type: 'select', value: f.blend, options: BLENDS },
    { key: 'opacity', label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.01, value: f.opacity, percent: true, unit: '%' },
  ];
  if (f.kind === 'blur') out.push({ key: 'radius', label: 'Radius', type: 'range', min: 0, max: 50, step: 0.5, value: f.radius, unit: 'px' });
  if (f.kind === 'develop') {
    for (const [key, label] of [
      ['exposure', 'Exposure'],
      ['contrast', 'Contrast'],
      ['brightness', 'Brightness'],
      ['saturation', 'Saturation'],
      ['temperature', 'Temperature'],
      ['tint', 'Tint'],
    ] as const) {
      out.push({ key, label, type: 'range', min: -100, max: 100, step: 1, value: (f as unknown as Record<string, number>)[key] ?? 0 });
    }
  }
  return out;
}

/** The pixels or PSD bytes of a picked file, as `replaceSmartObjectContents` takes them. */
export async function replaceSmartObjectContentsFromFile(
  controller: ImageEditorController,
  layerId: string,
  file: Blob & { name?: string }
): Promise<{ contentsId: string; width: number; height: number; layerIds: string[] }> {
  const bytes = await blobBytes(file);
  const name = file.name || undefined;
  if (bytes[0] === 0x38 && bytes[1] === 0x42 && bytes[2] === 0x50 && bytes[3] === 0x53) return controller.replaceSmartObjectContents(layerId, { psd: bytes, name });
  if (isPng(bytes)) {
    try {
      const png = decodePng(bytes);
      return controller.replaceSmartObjectContents(layerId, { pixels: { width: png.width, height: png.height, data: png.data }, name });
    } catch {
      // Interlaced PNGs go through the browser below.
    }
  }
  const type = file.type || 'image/png';
  return controller.replaceSmartObjectContentsFromImage(layerId, `data:${type};base64,${bytesToBase64(bytes)}`, name);
}

/** Offers a smart object's contents as a download (in a browser). Returns the file name. */
export function downloadSmartObjectContents(controller: ImageEditorController, layerId: string): { fileName: string } {
  const f = controller.exportSmartObjectContents(layerId);
  if (typeof document !== 'undefined' && typeof URL !== 'undefined' && URL.createObjectURL) {
    const url = URL.createObjectURL(new Blob([f.bytes as BlobPart], { type: f.mimeType }));
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return { fileName: f.name };
}

/** Types the Replace Contents picker accepts. */
export const SMART_CONTENTS_ACCEPT = 'image/*,.psd,.psb,image/vnd.adobe.photoshop';
