import { describe, it, expect } from 'vitest';
import { measureGrowth } from './helpers/growth';

// The retries in measureGrowth absorb noise; they must not hide real growth.
describe('measureGrowth', () => {
  const linear = (n: number) => () => {
    let x = 0;
    for (let i = 0; i < n; i++) x += i & 7;
    return x;
  };
  const quadratic = (n: number) => () => {
    let x = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) x += (i ^ j) & 7;
    return x;
  };

  it('passes linear work', { timeout: 60_000 }, () => {
    expect(measureGrowth(linear(250_000), linear(1_000_000), { limit: 10 })).toBeLessThan(10);
  });

  it('fails quadratic work on every attempt', { timeout: 60_000 }, () => {
    expect(measureGrowth(quadratic(500), quadratic(2_000), { limit: 10 })).toBeGreaterThan(10);
  });
});
