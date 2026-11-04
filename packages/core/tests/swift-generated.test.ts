import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The Swift generated from `@pixerate/conformance` (`packages/swift/Sources/*` `/Generated`) is
 * current. After a contract changes, run `pnpm gen:swift` and commit; the Swift CI job then checks
 * the Swift still builds against it.
 */
describe('generated Swift', () => {
  it('matches the contracts (run pnpm gen:swift after a change)', () => {
    const script = fileURLToPath(new URL('../../../scripts/gen-swift.mjs', import.meta.url));
    expect(() => execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' })).not.toThrow();
  });
});
