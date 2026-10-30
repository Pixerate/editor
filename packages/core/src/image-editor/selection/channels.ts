import {
  deserializeSelection,
  serializeSelection,
  type SelectionMask,
  type SerializedSelection,
} from './mask';

/**
 * An alpha channel: a saved selection kept with the document (Select › Save Selection), shown
 * as a tinted overlay when visible. Its mask is the selection's 8-bit coverage over the canvas
 * (immutable, so undo steps share it).
 */
export interface AlphaChannel {
  id: string;
  name: string;
  /** Coverage (255 = selected). An empty channel has a mask with `bounds: null`. */
  mask: SelectionMask;
  /** Overlay tint, `#rrggbb` (default red, the Quick Mask's). */
  color: string;
  /** Overlay opacity 0..1 (default 0.5). */
  opacity: number;
  /** Whether the tint covers the `masked` (unselected, default) or the `selected` area. */
  indicates: 'masked' | 'selected';
  /** Shown as an overlay on the canvas (default false). */
  visible: boolean;
}

/** An alpha channel as stored in a document. */
export interface SerializedAlphaChannel extends Omit<AlphaChannel, 'mask'> {
  mask: SerializedSelection;
}

export const DEFAULT_CHANNEL_COLOR = '#ff0000';

/** A summary of a channel for agents and panels (no pixels). */
export function describeChannel(channel: AlphaChannel) {
  const { mask, ...rest } = channel;
  let sum = 0;
  for (let i = 0; i < mask.data.length; i++) sum += mask.data[i];
  const percent = Math.round((sum / 255 / Math.max(1, mask.data.length)) * 10000) / 100;
  return { ...rest, bounds: mask.bounds, percent };
}

export function serializeChannels(channels: readonly AlphaChannel[]): SerializedAlphaChannel[] {
  return channels.map((c) => ({ ...c, mask: serializeSelection(c.mask) }));
}

/** Restores stored channels, skipping (and reporting) damaged ones or ones of another size. */
export function deserializeChannels(value: unknown, size: { width: number; height: number }, problems: string[] = []): AlphaChannel[] {
  if (!Array.isArray(value)) return [];
  const out: AlphaChannel[] = [];
  for (const raw of value) {
    const v = raw as Partial<SerializedAlphaChannel>;
    try {
      const mask = deserializeSelection(v.mask);
      if (mask.width !== size.width || mask.height !== size.height) throw new Error('the channel is a different size from the canvas');
      out.push({
        id: typeof v.id === 'string' && v.id ? v.id : `ch_${out.length + 1}`,
        name: typeof v.name === 'string' && v.name.trim() ? v.name : `Alpha ${out.length + 1}`,
        mask,
        color: typeof v.color === 'string' && /^#[0-9a-f]{6}$/i.test(v.color) ? v.color : DEFAULT_CHANNEL_COLOR,
        opacity: typeof v.opacity === 'number' && v.opacity >= 0 && v.opacity <= 1 ? v.opacity : 0.5,
        indicates: v.indicates === 'selected' ? 'selected' : 'masked',
        visible: v.visible === true,
      });
    } catch (err) {
      problems.push(`Alpha channel "${String(v?.name ?? '?')}" could not be read: ${err instanceof Error ? err.message : String(err)}.`);
    }
  }
  return out;
}

/** A channel's grey thumbnail (white = selected) as RGBA pixels, at most `maxSide` px. */
export function channelThumbnail(channel: AlphaChannel, maxSide = 64): { width: number; height: number; data: Uint8ClampedArray } {
  const { width: w, height: h, data } = channel.mask;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * k));
  const th = Math.max(1, Math.round(h * k));
  const out = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(h - 1, Math.floor((y + 0.5) / k));
    for (let x = 0; x < tw; x++) {
      const v = data[sy * w + Math.min(w - 1, Math.floor((x + 0.5) / k))];
      out.set([v, v, v, 255], (y * tw + x) * 4);
    }
  }
  return { width: tw, height: th, data: out };
}
