import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The feature matrix (`parity/features.json`) is the source of the README "Feature parity" section
 * and the demo's parity tab, and every component, hook, factory and type its cells name exists in
 * that package (core, React, Svelte or Swift). After a change, run `node scripts/parity.mjs`.
 */
describe('the feature matrix', () => {
  it('is current and names only APIs that exist', () => {
    const script = fileURLToPath(new URL('../../../scripts/parity.mjs', import.meta.url));
    let output = '';
    try {
      execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' });
    } catch (e) {
      output = String((e as { stderr?: Buffer }).stderr ?? e);
    }
    expect(output).toBe('');
  });
});
