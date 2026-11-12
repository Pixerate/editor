import { describe, it, expect, afterEach, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { Editor } from "@tiptap/core";
import { createRichTextPreset, richTextStyleDomain } from "@pixerate/editor";
import { createStyleResolver, memoryStyleStore, type StyleDomain, type StyleCheckReport, type StyleResolver } from "@pixerate/editor/tools";
import { StyleFindings, useRichTextStyleFindings, useStyle, useStyleChoices, useStyleFindings, useStyleSwatches, type SvelteStyleSwatches, type SvelteStyle, type SvelteStyleChoices, type SvelteStyleFindings } from "../src/style";

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
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
      run: (value, profile) =>
        value.items.length > Number(profile.max ?? Infinity)
          ? [{ severity: "warning", message: `Use at most ${profile.max} items.`, target: { index: Number(profile.max) } }]
          : [],
    },
  ],
};

const skill = (max: number) => ({
  "SKILL.md": "---\nname: house\ndescription: House rules.\n---\nKeep lists short.",
  "list.json": JSON.stringify({ max, checks: ["max-items"] }),
});

function setup(max = 2) {
  const store = memoryStyleStore({});
  store.set("house", skill(max));
  const styles = createStyleResolver({ layers: [{ id: "org", store }], domains: [listDomain] });
  return { store, styles };
}

const settle = async () => {
  flushSync();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};

function render(component: any, props: Record<string, any>) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = mount(component, { target, props });
  flushSync();
  cleanups.push(() => {
    unmount(instance);
    target.remove();
  });
  return target;
}

describe("useStyle (Svelte)", () => {
  it("resolves the domain and re-resolves when a store changes", async () => {
    const { store, styles } = setup(2);
    let link!: SvelteStyle;
    cleanups.push($effect.root(() => {
      link = useStyle(styles, "list");
    }));
    await settle();
    expect(link.error).toBeNull();
    expect(link.style?.profile.max).toBe(2);
    expect(link.style?.skills.map((s) => s.name)).toEqual(["house"]);

    store.set("house", skill(5));
    await settle();
    expect(link.style?.profile.max).toBe(5);
  });

  it("reports an unknown domain as an error and is null without a resolver", async () => {
    const { styles } = setup();
    let resolver = $state<StyleResolver | null>(styles);
    let link!: SvelteStyle;
    cleanups.push($effect.root(() => {
      link = useStyle(() => resolver, "nope");
    }));
    await settle();
    expect(link.style).toBeNull();
    expect(link.error).toMatch(/no house-style domain "nope"/);
    resolver = null;
    await settle();
    expect(link.error).toBeNull();
  });
});

describe("useStyleFindings (Svelte)", () => {
  it("re-checks when state changes by reference and when the resolver notifies", async () => {
    const { store, styles } = setup(2);
    const check = vi.spyOn(styles, "check");
    let current = $state.raw<ListState>({ items: ["a"] });
    let link!: SvelteStyleFindings;
    cleanups.push($effect.root(() => {
      link = useStyleFindings(styles, "list", () => current);
    }));
    await settle();
    expect(link.report).toEqual({ findings: [], ran: ["max-items"], skipped: [] });
    expect(link.style?.profile.max).toBe(2);
    const calls = check.mock.calls.length;

    current = { items: ["a", "b", "c"] };
    await settle();
    expect(check.mock.calls.length).toBe(calls + 1);
    expect(link.report?.findings).toEqual([
      { check: "max-items", severity: "warning", message: "Use at most 2 items.", target: { index: 2 }, layer: "org" },
    ]);

    store.set("house", skill(5));
    await settle();
    expect(link.report?.findings).toEqual([]);
    expect(link.style?.profile.max).toBe(5);
  });

  it("ignores a stale check that settles after a newer one", async () => {
    const resolvers: ((r: any) => void)[] = [];
    const styles = {
      check: () => new Promise((resolve) => resolvers.push(resolve)),
      subscribe: () => () => {},
    } as unknown as StyleResolver;
    let current = $state.raw<unknown>({ n: 1 });
    let link!: SvelteStyleFindings;
    cleanups.push($effect.root(() => {
      link = useStyleFindings(styles, "list", () => current);
    }));
    flushSync();
    current = { n: 2 };
    flushSync();
    const report = (check: string) => ({ findings: [], ran: [check], skipped: [], style: { domain: "list" } });
    resolvers[1](report("new"));
    await settle();
    resolvers[0](report("old"));
    await settle();
    expect(link.report?.ran).toEqual(["new"]);
  });
});

describe("<StyleFindings> (Svelte)", () => {
  const report: StyleCheckReport = {
    findings: [
      { check: "palette-only", severity: "error", message: "Series colour is off-palette.", target: { kind: "series", seriesId: "s1" }, layer: "org" },
      { check: "title-case", severity: "info", message: "Use sentence case." },
    ],
    ran: ["palette-only", "title-case"],
    skipped: [{ check: "min-contrast", reason: "The check could not run: no background." }],
  };

  it("lists findings with severity, message, check and layer, and the skipped checks", () => {
    const target = render(StyleFindings, { report });
    expect(target.querySelector("h3")?.textContent).toBe("House style");
    const items = [...target.querySelectorAll("[data-style-finding]")];
    expect(items.map((li) => li.getAttribute("data-style-finding"))).toEqual(["palette-only", "title-case"]);
    expect(items[0].querySelector("[data-style-severity]")?.textContent?.trim()).toBe("error");
    expect(items[0].textContent).toContain("Series colour is off-palette.");
    expect(items[0].textContent).toContain("org");
    expect(target.querySelector("[data-style-skipped-check='min-contrast']")?.textContent).toContain("no background");
    expect(target.querySelector("[data-style-clear]")).toBeNull();
  });

  it("calls onSelect with a finding that has a target", () => {
    const onSelect = vi.fn();
    const target = render(StyleFindings, { report, onSelect, title: "Chart style" });
    expect(target.querySelector("h3")?.textContent).toBe("Chart style");
    const buttons = target.querySelectorAll("[data-style-finding] button");
    expect(buttons).toHaveLength(1); // the finding without a target is not clickable
    (buttons[0] as HTMLButtonElement).click();
    flushSync();
    expect(onSelect).toHaveBeenCalledWith(report.findings[0]);
  });

  it("shows an all-clear line when checks ran without findings, and nothing for a null report", () => {
    const target = render(StyleFindings, { report: { findings: [], ran: ["a", "b"], skipped: [] }, class: "mine" });
    expect(target.querySelector("[data-style-clear]")?.textContent).toContain("2 checks passed");
    expect(target.querySelector("section")?.className).toContain("mine");
    const empty = render(StyleFindings, { report: null });
    expect(empty.querySelector("section")).toBeNull();
  });
});

describe("useStyleChoices (Svelte)", () => {
  const look = (max: number) => ({
    "SKILL.md": "---\nname: look\ndescription: A look.\ngroup: look\n---\nA look.",
    "list.json": JSON.stringify({ max }),
  });

  it("lists the groups and re-reads after a choice", async () => {
    const org = memoryStyleStore({});
    org.set("tight", look(1));
    org.set("roomy", look(9));
    const user = memoryStyleStore({});
    const styles = createStyleResolver({ layers: [{ id: "org", store: org }, { id: "user", store: user }], domains: [listDomain] });
    let link!: SvelteStyleChoices;
    cleanups.push($effect.root(() => {
      link = useStyleChoices(styles);
    }));
    await settle();
    expect(link.groups?.map((g) => [g.group, g.chosen, g.options.map((o) => o.name)])).toEqual([["look", "roomy", ["roomy", "tight"]]]);
    expect(await link.choose("tight")).toMatchObject({ chosen: "tight", layer: "user", switchedOff: ["roomy"] });
    await settle();
    expect(link.groups?.[0].chosen).toBe("tight");
    await expect(link.choose("nope")).rejects.toThrow(/no house-style skill "nope"/);
    expect(link.error).toMatch(/no house-style skill "nope"/);
  });
});

describe("useStyleSwatches (Svelte)", () => {
  it("offers the brand's colours and fonts, and follows the store", async () => {
    const store = memoryStyleStore({});
    store.set("acme", { "SKILL.md": "---\nname: acme\ndescription: Acme.\n---\nUse it.", "brand.json": JSON.stringify({ colors: { primary: "#0b5fff", text: "#111111" }, fonts: { body: "Inter" } }) });
    const styles = createStyleResolver({ layers: [{ id: "org", store }], domains: [listDomain] });
    let link!: SvelteStyleSwatches;
    cleanups.push($effect.root(() => {
      link = useStyleSwatches(styles, "list");
    }));
    await settle();
    expect(link.colors).toEqual(["#0b5fff", "#111111"]);
    expect(link.swatches[1]).toEqual({ color: "#111111", label: "text" });
    expect(link.fonts).toEqual(["Inter"]);
    store.set("acme", { "SKILL.md": "---\nname: acme\ndescription: Acme.\n---\nUse it.", "brand.json": JSON.stringify({ colors: { primary: "#e4002b" } }) });
    await settle();
    expect(link.colors).toEqual(["#e4002b"]);
  });
});

describe("useRichTextStyleFindings (Svelte)", () => {
  it("re-checks the document after each edit", async () => {
    const store = memoryStyleStore({
      "house/SKILL.md": "---\nname: house\ndescription: House.\n---\nWrite plainly.",
      "house/rich-text.json": JSON.stringify({ headingCase: "sentence", checks: ["heading-case"] }),
    });
    const styles = createStyleResolver({ layers: [{ id: "org", store }], domains: [richTextStyleDomain] });
    const editor = new Editor({ extensions: createRichTextPreset(), content: "<h1>Our Big Plan</h1>" });
    let link!: SvelteStyleFindings;
    cleanups.push($effect.root(() => {
      link = useRichTextStyleFindings(styles, editor);
    }));
    await settle();
    expect(link.report?.findings.map((f) => (f.target as any).replacement)).toEqual(["Our big plan"]);
    editor.commands.setContent("<h1>Our big plan</h1>", { emitUpdate: true });
    await settle();
    expect(link.report?.findings).toEqual([]);
    editor.destroy();
  });
});
