/**
 * Brush packs people already own, read into facet brushes and image sources:
 *
 * - Photoshop `.abr`: each sampled tip becomes an image source and a stamp-tip brush (named and
 *   spaced as its preset says, where the file says it); each computed tip a round or flat brush.
 * - Procreate `.brush` and `.brushset` (ZIP archives): each brush's `Shape.png` becomes its image
 *   tip and `Grain.png` its tip grain (Procreate's sources are white on black), with the name and
 *   spacing from `Brush.archive`.
 *
 * What a pack has that the facet model doesn't map (dynamics, pencil curves, patterns, dual
 * brushes, wet mixing) is listed in `unsupported`, and licence or terms files inside the pack are
 * kept as `licence` notes and on every source. Nothing here writes to a library:
 * `BrushLibrary.importFile` does that, with the brushes and sources returned.
 */

import { BRUSH_ID } from '../../paint-editor/brush-model';
import { brushSourceFromMask, brushSourceRef, makeBrushSource, type BrushSource } from '../sources';
import type { BrushLibrary, ImportBrushesResult } from '../library';
import type { Brush } from '../types';
import { readAbr } from './abr';
import { isBinaryPlist, keyedArchiveRoot, readBinaryPlist } from './bplist';
import { isZip, readZip, type ZipEntry } from './zip';

export type BrushPackFormat = 'abr' | 'brush' | 'brushset';
export const BRUSH_PACK_FORMATS: readonly BrushPackFormat[] = ['abr', 'brush', 'brushset'];

/** Largest pack read, bytes. */
export const MAX_BRUSH_PACK_BYTES = 64 * 1024 * 1024;
/** Most brushes taken from one pack. */
export const MAX_PACK_BRUSHES = 300;

export interface ReadBrushPackOptions {
  /** The pack's file name: names the brushes and ids, and picks the format by its extension. */
  fileName: string;
  /** Default: from the extension, then from the contents. */
  format?: BrushPackFormat;
  /** Id prefix for the brushes and sources (default: from the file name). */
  prefix?: string;
  /** The licence or terms the pack came with (kept with every source, before any found in the pack). */
  licence?: string;
}

export interface BrushPack {
  format: BrushPackFormat;
  brushes: Brush[];
  sources: BrushSource[];
  /** What was not imported or not mapped, in words. */
  unsupported: string[];
  /** Licence and terms notes: the one given, then any found in the pack. */
  licence: string[];
}

export class BrushPackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrushPackError';
  }
}

const slug = (s: string, max = 40) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
const stem = (fileName: string) => fileName.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]+$/i, '');
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The format of a pack: as given, by its extension, or by its contents. */
export function brushPackFormat(bytes: Uint8Array, fileName: string, format?: BrushPackFormat): BrushPackFormat {
  if (format) return format;
  const ext = /\.([a-z]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  if (ext === 'abr' || ext === 'brush' || ext === 'brushset') return ext;
  if (isZip(bytes)) return 'brushset';
  if (bytes.length >= 2 && [1, 2, 6, 7, 10].includes((bytes[0] << 8) | bytes[1])) return 'abr';
  throw new BrushPackError(`"${fileName}" is not a brush pack this reads: give a .abr (Photoshop), .brush or .brushset (Procreate) file.`);
}

/** Ids unique within the pack. */
function idMaker(prefix: string) {
  const used = new Set<string>();
  return (name: string) => {
    const base = `${prefix}-${slug(name, 20) || 'brush'}`.slice(0, 58).replace(/-+$/, '');
    let id = base;
    for (let n = 2; used.has(id) || !BRUSH_ID.test(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };
}

/** Text of a licence file in a pack (UTF-8, or RTF with its control words dropped), at most 4000 characters. */
function licenceText(name: string, bytes: Uint8Array): string | null {
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 64 * 1024));
  if (/\.rtf$/i.test(name)) text = text.replace(/\\[a-z]+-?\d* ?|[{}]/gi, '');
  text = text.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return text ? `${stem(name)}: ${text.slice(0, 4000)}` : null;
}

const LICENCE_FILE = /(^|\/)[^/]*(licen[cs]e|terms|eula|readme|copyright)[^/]*\.(txt|md|rtf)$/i;

function readAbrPack(bytes: Uint8Array, name: string, prefix: string, licence: string | undefined, pack: BrushPack): void {
  const file = readAbr(bytes);
  pack.unsupported.push(...file.unsupported);
  const id = idMaker(prefix);
  file.tips.slice(0, MAX_PACK_BRUSHES).forEach((tip, i) => {
    const label = tip.name ?? `${name} ${i + 1}`;
    const brushId = id(tip.name ?? String(i + 1));
    const base = { id: brushId, name: label.slice(0, 80), kind: 'mark' as const, tags: ['imported'], description: `Imported from ${name}.abr.` };
    if (tip.kind === 'computed') {
      pack.brushes.push({ ...base, tip: { shape: tip.roundness < 1 ? 'flat' : 'round', size: tip.diameter, hardness: tip.hardness, spacing: tip.spacing, roundness: tip.roundness, angle: tip.angle } });
      return;
    }
    try {
      const source = brushSourceFromMask({ id: `${brushId}-shape`, name: label, licence, origin: `${name}.abr` }, tip.width, tip.height, tip.mask);
      pack.sources.push(source);
      pack.brushes.push({ ...base, tip: { shape: 'stamp', size: clamp(Math.max(tip.width, tip.height), 1, 2500), spacing: tip.spacing ?? 0.25, stamps: [brushSourceRef(source.id)] } });
    } catch (e) {
      pack.unsupported.push(`"${label}": ${(e as Error).message}`);
    }
  });
  if (file.tips.length > MAX_PACK_BRUSHES) pack.unsupported.push(`Only the first ${MAX_PACK_BRUSHES} of ${file.tips.length} tips were imported.`);
}

function readProcreatePack(bytes: Uint8Array, name: string, prefix: string, licence: string | undefined, pack: BrushPack): void {
  let entries: ZipEntry[];
  try {
    entries = readZip(bytes);
  } catch (e) {
    throw new BrushPackError(`"${name}" can't be read as a Procreate brush pack: ${(e as Error).message}`);
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  // Licence and terms files found in the pack, after the licence given.
  const found: string[] = [];
  for (const e of entries) {
    if (!LICENCE_FILE.test(e.name) || e.size > 1024 * 1024) continue;
    const text = licenceText(e.name, e.read());
    if (text) found.push(text);
  }
  pack.licence.push(...found);
  const terms = found.length ? found.join('\n\n').slice(0, 2000) : undefined;
  const dirs = entries.filter((e) => /(^|\/)Brush\.archive$/.test(e.name)).map((e) => e.name.slice(0, -'Brush.archive'.length));
  if (!dirs.length) throw new BrushPackError(`"${name}" has no Procreate brushes (no Brush.archive inside).`);
  const id = idMaker(prefix);
  dirs.slice(0, MAX_PACK_BRUSHES).forEach((dir, i) => {
    let settings: Record<string, unknown> | null = null;
    try {
      const archive = byName.get(`${dir}Brush.archive`)!.read();
      if (isBinaryPlist(archive)) settings = keyedArchiveRoot(readBinaryPlist(archive));
    } catch {
      settings = null;
    }
    const own = typeof settings?.name === 'string' && settings.name.trim() ? settings.name.trim() : null;
    const label = (own ?? (dirs.length === 1 ? name : `${name} ${i + 1}`)).slice(0, 80);
    const brushId = id(own ?? String(i + 1));
    const where = `${name}${dir ? `/${dir.replace(/\/$/, '')}` : ''}`;
    const source = (file: string, kind: 'shape' | 'grain'): BrushSource | null => {
      const e = byName.get(`${dir}${file}`);
      if (!e) return null;
      try {
        const s = makeBrushSource({ id: `${brushId}-${kind}`, name: `${label} ${kind}`, image: e.read(), channel: 'lightness', licence: [licence, terms].filter(Boolean).join('\n\n') || undefined, origin: `${where}/${file}` });
        pack.sources.push(s);
        return s;
      } catch (err) {
        pack.unsupported.push(`"${label}" ${kind}: ${(err as Error).message}`);
        return null;
      }
    };
    const shape = source('Shape.png', 'shape');
    const grain = source('Grain.png', 'grain');
    const plot = typeof settings?.plotSpacing === 'number' && settings.plotSpacing > 0 ? clamp(settings.plotSpacing, 0.01, 10) : undefined;
    pack.brushes.push({
      id: brushId,
      name: label,
      kind: 'mark',
      tags: ['imported', 'procreate'],
      description: `Imported from ${name}.`,
      tip: {
        shape: shape ? 'stamp' : 'round',
        size: 40,
        ...(plot !== undefined ? { spacing: plot } : {}),
        ...(shape ? { stamps: [brushSourceRef(shape.id)] } : {}),
        ...(grain ? { grain: { source: brushSourceRef(grain.id), mode: 'moving' as const } } : {}),
      },
    });
    if (!settings) pack.unsupported.push(`"${label}": its Brush.archive could not be read; the brush takes its name from the file and default settings.`);
  });
  if (dirs.length > MAX_PACK_BRUSHES) pack.unsupported.push(`Only the first ${MAX_PACK_BRUSHES} of ${dirs.length} brushes were imported.`);
  pack.unsupported.push('Procreate settings other than the name, shape, grain and spacing (dynamics, Apple Pencil curves, taper, wet mix, colour dynamics, rendering modes) are not mapped.');
}

/** The brushes and sources of a pack (see the module comment). Throws a `BrushPackError` when nothing can be read from it. */
export function readBrushPack(bytes: Uint8Array, options: ReadBrushPackOptions): BrushPack {
  if (bytes.length > MAX_BRUSH_PACK_BYTES) throw new BrushPackError(`"${options.fileName}" is ${bytes.length} bytes; packs over ${MAX_BRUSH_PACK_BYTES} bytes are not read.`);
  const format = brushPackFormat(bytes, options.fileName, options.format);
  const name = stem(options.fileName) || 'Brushes';
  const prefix = slug(options.prefix ?? name) || 'pack';
  const licence = options.licence?.trim() ? options.licence.trim().slice(0, 2000) : undefined;
  const pack: BrushPack = { format, brushes: [], sources: [], unsupported: [], licence: licence ? [licence] : [] };
  try {
    if (format === 'abr') readAbrPack(bytes, name, prefix, licence, pack);
    else readProcreatePack(bytes, name, prefix, licence, pack);
  } catch (e) {
    throw e instanceof BrushPackError ? e : new BrushPackError(`"${options.fileName}" can't be read: ${(e as Error).message}`);
  }
  if (!pack.brushes.length) throw new BrushPackError(`"${options.fileName}" has no brushes that can be imported. ${pack.unsupported.join(' ')}`.trim());
  return pack;
}

export interface ImportBrushPackResult {
  format: BrushPackFormat;
  /** The brushes added or replaced. */
  brushes: Array<{ id: string; name: string }>;
  /** The image sources added or replaced. */
  sources: string[];
  /** Brush ids already in the library (or built in), left as they were. */
  skipped: string[];
  unsupported: string[];
  licence: string[];
  /** What normalising the brushes changed. */
  problems: string[];
}

/**
 * Reads a pack (`readBrushPack`) and adds its brushes and sources to `library` in one import.
 * Brush ids already saved are skipped unless `overwrite`.
 */
export async function importBrushPack(library: Pick<BrushLibrary, 'importFile'>, bytes: Uint8Array, options: ReadBrushPackOptions & { overwrite?: boolean }): Promise<ImportBrushPackResult> {
  const pack = readBrushPack(bytes, options);
  const r = await library.importFile({ format: 'pixerate-brushes', version: 2, brushes: pack.brushes, sources: pack.sources }, { overwrite: !!options.overwrite });
  const done = new Set([...r.added, ...r.replaced]);
  return {
    format: pack.format,
    brushes: pack.brushes.filter((b) => done.has(b.id)).map((b) => ({ id: b.id, name: b.name })),
    sources: r.sources ?? [],
    skipped: r.skipped,
    unsupported: pack.unsupported,
    licence: pack.licence,
    problems: r.problems,
  };
}

/**
 * Imports a file a person picked into `library`: a brush library file (`.json`) or a brush pack
 * (`.abr`, `.brush`, `.brushset`), by its name. Returns what `importFile` or `importBrushPack` did.
 */
export async function importBrushFile(library: Pick<BrushLibrary, 'importFile'>, file: Blob & { name: string }, options: { overwrite?: boolean; licence?: string } = {}): Promise<ImportBrushesResult | ImportBrushPackResult> {
  if (/\.json$/i.test(file.name)) {
    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      throw new BrushPackError(`"${file.name}" is not JSON.`);
    }
    return library.importFile(raw, { overwrite: !!options.overwrite });
  }
  return importBrushPack(library, new Uint8Array(await file.arrayBuffer()), { fileName: file.name, ...options });
}
