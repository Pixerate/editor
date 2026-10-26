// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createStyleResolver, memoryStyleStore, type StyleDomain, type StyleCheckReport, type StyleResolver } from "@pixerate/editor/tools";
import { StyleFindings, useStyle, useStyleFindings, type UseStyleFindingsResult, type UseStyleResult } from "../src/style";

let container: HTMLDivElement;
let root: any;

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

interface ListState {
  items: string[];
}

/** A tiny domain: `max-items` flags a list longer than the profile's `max`. */
const listDomain: StyleDomain<ListState> = {
  id: "list",
  title: "List",
  description: "A list of items.",
  profileSchema: { type: "object", properties: { max: { type: "number" } } },
  checks: [
    {
      id: "max-items",
      description: "At most `max` items.",
      run: (state, profile) =>
        state.items.length > Number(profile.max ?? Infinity)
          ? [{ severity: "warning", message: `Use at most ${profile.max} items.`, target: { index: Number(profile.max) } }]
          : [],
    },
  ],
};

const skill = (max: number, checks: unknown[] = ["max-items"]) => ({
  "SKILL.md": "---\nname: house\ndescription: House rules.\n---\nKeep lists short.",
  "list.json": JSON.stringify({ max, checks }),
});

function setup(max = 2, checks?: unknown[]) {
  const store = memoryStyleStore({});
  store.set("house", skill(max, checks));
  const styles = createStyleResolver({ layers: [{ id: "org", store }], domains: [listDomain] });
  return { store, styles };
}

const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

describe("useStyle", () => {
  it("resolves the domain and re-resolves when a store changes", async () => {
    const { store, styles } = setup(2);
    let result!: UseStyleResult;
    function Probe() {
      result = useStyle(styles, "list");
      return null;
    }
    await act(async () => root.render(<Probe />));
    await flush();
    expect(result.error).toBeNull();
    expect(result.style?.profile.max).toBe(2);
    expect(result.style?.skills.map((s) => s.name)).toEqual(["house"]);

    await act(async () => store.set("house", skill(5)));
    await flush();
    expect(result.style?.profile.max).toBe(5);
  });

  it("reports an unknown domain as an error and is null without a resolver", async () => {
    const { styles } = setup();
    let result!: UseStyleResult;
    function Probe({ s }: { s: StyleResolver | null }) {
      result = useStyle(s, "nope");
      return null;
    }
    await act(async () => root.render(<Probe s={styles} />));
    await flush();
    expect(result.style).toBeNull();
    expect(result.error).toMatch(/no house-style domain "nope"/);
    await act(async () => root.render(<Probe s={null} />));
    await flush();
    expect(result).toEqual({ style: null, error: null });
  });
});

describe("useStyleFindings", () => {
  it("re-checks when state changes by reference and when the resolver notifies", async () => {
    const { store, styles } = setup(2);
    const check = vi.spyOn(styles, "check");
    let result!: UseStyleFindingsResult;
    function Probe({ state }: { state: ListState }) {
      result = useStyleFindings(styles, "list", state);
      return null;
    }
    const short = { items: ["a"] };
    await act(async () => root.render(<Probe state={short} />));
    await flush();
    expect(result.report).toEqual({ findings: [], ran: ["max-items"], skipped: [] });
    expect(result.style?.profile.max).toBe(2);

    // Same reference: no new check.
    const calls = check.mock.calls.length;
    await act(async () => root.render(<Probe state={short} />));
    await flush();
    expect(check.mock.calls.length).toBe(calls);

    await act(async () => root.render(<Probe state={{ items: ["a", "b", "c"] }} />));
    await flush();
    expect(result.report?.findings).toEqual([
      { check: "max-items", severity: "warning", message: "Use at most 2 items.", target: { index: 2 }, layer: "org" },
    ]);

    await act(async () => store.set("house", skill(5)));
    await flush();
    expect(result.report?.findings).toEqual([]);
    expect(result.style?.profile.max).toBe(5);
  });

  it("ignores a stale check that settles after a newer one", async () => {
    const resolvers: ((r: any) => void)[] = [];
    const styles = {
      check: () => new Promise((resolve) => resolvers.push(resolve)),
      subscribe: () => () => {},
    } as unknown as StyleResolver;
    let result!: UseStyleFindingsResult;
    function Probe({ state }: { state: unknown }) {
      result = useStyleFindings(styles, "list", state);
      return null;
    }
    await act(async () => root.render(<Probe state={{ n: 1 }} />));
    await act(async () => root.render(<Probe state={{ n: 2 }} />));
    const report = (check: string) => ({ findings: [], ran: [check], skipped: [], style: { domain: "list" } });
    await act(async () => resolvers[1](report("new")));
    await act(async () => resolvers[0](report("old")));
    expect(result.report?.ran).toEqual(["new"]);
  });
});

describe("<StyleFindings>", () => {
  const report: StyleCheckReport = {
    findings: [
      { check: "palette-only", severity: "error", message: "Series colour is off-palette.", target: { kind: "series", seriesId: "s1" }, layer: "org" },
      { check: "title-case", severity: "info", message: "Use sentence case." },
    ],
    ran: ["palette-only", "title-case"],
    skipped: [{ check: "min-contrast", reason: "The check could not run: no background." }],
  };

  it("lists findings with severity, message, check and layer, and the skipped checks", async () => {
    await act(async () => root.render(<StyleFindings report={report} />));
    expect(container.querySelector("h3")?.textContent).toBe("House style");
    const items = [...container.querySelectorAll("[data-style-finding]")];
    expect(items.map((li) => li.getAttribute("data-style-finding"))).toEqual(["palette-only", "title-case"]);
    expect(items[0].querySelector("[data-style-severity]")?.textContent).toBe("error");
    expect(items[0].textContent).toContain("Series colour is off-palette.");
    expect(items[0].textContent).toContain("org");
    expect(container.querySelector("[data-style-skipped-check='min-contrast']")?.textContent).toContain("no background");
    expect(container.querySelector("[data-style-clear]")).toBeNull();
  });

  it("calls onSelect with a finding that has a target", async () => {
    const onSelect = vi.fn();
    await act(async () => root.render(<StyleFindings report={report} onSelect={onSelect} title="Chart style" />));
    expect(container.querySelector("h3")?.textContent).toBe("Chart style");
    const buttons = container.querySelectorAll("[data-style-finding] button");
    expect(buttons).toHaveLength(1); // the finding without a target is not clickable
    await act(async () => (buttons[0] as HTMLButtonElement).click());
    expect(onSelect).toHaveBeenCalledWith(report.findings[0]);
  });

  it("shows an all-clear line when checks ran without findings, and nothing for a null report", async () => {
    await act(async () => root.render(<StyleFindings report={{ findings: [], ran: ["a", "b"], skipped: [] }} className="mine" />));
    expect(container.querySelector("[data-style-clear]")?.textContent).toContain("2 checks passed");
    expect(container.querySelector("section")?.className).toContain("mine");
    await act(async () => root.render(<StyleFindings report={null} />));
    expect(container.innerHTML).toBe("");
  });
});
