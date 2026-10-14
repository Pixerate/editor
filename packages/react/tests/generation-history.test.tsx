// @vitest-environment jsdom
// The DOM must exist before react-dom loads (see GOTCHAS: text inputs and onChange).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createGenerationRecord,
  createGenerationRecordStore,
  type AssetInfo,
  type GenerationRecordStore,
  type ModelCapabilities,
  type RecreateResult,
} from "@pixerate/editor/generation";
import { createMemoryStorage } from "@pixerate/editor/persistence";
import type { Template } from "@pixerate/editor";
import { AssetMentionChips, GenerationHistory, useGenerationRecords } from "../src";

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

async function render(element: React.ReactElement) {
  await act(async () => {
    root.render(element);
  });
}
const click = (el: Element | null) => act(async () => (el as HTMLElement).click());

describe("AssetMentionChips", () => {
  it("shows asset mentions with role badges and picks roles in a popover", async () => {
    const changes: string[] = [];
    function Host() {
      const [text, setText] = useState("A @fox and @Clip:style_ref with @jack");
      return (
        <AssetMentionChips
          content={text}
          assets={assets}
          capabilities={caps}
          onChange={(next) => {
            changes.push(next);
            setText(next);
          }}
        />
      );
    }
    await render(<Host />);
    const chips = container.querySelectorAll("[data-asset-chip]");
    expect([...chips].map((c) => c.getAttribute("data-asset-chip"))).toEqual(["fox", "clip"]);
    const badges = () => [...container.querySelectorAll("[data-role-badge]")].map((b) => b.textContent);
    expect(badges()).toEqual(["No role", "Style reference"]);
    // The video clip is not accepted as a style reference.
    expect(chips[1].querySelector("button")!.getAttribute("data-issue")).toBe("media-mismatch");

    await click(chips[0].querySelector("button"));
    expect(chips[0].querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
    const options = [...container.querySelectorAll("[data-role-option]")].map((o) => o.textContent);
    expect(options).toEqual(["Style referenceimage", "Character referenceimage", "Subject", "No role"]);
    await click(container.querySelector('[data-role-option="subject"]'));
    expect(changes.at(-1)).toBe("A @fox:subject and @Clip:style_ref with @jack");
    expect(container.querySelector("[data-role-picker]")).toBeNull();
    expect(badges()).toEqual(["Subject", "Style reference"]);

    await click(container.querySelectorAll("[data-asset-chip] > button")[1]);
    expect(container.querySelector("[data-chip-issues]")!.textContent).toMatch(/video\/mp4/);
    await click(container.querySelector('[data-role-option=""]'));
    expect(changes.at(-1)).toBe("A @fox:subject and @Clip with @jack");
  });

  it("closes on outside clicks and renders nothing without asset mentions", async () => {
    await render(<AssetMentionChips content="@fox" assets={assets} onChange={() => {}} />);
    await click(container.querySelector("[data-asset-chip] button"));
    expect(container.querySelector("[data-role-picker]")).not.toBeNull();
    // Without a model, the built-in roles are offered.
    expect(container.querySelector('[data-role-option="start_frame"]')).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
    });
    expect(container.querySelector("[data-role-picker]")).toBeNull();
    await render(<AssetMentionChips content="@jack only" assets={assets} onChange={() => {}} />);
    expect(container.querySelector("[data-asset-mention-chips]")).toBeNull();
  });
});

function makeRecord(id: string, createdAt: number) {
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

describe("GenerationHistory", () => {
  it("lists records with role badges, drift and Recreate / Variation", async () => {
    const recreated: RecreateResult[] = [];
    const varied: RecreateResult[] = [];
    const records = [makeRecord("r1", 0)];
    const props = {
      records,
      capabilities: [caps],
      assets,
      onRecreate: (r: RecreateResult) => recreated.push(r),
      onVariation: (r: RecreateResult) => varied.push(r),
    };
    await render(<GenerationHistory {...props} templates={templates} />);
    const item = container.querySelector('[data-record="r1"]')!;
    expect(item.getAttribute("data-drift")).toBe("0");
    expect(item.querySelector("[data-record-prompt]")!.textContent).toBe("fox in oil painting");
    expect(item.querySelector('[data-asset-role="style_ref"]')!.textContent).toBe("fox · Style reference");
    await click(item.querySelector('[data-action="recreate"]'));
    expect(recreated[0].request).toMatchObject({ model: "img", resolution: "2k", seed: 7, prompt: "fox in oil painting" });
    await click(item.querySelector('[data-action="variation"]'));
    expect(varied[0].kind).toBe("variation");
    expect(varied[0].request.seed).not.toBe(7);

    // Edit the template: exact reports it, latest applies it.
    const edited = [{ name: "style", body: "watercolor" }];
    await render(<GenerationHistory {...props} templates={edited} />);
    const types = () => [...container.querySelectorAll("[data-drift-type]")].map((d) => d.getAttribute("data-drift-type"));
    expect(types()).toEqual(["template-changed"]);
    expect(container.querySelector("[data-drift-report]")!.textContent).toMatch(/Template changed.*recorded version/);
    await click(container.querySelector('[data-mode="latest"]'));
    expect(types()).toEqual(["template-changed", "prompt-changed"]);
    await click(container.querySelector('[data-action="recreate"]'));
    expect(recreated[1].request.prompt).toBe("fox in watercolor");

    // A missing asset blocks Recreate.
    await render(<GenerationHistory {...props} templates={templates} assets={[]} />);
    expect(types()).toContain("asset-missing");
    expect((container.querySelector('[data-action="recreate"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("loads from a store with useGenerationRecords and follows changes", async () => {
    const store: GenerationRecordStore = createGenerationRecordStore({ storage: createMemoryStorage() });
    await store.put(makeRecord("a", 0));
    function Host() {
      const { records, loading } = useGenerationRecords(store);
      return (
        <div data-loading={String(loading)}>
          <GenerationHistory records={records} onRemove={(r) => void store.remove(r.id)} emptyText="Empty" />
        </div>
      );
    }
    await render(<Host />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect([...container.querySelectorAll("[data-record]")].map((e) => e.getAttribute("data-record"))).toEqual(["a"]);
    await act(async () => {
      await store.put(makeRecord("b", 1000));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect([...container.querySelectorAll("[data-record]")].map((e) => e.getAttribute("data-record"))).toEqual(["b", "a"]);
    await click(container.querySelector('[data-record="b"] [data-action="remove"]'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect([...container.querySelectorAll("[data-record]")].map((e) => e.getAttribute("data-record"))).toEqual(["a"]);
    expect(container.querySelector('[data-action="recreate"]')).toBeNull();
    expect(container.firstElementChild!.getAttribute("data-loading")).toBe("false");
    vi.restoreAllMocks();
  });
});
