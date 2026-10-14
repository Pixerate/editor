import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAutosaveController,
  createMemoryStorage,
  createRevisionTracker,
  formatRecoveryMessage,
  recoveryMetaKey,
  type AutosaveControllerOptions,
  type AutosaveStatus,
  type MemoryStorage,
} from "../src/persistence";
import { DirtyTracker, bindDirtyToHistory } from "../src/dirty";
import { HistoryManager } from "../src/history";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(
  overrides: Partial<AutosaveControllerOptions<{ text: string }>> & { storage?: MemoryStorage } = {},
) {
  const doc = { text: "" };
  let revision = 0;
  let saved = 0;
  const storage = overrides.storage ?? createMemoryStorage();
  const statuses: AutosaveStatus[] = [];
  const controller = createAutosaveController({
    key: "doc",
    getSnapshot: () => ({ ...doc }),
    revision: () => revision,
    savedRevision: () => saved,
    name: "Untitled",
    interval: 5000,
    debounceMs: 1000,
    onStatus: (info) => {
      if (statuses[statuses.length - 1] !== info.status) statuses.push(info.status);
    },
    ...overrides,
    storage,
  });
  const edit = (text: string) => {
    doc.text = text;
    revision++;
    controller.notify();
  };
  const save = () => {
    saved = revision;
  };
  const snapshot = () => storage.entries.get("doc");
  const meta = () => JSON.parse(storage.entries.get(recoveryMetaKey("doc")) ?? "null");
  return { controller, storage, edit, save, snapshot, meta, statuses, doc };
}

describe("createAutosaveController", () => {
  it("writes nothing before ready() (hydration gate)", async () => {
    const t = setup();
    t.edit("a");
    await vi.advanceTimersByTimeAsync(20000);
    expect(t.snapshot()).toBeUndefined();
    expect(t.controller.getStatus().status).toBe("dirty");
    t.controller.ready();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.snapshot()).toBe('{"text":"a"}');
    expect(t.controller.getStatus().status).toBe("saved");
  });

  it("debounces edits and writes the snapshot then a dirty meta", async () => {
    const t = setup({ ready: true });
    t.edit("a");
    await vi.advanceTimersByTimeAsync(500);
    t.edit("ab");
    await vi.advanceTimersByTimeAsync(900);
    expect(t.snapshot()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(t.snapshot()).toBe('{"text":"ab"}');
    expect(t.meta()).toMatchObject({ dirty: true, revision: 2, name: "Untitled", time: 1500 });
    expect(t.statuses).toEqual(["dirty", "saving", "saved"]);
  });

  it("writes at least every interval while edits keep coming", async () => {
    const t = setup({ ready: true });
    for (let i = 1; i <= 20; i++) {
      t.edit(`v${i}`);
      await vi.advanceTimersByTimeAsync(400);
    }
    // 8 s of continuous typing: the first pending change forces a write after 5 s.
    expect(t.snapshot()).toBe('{"text":"v13"}');
  });

  it("retries failed writes with exponential backoff, without another edit", async () => {
    let fail = true;
    const storage = createMemoryStorage({ failure: (op) => fail && op === "set" });
    const t = setup({ ready: true, storage, retryBaseMs: 1000, retryMaxMs: 4000 });
    t.edit("a");
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.controller.getStatus()).toMatchObject({ status: "error", failures: 1 });
    expect(t.controller.getStatus().nextAttemptAt).toBe(2000);
    await vi.advanceTimersByTimeAsync(1000); // retry 1 at t=2000 fails
    expect(t.controller.getStatus().failures).toBe(2);
    expect(t.controller.getStatus().nextAttemptAt).toBe(4000);
    await vi.advanceTimersByTimeAsync(2000); // retry 2 at t=4000 fails
    expect(t.controller.getStatus().failures).toBe(3);
    expect(t.controller.getStatus().nextAttemptAt).toBe(8000); // capped at 4 s
    await vi.advanceTimersByTimeAsync(4000); // t=8000 fails again → still capped
    expect(t.controller.getStatus().nextAttemptAt).toBe(12000);
    fail = false;
    await vi.advanceTimersByTimeAsync(4000);
    expect(storage.entries.get("doc")).toBe('{"text":"a"}');
    expect(t.controller.getStatus()).toMatchObject({ status: "saved", failures: 0, error: null });
  });

  it("flushNow skips the debounce and interval", async () => {
    const t = setup({ ready: true });
    t.edit("a");
    await t.controller.flushNow();
    expect(t.snapshot()).toBe('{"text":"a"}');
    t.edit("ab");
    await t.controller.flushNow();
    expect(t.snapshot()).toBe('{"text":"ab"}');
  });

  it("flushNow does nothing before ready()", async () => {
    const t = setup();
    t.edit("a");
    await t.controller.flushNow();
    expect(t.snapshot()).toBeUndefined();
  });

  it("markClean retires the snapshot this session wrote", async () => {
    const t = setup({ ready: true });
    t.edit("a");
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.meta().dirty).toBe(true);
    t.save();
    await t.controller.markClean();
    expect(t.meta()).toEqual({ dirty: false });
    expect(t.snapshot()).toBeUndefined();
    expect(t.controller.getStatus().status).toBe("saved");
  });

  it("an earlier session's snapshot survives a clean session and is offered for recovery", async () => {
    const storage = createMemoryStorage();
    const first = setup({ ready: true, storage });
    first.edit("unsaved work");
    await vi.advanceTimersByTimeAsync(1000);
    first.controller.destroy(); // crash

    const second = setup({ storage });
    const recovery = await second.controller.checkRecovery();
    expect(recovery).toMatchObject({
      snapshot: { text: "unsaved work" },
      meta: { dirty: true, name: "Untitled", revision: 1 },
    });
    // The new session never edits and "saves" (clean start): the old snapshot stays.
    second.controller.ready();
    await second.controller.markClean();
    await vi.advanceTimersByTimeAsync(60000);
    expect(JSON.parse(storage.entries.get("doc:meta")!).dirty).toBe(true);
    expect(await second.controller.checkRecovery()).not.toBeNull();

    expect(await second.controller.discardRecovery()).toBe(true);
    expect(await second.controller.checkRecovery()).toBeNull();
    expect(storage.entries.size).toBe(0);
  });

  it("restoring then editing replaces the old snapshot with this session's", async () => {
    const storage = createMemoryStorage({
      initial: { doc: '{"text":"old"}', "doc:meta": '{"dirty":true,"time":1}' },
    });
    const t = setup({ storage });
    const recovery = await t.controller.checkRecovery();
    t.edit(recovery!.snapshot!.text); // the app applies the snapshot
    t.controller.ready();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await t.controller.checkRecovery()).toBeNull(); // now this session's own
    expect(await t.controller.discardRecovery()).toBe(false);
    expect(t.meta().dirty).toBe(true);
  });

  it("checkRecovery ignores a clean meta, a missing snapshot, and reports parse errors", async () => {
    const clean = setup({ storage: createMemoryStorage({ initial: { doc: "{}", "doc:meta": '{"dirty":false}' } }) });
    expect(await clean.controller.checkRecovery()).toBeNull();
    const missing = setup({ storage: createMemoryStorage({ initial: { "doc:meta": '{"dirty":true}' } }) });
    expect(await missing.controller.checkRecovery()).toBeNull();
    const broken = setup({ storage: createMemoryStorage({ initial: { doc: "{oops", "doc:meta": '{"dirty":true}' } }) });
    const r = await broken.controller.checkRecovery();
    expect(r?.snapshot).toBeUndefined();
    expect(r?.text).toBe("{oops");
    expect(r?.error).toBeInstanceOf(Error);
  });

  it("a failed meta write fails the snapshot and is retried", async () => {
    let failMeta = true;
    const storage = createMemoryStorage({ failure: (op, key) => failMeta && op === "set" && key === "doc:meta" });
    const t = setup({ ready: true, storage });
    t.edit("a");
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.controller.getStatus().status).toBe("error");
    failMeta = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(JSON.parse(storage.entries.get("doc:meta")!).dirty).toBe(true);
  });

  it("undoing back to the saved revision before a write writes nothing", async () => {
    let revision = 0;
    let saved = 0;
    const storage = createMemoryStorage();
    const controller = createAutosaveController({
      storage,
      key: "doc",
      getSnapshot: () => ({}),
      revision: () => revision,
      savedRevision: () => saved,
      ready: true,
    });
    revision = 1;
    controller.notify();
    expect(controller.getStatus().status).toBe("dirty");
    saved = 1; // e.g. undo back to the saved state
    controller.notify();
    await vi.advanceTimersByTimeAsync(10000);
    expect(storage.entries.size).toBe(0);
    expect(controller.getStatus().status).toBe("idle");
  });

  it("destroy stops timers", async () => {
    const t = setup({ ready: true });
    t.edit("a");
    t.controller.destroy();
    await vi.advanceTimersByTimeAsync(10000);
    expect(t.snapshot()).toBeUndefined();
  });

  it("works with createRevisionTracker, a HistoryManager and bindDirtyToHistory", async () => {
    const history = new HistoryManager();
    let value = 0;
    const binding = bindDirtyToHistory({ history, getValue: () => value });
    const revisions = createRevisionTracker({ history, dirty: binding });
    const storage = createMemoryStorage();
    const controller = createAutosaveController({
      storage,
      key: "n",
      getSnapshot: () => value,
      revision: revisions.revision,
      savedRevision: revisions.savedRevision,
      ready: true,
    });
    revisions.subscribe(() => controller.notify());
    const set = (next: number) => {
      const prev = value;
      history.execute({ name: "set", execute: () => void (value = next), undo: () => void (value = prev) });
    };

    set(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(storage.entries.get("n")).toBe("1");

    binding.markClean();
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(storage.entries.get("n:meta")!)).toEqual({ dirty: false });

    set(2);
    history.undo(); // back to the saved value: clean, nothing to write
    await vi.advanceTimersByTimeAsync(10000);
    expect(storage.entries.has("n")).toBe(false);
    expect(revisions.revision()).toBe(revisions.savedRevision());

    history.redo();
    await vi.advanceTimersByTimeAsync(1000);
    expect(storage.entries.get("n")).toBe("2");
    revisions.destroy();
    binding.destroy();
  });
});

describe("formatRecoveryMessage", () => {
  it("names the time of the snapshot", () => {
    expect(formatRecoveryMessage({ time: 0 }, () => "noon")).toBe("Restore unsaved changes from noon?");
    expect(formatRecoveryMessage({})).toBe("Restore unsaved changes?");
  });
});

describe("createRevisionTracker", () => {
  it("bumps on history changes and syncs saved with a dirty flag", () => {
    const tracker = new DirtyTracker(0);
    const history = new HistoryManager();
    const r = createRevisionTracker({ history, dirty: tracker });
    let calls = 0;
    r.subscribe(() => calls++);
    expect(r.revision()).toBe(r.savedRevision());
    tracker.update(1); // external change, no history event
    expect(r.revision()).not.toBe(r.savedRevision());
    tracker.markClean();
    expect(r.revision()).toBe(r.savedRevision());
    expect(calls).toBe(2);
    r.destroy();
  });

  it("without a dirty flag, markSaved and bump drive it", () => {
    const r = createRevisionTracker();
    r.bump();
    expect(r.revision()).toBe(1);
    expect(r.savedRevision()).toBe(0);
    r.markSaved();
    expect(r.savedRevision()).toBe(1);
  });
});
