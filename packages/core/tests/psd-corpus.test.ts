/**
 * Opt-in: reads every file of the public PSD corpus (psd-tools and ag-psd, both MIT), fetched by
 * `pnpm test:corpus` into corpus/psd/ (git-ignored). Run with PSD_CORPUS=1.
 *
 * For each file: opening must succeed or fail with a `PsdError` that says why (never another
 * exception), and every file that opens must export and reopen with the same layer tree.
 * PSD_CORPUS_REPORT=path writes a JSON report (status counts, warnings, merged-image error).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ImageEditorController, flattenLayers, type ImageLayer } from '../src/image-editor';
import { PsdError } from '../src/image-editor/psd/binary';
import { decodeMergedImage, readPsd } from '../src/image-editor/psd/file';
import { colorChannelCount, toRgba8, unmatteWhite } from '../src/image-editor/psd/pixels';
import { rowBytes } from '../src/image-editor/psd/compression';

const enabled = process.env.PSD_CORPUS === '1';
const root = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(__dirname, 'psd-corpus.manifest.json'), 'utf8')) as {
  files: Array<{ source: string; path: string; size: number }>;
};

const shape = (layers: readonly ImageLayer[]): unknown[] =>
  layers.map((l) => (l.type === 'group' ? [l.type, l.name, shape(l.children)] : [l.type, l.name]));

/** Mean absolute difference (0..255, alpha-weighted) between our composite and the file's merged image. */
function mergedError(bytes: Uint8Array, ours: ArrayLike<number>): number | null {
  const file = readPsd(bytes);
  const { header } = file;
  if (!file.layers.length) return null;
  let planes: Uint8Array;
  try {
    planes = decodeMergedImage(file);
  } catch {
    return null;
  }
  const size = rowBytes(header.width, header.depth) * header.height;
  const cc = colorChannelCount(header.colorMode, header.channels);
  const plane = (i: number) => (i < header.channels ? planes.subarray(i * size, (i + 1) * size) : undefined);
  const merged = toRgba8({
    width: header.width,
    height: header.height,
    depth: header.depth,
    mode: header.colorMode,
    color: Array.from({ length: cc }, (_, i) => plane(i)),
    alpha: header.channels > cc && file.mergedAlpha ? plane(cc) : undefined,
    palette: header.colorMode === 2 ? file.colorModeData : undefined,
  });
  if (header.channels > cc && file.mergedAlpha) unmatteWhite(merged);
  // Without a merged alpha channel, Photoshop's merged image is flattened over white.
  const flat = !(header.channels > cc && file.mergedAlpha);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < merged.length; i += 4) {
    const oa = ours[i + 3] / 255;
    const o = (c: number) => (flat ? ours[i + c] * oa + 255 * (1 - oa) : ours[i + c]);
    const a = flat ? 1 : Math.max(merged[i + 3], ours[i + 3]) / 255;
    for (let c = 0; c < 3; c++) sum += Math.abs(merged[i + c] - o(c)) * a;
    if (!flat) sum += Math.abs(merged[i + 3] - ours[i + 3]);
    n += flat ? 3 : 4;
  }
  return n ? sum / n : 0;
}

describe.skipIf(!enabled)('PSD corpus', () => {
  const report: Array<Record<string, unknown>> = [];

  it('the corpus is downloaded (pnpm test:corpus fetches it)', () => {
    const missing = manifest.files.filter((f) => !existsSync(join(root, 'corpus', 'psd', f.source, ...f.path.split('/'))));
    expect(missing.map((f) => f.path)).toEqual([]);
  });

  for (const f of manifest.files) {
    it(`${f.source}/${f.path}`, async () => {
      const bytes = new Uint8Array(readFileSync(join(root, 'corpus', 'psd', f.source, ...f.path.split('/'))));
      const entry: Record<string, unknown> = { file: `${f.source}/${f.path}`, size: f.size };
      report.push(entry);
      const c = new ImageEditorController({});
      let opened;
      try {
        opened = c.loadPsd(bytes);
      } catch (err) {
        // Unreadable files must say why, as a PsdError.
        expect(err, String(err)).toBeInstanceOf(PsdError);
        entry.error = (err as Error).message;
        return;
      }
      entry.width = opened.width;
      entry.height = opened.height;
      entry.layers = opened.summary.length;
      entry.status = opened.summary.reduce<Record<string, number>>((m, s) => ({ ...m, [s.status]: (m[s.status] ?? 0) + 1 }), {});
      entry.warnings = opened.warnings;
      const ours = c.compositePixels().data;
      entry.mergedError = mergedError(bytes, ours);

      const out = await c.toPsd();
      const d = new ImageEditorController({});
      d.loadPsd(out.bytes);
      expect(shape(d.getLayers())).toEqual(shape(c.getLayers()));
      expect(flattenLayers(d.getLayers()).length).toBe(flattenLayers(c.getLayers()).length);
      const again = d.compositePixels().data;
      let maxDiff = 0;
      for (let i = 0; i < ours.length; i++) maxDiff = Math.max(maxDiff, Math.abs(ours[i] - again[i]));
      entry.roundTripMaxDiff = maxDiff;
    }, 120_000);
  }

  it('writes the report, and our composites stay close to Photoshop\'s merged images', () => {
    const path = process.env.PSD_CORPUS_REPORT;
    if (path) writeFileSync(path, JSON.stringify(report, null, 2));
    expect(report.length).toBe(manifest.files.length);
    // Effects, type and unsupported adjustments make some files differ; the typical file must not.
    const errors = report.map((r) => r.mergedError).filter((e): e is number => typeof e === 'number').sort((a, b) => a - b);
    expect(errors[Math.floor(errors.length / 2)]).toBeLessThan(0.5);
    expect(report.filter((r) => r.error).map((r) => r.file)).toEqual([]);
  });
});
