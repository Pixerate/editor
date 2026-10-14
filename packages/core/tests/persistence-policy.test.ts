// Test cases re-expressed from filmcraft-main/apps/filmcraft-web/tests/recovery_policy.rs
// (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from "vitest";
import { createRecoveryPolicy, exponentialBackoff } from "../src/persistence";

const INTERVAL = 5;
const policy = () => createRecoveryPolicy({ interval: INTERVAL });

describe("createRecoveryPolicy", () => {
  it("retries a failed snapshot write after the interval without another edit", () => {
    const p = policy();
    expect(p.tick(0, 3, 0)).toEqual({ type: "writeSnapshot", revision: 3 });
    p.written(3, false, 0.1);
    // not immediately (no spinning on a failing disk)…
    expect(p.tick(1, 3, 0).type).toBe("wakeAfter");
    // …but once the interval has passed, with the revision unchanged
    expect(p.tick(0.1 + INTERVAL, 3, 0)).toEqual({ type: "writeSnapshot", revision: 3 });
    p.written(3, true, 5.2);
    expect(p.tick(20, 3, 0)).toEqual({ type: "nothing" });
  });

  it("ignores a failure reported for an older revision", () => {
    const p = policy();
    expect(p.tick(0, 1, 0)).toEqual({ type: "writeSnapshot", revision: 1 });
    expect(p.tick(INTERVAL, 2, 0)).toEqual({ type: "writeSnapshot", revision: 2 });
    p.written(1, false, INTERVAL);
    expect(p.tick(3 * INTERVAL, 2, 0)).toEqual({ type: "nothing" });
  });

  it("never marks an earlier session's snapshot clean on a clean start", () => {
    const p = policy();
    for (let t = 0; t < 100; t++) expect(p.tick(t, 0, 0)).toEqual({ type: "nothing" });
    expect(p.ownsSnapshot).toBe(false);
  });

  it("retires the snapshot this session wrote once the document is saved", () => {
    const p = policy();
    expect(p.tick(0, 1, 0).type).toBe("writeSnapshot");
    p.written(1, true, 0.1);
    expect(p.tick(1, 1, 1)).toEqual({ type: "writeClean" });
    expect(p.tick(1.1, 1, 1)).toEqual({ type: "nothing" });
    p.cleaned(true, 1.2);
    expect(p.ownsSnapshot).toBe(false);
    expect(p.tick(30, 1, 1)).toEqual({ type: "nothing" });
  });

  it("retries a failed clean write after the interval", () => {
    const p = policy();
    expect(p.tick(0, 1, 0).type).toBe("writeSnapshot");
    p.written(1, true, 0.1);
    expect(p.tick(1, 1, 1)).toEqual({ type: "writeClean" });
    p.cleaned(false, 1.1);
    expect(p.tick(2, 1, 1).type).toBe("wakeAfter");
    expect(p.tick(1.1 + INTERVAL, 1, 1)).toEqual({ type: "writeClean" });
  });

  it("keeps the snapshot owned when an edit lands during the clean write", () => {
    const p = policy();
    expect(p.tick(0, 1, 0).type).toBe("writeSnapshot");
    expect(p.tick(10, 1, 1)).toEqual({ type: "writeClean" });
    expect(p.tick(20, 2, 1)).toEqual({ type: "writeSnapshot", revision: 2 });
    p.cleaned(true, 20.1);
    expect(p.ownsSnapshot).toBe(true);
    // saved again: the newer snapshot must be retired too
    expect(p.tick(30, 2, 2)).toEqual({ type: "writeClean" });
  });

  it("writes at most once per interval while edits keep coming", () => {
    const p = policy();
    expect(p.tick(0, 1, 0).type).toBe("writeSnapshot");
    p.written(1, true, 0);
    expect(p.tick(1, 2, 0)).toEqual({ type: "wakeAfter", delay: 4 });
    expect(p.tick(5, 3, 0)).toEqual({ type: "writeSnapshot", revision: 3 });
  });

  it("force skips the interval and retry wait", () => {
    const p = policy();
    p.tick(0, 1, 0);
    p.written(1, false, 0);
    expect(p.tick(0.5, 1, 0, { force: true })).toEqual({ type: "writeSnapshot", revision: 1 });
  });

  it("uses an injected retry delay per consecutive failure", () => {
    const p = createRecoveryPolicy({ interval: 5, retryDelay: (n) => exponentialBackoff(n, 1, 30) });
    p.tick(0, 1, 0);
    p.written(1, false, 0);
    expect(p.failures).toBe(1);
    expect(p.tick(0.5, 1, 0)).toEqual({ type: "wakeAfter", delay: 0.5 });
    expect(p.tick(1, 1, 0).type).toBe("writeSnapshot");
    p.written(1, false, 1);
    expect(p.tick(2.5, 1, 0)).toEqual({ type: "wakeAfter", delay: 0.5 });
    expect(p.tick(3, 1, 0).type).toBe("writeSnapshot");
    p.written(1, true, 3);
    expect(p.failures).toBe(0);
  });
});

describe("exponentialBackoff", () => {
  // Re-expressed from craft-libs-main/crates/settings/tests/store.rs (retry_delay_doubles_and_caps).
  it("doubles and caps", () => {
    expect(exponentialBackoff(1)).toBe(1000);
    expect(exponentialBackoff(2)).toBe(2000);
    expect(exponentialBackoff(3)).toBe(4000);
    expect(exponentialBackoff(6)).toBe(30000);
    expect(exponentialBackoff(40)).toBe(30000);
  });
});
