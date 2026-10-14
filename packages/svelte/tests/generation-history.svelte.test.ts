import { describe, it, expect, afterEach } from "vitest";
import { flushSync, mount, unmount, tick } from "svelte";
import {
  createGenerationRecord,
  createGenerationRecordStore,
  type AssetInfo,
  type GenerationRecord,
  type ModelCapabilities,
  type RecreateResult,
} from "@pixerate/editor/generation";
import { createMemoryStorage } from "@pixerate/editor/persistence";
import type { Template } from "@pixerate/editor";
import { AssetMentionChips, GenerationHistory, createGenerationRecords } from "../src";

const caps: ModelCapabilities = {
  id: "img",
  name: "Image",
  media: "image",
  seed: { min: 0, max: 1000 },
  resolutions: { options: ["1k", "2k"] },
  references: {
    roles: {
      style_ref: { max: 1, accepts: ["image"] },
      character_ref: { max: 1, accepts: ["image"] },
      subject: { max: 1, label: "Subject" },
    },
  },
};
const assets: AssetInfo[] = [
  { id: "fox", label: "Fox", mediaType: "image/png", contentHash: "h1" },
  { id: "clip", label: "Clip", mediaType: "video/mp4", contentHash: "h2" },
];
const templates: Template[] = [{ name: "style", body: "oil painting" }];

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach((fn) => fn());
  cleanup = [];
});

function mountComponent(component: any, props: Record<string, unknown>) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = mount(component, { target, props });
  flushSync();
  cleanup.push(() => {
    unmount(instance);
    target.remove();
  });
  return target;
}
const click = (el: Element | null) => {
  (el as HTMLElement).click();
  flushSync();
};

function makeRecord(id: string, createdAt: number): GenerationRecord {
  return createGenerationRecord({
    id,
    rawPrompt: "fox in {{style}}",
    templates,
    model: caps,
    request: { resolution: "2k", seed: 7 },
    mentions: [{ id: "fox", role: "style_ref", mediaType: "image/png", contentHash: "h1" }],
    createdAt,
  });
}

describe("Svelte AssetMentionChips", () => {
  it("shows asset mentions with role badges and picks roles in a popover", () => {
    const box = $state({ text: "A @fox and @Clip:style_ref with @jack" });
    const changes: string[] = [];
    const target = mountComponent(AssetMentionChips, {
      get content() {
        return box.text;
      },
      onchange: (next: string) => {
        changes.push(next);
        box.text = next;
      },
      assets,
      capabilities: caps,
    });
    const chips = target.querySelectorAll("[data-asset-chip]");
    expect([...chips].map((c) => c.getAttribute("data-asset-chip"))).toEqual(["fox", "clip"]);
    const badges = () => [...target.querySelectorAll("[data-role-badge]")].map((b) => b.textContent);
    expect(badges()).toEqual(["No role", "Style reference"]);
    expect(chips[1].querySelector("button")!.getAttribute("data-issue")).toBe("media-mismatch");

    click(chips[0].querySelector("button"));
    expect(chips[0].querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
    expect([...target.querySelectorAll("[data-role-option]")].map((o) => o.textContent)).toEqual([
      "Style referenceimage",
      "Character referenceimage",
      "Subject",
      "No role",
    ]);
    click(target.querySelector('[data-role-option="subject"]'));
    expect(changes.at(-1)).toBe("A @fox:subject and @Clip:style_ref with @jack");
    expect(target.querySelector("[data-role-picker]")).toBeNull();
    expect(badges()).toEqual(["Subject", "Style reference"]);

    click(target.querySelectorAll("[data-asset-chip] > button")[1]);
    expect(target.querySelector("[data-chip-issues]")!.textContent).toMatch(/video\/mp4/);
    click(target.querySelector('[data-role-option=""]'));
    expect(changes.at(-1)).toBe("A @fox:subject and @Clip with @jack");
  });

  it("closes on outside clicks and renders nothing without asset mentions", () => {
    const target = mountComponent(AssetMentionChips, { content: "@fox", assets, onchange: () => {} });
    click(target.querySelector("[data-asset-chip] button"));
    expect(target.querySelector('[data-role-option="start_frame"]')).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    flushSync();
    expect(target.querySelector("[data-role-picker]")).toBeNull();
    const empty = mountComponent(AssetMentionChips, { content: "@jack only", assets, onchange: () => {} });
    expect(empty.querySelector("[data-asset-mention-chips]")).toBeNull();
  });
});

describe("Svelte GenerationHistory", () => {
  it("lists records with role badges, drift and Recreate / Variation", () => {
    const recreated: RecreateResult[] = [];
    const varied: RecreateResult[] = [];
    const box = $state({ templates, assets });
    const target = mountComponent(GenerationHistory, {
      records: [makeRecord("r1", 0)],
      capabilities: [caps],
      get templates() {
        return box.templates;
      },
      get assets() {
        return box.assets;
      },
      onrecreate: (r: RecreateResult) => recreated.push(r),
      onvariation: (r: RecreateResult) => varied.push(r),
    });
    const item = target.querySelector('[data-record="r1"]')!;
    expect(item.getAttribute("data-drift")).toBe("0");
    expect(item.querySelector("[data-record-prompt]")!.textContent).toBe("fox in oil painting");
    expect(item.querySelector('[data-asset-role="style_ref"]')!.textContent).toBe("fox · Style reference");
    click(item.querySelector('[data-action="recreate"]'));
    expect(recreated[0].request).toMatchObject({ model: "img", resolution: "2k", seed: 7, prompt: "fox in oil painting" });
    click(item.querySelector('[data-action="variation"]'));
    expect(varied[0].kind).toBe("variation");
    expect(varied[0].request.seed).not.toBe(7);

    box.templates = [{ name: "style", body: "watercolor" }];
    flushSync();
    const types = () => [...target.querySelectorAll("[data-drift-type]")].map((d) => d.getAttribute("data-drift-type"));
    expect(types()).toEqual(["template-changed"]);
    expect(target.querySelector("[data-drift-report]")!.textContent).toMatch(/Template changed.*recorded version/);
    click(target.querySelector('[data-mode="latest"]'));
    expect(types()).toEqual(["template-changed", "prompt-changed"]);
    click(target.querySelector('[data-action="recreate"]'));
    expect(recreated[1].request.prompt).toBe("fox in watercolor");

    box.templates = templates;
    box.assets = [];
    flushSync();
    expect(types()).toContain("asset-missing");
    expect((target.querySelector('[data-action="recreate"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("follows a store with createGenerationRecords", async () => {
    const store = createGenerationRecordStore({ storage: createMemoryStorage() });
    await store.put(makeRecord("a", 0));
    const box = $state<{ model?: string }>({});
    // Created outside a component: it owns an effect root until `destroy()`.
    const records = createGenerationRecords(store, () => (box.model ? { model: box.model } : undefined));
    cleanup.push(() => records.destroy());
    const settle = async () => {
      for (let i = 0; i < 5; i++) await tick();
      await new Promise((r) => setTimeout(r, 0));
      flushSync();
    };
    await settle();
    expect(records.records.map((r) => r.id)).toEqual(["a"]);
    expect(records.loading).toBe(false);
    await store.put(makeRecord("b", 1000));
    await settle();
    expect(records.records.map((r) => r.id)).toEqual(["b", "a"]);
    box.model = "other";
    flushSync();
    await settle();
    expect(records.records).toEqual([]);
    box.model = undefined;
    flushSync();
    await settle();
    expect(records.records.map((r) => r.id)).toEqual(["b", "a"]);
    records.destroy();
    await store.put(makeRecord("c", 2000));
    await settle();
    expect(records.records.map((r) => r.id)).toEqual(["b", "a"]);
  });
});
