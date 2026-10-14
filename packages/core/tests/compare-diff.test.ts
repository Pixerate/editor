import { describe, it, expect } from "vitest";
import { diffChanges, diffSequences, type DiffRun } from "../src/compare";

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function lcsLength<T>(a: readonly T[], b: readonly T[]): number {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table[0][0];
}

/** Replays the script: equal and inserted items must rebuild `b`, equal and deleted `a`. */
function check<T>(a: readonly T[], b: readonly T[], runs: DiffRun[]) {
  const rebuiltA: T[] = [];
  const rebuiltB: T[] = [];
  let i = 0;
  let j = 0;
  for (const run of runs) {
    expect(run.length).toBeGreaterThan(0);
    expect(run.aIndex).toBe(i);
    expect(run.bIndex).toBe(j);
    for (let k = 0; k < run.length; k++) {
      if (run.type === "equal") {
        expect(a[i]).toEqual(b[j]);
        rebuiltA.push(a[i++]);
        rebuiltB.push(b[j++]);
      } else if (run.type === "delete") {
        rebuiltA.push(a[i++]);
      } else {
        rebuiltB.push(b[j++]);
      }
    }
  }
  expect(rebuiltA).toEqual(a);
  expect(rebuiltB).toEqual(b);
  return runs.filter((r) => r.type === "equal").reduce((n, r) => n + r.length, 0);
}

describe("diffSequences", () => {
  it("returns no changes for identical input", () => {
    const words = "the same words here".split(" ");
    expect(diffSequences(words, words)).toEqual([{ type: "equal", aIndex: 0, bIndex: 0, length: 4 }]);
    expect(diffSequences([], [])).toEqual([]);
  });

  it("finds insertions, deletions and replacements", () => {
    const a = "The quick brown fox jumps over the lazy dog".split(" ");
    const b = "The quick red fox leaps over the very lazy dog today".split(" ");
    const changes = diffChanges(a, b).map((c) => [c.kind, a.slice(c.aStart, c.aEnd).join(" "), b.slice(c.bStart, c.bEnd).join(" ")]);
    expect(changes).toEqual([
      ["replaced", "brown", "red"],
      ["replaced", "jumps", "leaps"],
      ["inserted", "", "very"],
      ["inserted", "", "today"],
    ]);
  });

  it("puts deletions before insertions within a changed stretch", () => {
    const runs = diffSequences(["a", "x", "c"], ["a", "y", "c"]);
    expect(runs.map((r) => r.type)).toEqual(["equal", "delete", "insert", "equal"]);
  });

  it("is minimal: equal items match a brute-force LCS on random small inputs", () => {
    const random = rng(7);
    for (let round = 0; round < 400; round++) {
      const alphabet = 2 + Math.floor(random() * 5);
      const gen = () =>
        Array.from({ length: Math.floor(random() * 14) }, () => String.fromCharCode(97 + Math.floor(random() * alphabet)));
      const a = gen();
      const b = gen();
      const equal = check(a, b, diffSequences(a, b));
      expect(equal).toBe(lcsLength(a, b));
    }
  });

  it("supports custom keys and equality", () => {
    const a = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const b = [{ id: 1 }, { id: 3 }];
    expect(diffSequences(a, b, { hash: (x) => x.id }).map((r) => r.type)).toEqual(["equal", "delete", "equal"]);
    const ci = diffSequences(["A", "b"], ["a", "B"], { equals: (x, y) => x.toLowerCase() === y.toLowerCase() });
    expect(ci).toEqual([{ type: "equal", aIndex: 0, bIndex: 0, length: 2 }]);
  });

  it("handles long documents with scattered edits via anchors", () => {
    const a = Array.from({ length: 20_000 }, (_, i) => `w${i}`);
    const b = [...a];
    for (const k of [100, 5000, 12_000, 19_000]) b[k] = `changed${k}`;
    b.splice(8000, 1);
    const started = performance.now();
    const changes = diffChanges(a, b);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(changes).toHaveLength(5);
    expect(changes.filter((c) => c.kind === "replaced")).toHaveLength(4);
    expect(changes.find((c) => c.kind === "deleted")).toMatchObject({ aStart: 8000, aEnd: 8001 });
    check(a, b, diffSequences(a, b));
  });

  it("finishes quickly on very different documents", () => {
    const a = Array.from({ length: 30_000 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 30_000 }, (_, i) => `b${i}`);
    const started = performance.now();
    const changes = diffChanges(a, b);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(changes).toEqual([{ kind: "replaced", aStart: 0, aEnd: 30_000, bStart: 0, bEnd: 30_000 }]);
  });

  it("stays correct on long repetitive inputs (few unique anchors)", () => {
    const random = rng(42);
    const a = Array.from({ length: 6000 }, () => ["the", "a", "of", "and"][Math.floor(random() * 4)]);
    const b = a.filter((_, i) => i % 97 !== 0);
    check(a, b, diffSequences(a, b));
    // Bounded equality-only mode replaces instead of searching forever.
    check(a, b, diffSequences(a, b, { equals: (x, y) => x === y, direct: 100 }));
  });
});
