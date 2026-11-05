import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WGSL_SHADE } from '../src/paint/wet/gpu-kernels';

/**
 * The Swift editors' Metal shading of wet paint is the core's `WGSL_SHADE` translated by naga
 * (`scripts/gen-msl.mjs`). CI has no naga, so this checks the WGSL hash the generated file records:
 * after changing a kernel, run `pnpm build && pnpm gen:msl` and commit the Swift.
 */
describe('generated Metal shaders', () => {
  const file = fileURLToPath(new URL('../../swift/Sources/PixeratePaint/GeneratedShaders/WetShaders.swift', import.meta.url));
  const swift = readFileSync(file, 'utf8');

  it('were made from the current WGSL_SHADE (run pnpm gen:msl after a kernel change)', () => {
    const recorded = /let WET_SHADE_WGSL_SHA256 = "([0-9a-f]{64})"/.exec(swift)?.[1];
    expect(recorded).toBe(createHash('sha256').update(WGSL_SHADE).digest('hex'));
  });

  it('bind every buffer at its WGSL binding', () => {
    for (const m of WGSL_SHADE.matchAll(/@binding\((\d+)\)\s*var(?:<[^>]*>)?\s+(\w+)\s*:/g)) expect(swift).toContain(`${m[2]} [[buffer(${m[1]})]]`);
    expect(swift).not.toContain('fake0');
  });
});
