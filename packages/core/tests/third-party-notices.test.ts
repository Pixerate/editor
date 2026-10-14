import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

describe('third-party notices', () => {
  it('ships an identical copy of the root THIRD_PARTY_NOTICES.md with the package', () => {
    expect(read('../THIRD_PARTY_NOTICES.md')).toBe(read('../../../THIRD_PARTY_NOTICES.md'));
  });

  it('is part of the published files', () => {
    const pkg = JSON.parse(read('../package.json')) as { files: string[] };
    expect(pkg.files).toContain('THIRD_PARTY_NOTICES.md');
  });
});
