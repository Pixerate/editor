import { describe, it, expect } from "vitest";
import {
  HistoryManager,
  agentOrigin,
  originAgentId,
  type Command,
  type HistoryCommitEvent,
} from "../src/history";

const counter = () => {
  const state = { value: 0 };
  const cmd = (name: string, by = 1, extra: Partial<Command> = {}): Command => ({
    name,
    execute: () => {
      state.value += by;
    },
    undo: () => {
      state.value -= by;
    },
    ...extra,
  });
  return { state, cmd };
};

describe("HistoryManager origin", () => {
  it("records steps as the user's by default", () => {
    const history = new HistoryManager();
    const { cmd } = counter();
    history.execute(cmd("A"));
    expect(history.getEntries()[0]!.origin).toBe("user");
    expect(history.getOrigin()).toBe("user");
  });

  it("takes the command's own origin over the one in effect", () => {
    const history = new HistoryManager();
    const { cmd } = counter();
    history.withOrigin(agentOrigin("pixie"), () => {
      history.execute(cmd("A"));
      history.execute(cmd("B", 1, { origin: "user" }));
    });
    expect(history.getEntries().map((e) => e.origin)).toEqual(["agent:pixie", "user"]);
  });

  it("restores the outer origin after nested and failing calls", () => {
    const history = new HistoryManager();
    history.withOrigin("agent:a", () => {
      history.withOrigin("agent:b", () => {
        expect(history.getOrigin()).toBe("agent:b");
      });
      expect(history.getOrigin()).toBe("agent:a");
      expect(() =>
        history.withOrigin("agent:c", () => {
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(history.getOrigin()).toBe("agent:a");
    });
    expect(history.getOrigin()).toBe("user");
  });

  it("holds the origin until an async call settles", async () => {
    const history = new HistoryManager();
    const { cmd } = counter();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const done = history.withOrigin("agent:pixie", async () => {
      await gate;
      history.execute(cmd("Late"));
      return 7;
    });
    expect(history.getOrigin()).toBe("agent:pixie");
    release();
    await expect(done).resolves.toBe(7);
    expect(history.getEntries()[0]!.origin).toBe("agent:pixie");
    expect(history.getOrigin()).toBe("user");
  });

  it("gives a batch the origin of its commands", () => {
    const history = new HistoryManager();
    const { cmd } = counter();
    history.withOrigin("agent:pixie", () =>
      history.batch("Both", () => {
        history.execute(cmd("A"));
        history.execute(cmd("B"));
      }),
    );
    expect(history.getEntries()).toHaveLength(1);
    expect(history.getEntries()[0]!.origin).toBe("agent:pixie");
  });

  it("never folds another origin's change into a gesture or a coalesced step", () => {
    const history = new HistoryManager();
    const { state, cmd } = counter();
    history.executeMerged(cmd("Drag", 1, { tag: "drag" }), { key: "g" });
    history.executeMerged(cmd("Drag", 1, { tag: "drag", origin: "agent:pixie" }), { key: "g" });
    expect(history.getEntries().map((e) => e.origin)).toEqual(["user", "agent:pixie"]);
    history.executeMerged(cmd("Nudge", 1, { tag: "nudge" }));
    history.executeMerged(cmd("Nudge", 1, { tag: "nudge", origin: "agent:pixie" }));
    expect(history.getEntries()).toHaveLength(4);
    history.undo();
    expect(state.value).toBe(3);
  });

  it("parses agent origins", () => {
    expect(originAgentId("agent:pixie")).toBe("pixie");
    expect(originAgentId("user")).toBeNull();
    expect(originAgentId("agent:")).toBeNull();
    expect(originAgentId(undefined)).toBeNull();
  });
});

describe("HistoryManager.onCommit", () => {
  const record = (history: HistoryManager) => {
    const events: HistoryCommitEvent[] = [];
    history.onCommit((e) => events.push(e));
    return events;
  };

  it("reports executes and merges with their step and origin", () => {
    const history = new HistoryManager();
    const events = record(history);
    const { cmd } = counter();
    history.execute(cmd("A", 1, { origin: "agent:pixie" }));
    history.executeMerged(cmd("Drag", 1, { tag: "d" }), { key: "k" });
    history.executeMerged(cmd("Drag", 1, { tag: "d" }), { key: "k" });
    expect(events.map((e) => [e.kind, e.entry?.label, e.origin])).toEqual([
      ["execute", "A", "agent:pixie"],
      ["execute", "Drag", "user"],
      ["merge", "Drag", "user"],
    ]);
    expect(events[2]!.revision).toBe(history.getRevision());
  });

  it("reports undo, redo, each step of goTo, revert and clear", () => {
    const history = new HistoryManager();
    const { cmd } = counter();
    history.execute(cmd("A", 1, { origin: "agent:pixie" }));
    history.execute(cmd("B"));
    const mark = history.mark();
    history.execute(cmd("C"));
    const events = record(history);
    history.undo();
    history.redo();
    history.goTo(0);
    history.revertTo(mark);
    history.clear();
    expect(events.map((e) => [e.kind, e.entry?.label])).toEqual([
      ["undo", "C"],
      ["redo", "C"],
      ["undo", "C"],
      ["undo", "B"],
      ["clear", undefined],
    ]);
    // The undone step keeps the origin of whoever made it.
    history.execute(cmd("D", 1, { origin: "agent:pixie" }));
    const later = record(history);
    history.undo();
    expect(later[0]!.entry!.origin).toBe("agent:pixie");
    expect(later[0]!.origin).toBe("user");
  });

  it("reports a revert and stops after unsubscribing", () => {
    const history = new HistoryManager();
    const { cmd } = counter();
    const mark = history.mark();
    history.execute(cmd("A"));
    const events: HistoryCommitEvent[] = [];
    const off = history.onCommit((e) => events.push(e));
    history.revertTo(mark);
    off();
    history.execute(cmd("B"));
    expect(events.map((e) => e.kind)).toEqual(["revert"]);
  });
});
