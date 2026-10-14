// @vitest-environment jsdom
// The DOM must exist before react-dom loads (see GOTCHAS: text inputs and onChange).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { GenerationPlan, GenerationRequest, ModelCapabilities } from "@pixerate/editor/generation";
import { GenerationSettings, JobProgress, useGenerationPlan } from "../src";

const caps: ModelCapabilities = {
  id: "img",
  media: "image",
  negativePrompt: true,
  aspectRatios: { options: ["1:1", "16:9"], default: "1:1" },
  count: { max: 4 },
  seed: true,
  references: { roles: { style_ref: { max: 1 }, character_ref: { max: 2 } } },
  params: {
    guidance: { type: "number", min: 1, max: 10, step: 0.5, default: 7 },
    sampler: { type: "enum", options: ["euler", "ddim"] },
    tile: { type: "boolean" },
  },
};

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
  vi.useRealTimers();
});

async function render(element: React.ReactElement) {
  await act(async () => {
    root.render(element);
  });
}

async function setValue(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new window.Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

const field = (key: string) => container.querySelector(`[data-field="${key}"]`) as HTMLInputElement;

describe("useGenerationPlan", () => {
  it("plans the request and memoizes by value", async () => {
    const plans: GenerationPlan[] = [];
    function Probe({ request }: { request: GenerationRequest }) {
      plans.push(useGenerationPlan(request, caps, { strategy: "downgrade" }));
      return null;
    }
    await render(<Probe request={{ aspectRatio: "21:9", count: 9 }} />);
    await render(<Probe request={{ aspectRatio: "21:9", count: 9 }} />);
    expect(plans[0].request).toMatchObject({ aspectRatio: "16:9", count: 4 });
    expect(plans[0].adjustments.map((a) => a.field)).toEqual(["aspectRatio", "count"]);
    expect(plans[1]).toBe(plans[0]);
  });
});

describe("GenerationSettings", () => {
  function Harness({ onAddReference, initial = {} }: { onAddReference?: (role: string) => void; initial?: GenerationRequest }) {
    const [value, setValue] = useState<GenerationRequest>(initial);
    (globalThis as any).__value = value;
    return <GenerationSettings capabilities={caps} value={value} onChange={setValue} onAddReference={onAddReference} />;
  }
  const current = () => (globalThis as any).__value as GenerationRequest;

  it("renders controls from capabilities and edits the request", async () => {
    await render(<Harness />);
    const keys = Array.from(container.querySelectorAll("[data-field]")).map((el) => el.getAttribute("data-field"));
    expect(keys).toEqual(["negativePrompt", "aspectRatio", "count", "seed", "params.guidance", "params.sampler", "params.tile"]);
    expect(field("aspectRatio").tagName).toBe("SELECT");
    expect(field("count").type).toBe("range");
    expect(field("seed").type).toBe("number");
    expect(field("params.guidance").value).toBe("7");

    await setValue(field("aspectRatio") as any, "16:9");
    await setValue(field("count"), "3");
    await setValue(field("params.sampler") as any, "ddim");
    await setValue(field("negativePrompt") as any, "blur");
    await act(async () => field("params.tile").click());
    expect(current()).toEqual({
      aspectRatio: "16:9",
      count: 3,
      negativePrompt: "blur",
      params: { sampler: "ddim", tile: true },
    });
    await setValue(field("seed"), "12");
    expect(current().seed).toBe(12);
    await setValue(field("seed"), "");
    expect(current().seed).toBeUndefined();
  });

  it("renders reference slots by role with add/remove and shows plan adjustments", async () => {
    const onAddReference = vi.fn();
    await render(
      <Harness
        onAddReference={onAddReference}
        initial={{
          seed: 1.5,
          references: [
            { id: "s1", role: "style_ref" },
            { id: "x", role: "mask" },
          ],
        }}
      />,
    );
    const style = container.querySelector('[data-reference-role="style_ref"]')!;
    const character = container.querySelector('[data-reference-role="character_ref"]')!;
    expect(container.querySelector('[data-reference-role="mask"]')).toBeNull();
    expect(style.querySelector("[data-reference-count]")!.textContent).toBe("(1/1)");
    expect(style.textContent).not.toMatch(/Add/);
    await act(async () => (character.querySelector("button") as HTMLButtonElement).click());
    expect(onAddReference).toHaveBeenCalledWith("character_ref");

    const adjustments = container.querySelector("[data-generation-adjustments]")!;
    expect(adjustments.getAttribute("role")).toBe("status");
    expect(Array.from(adjustments.querySelectorAll("li")).map((li) => li.getAttribute("data-adjustment-field"))).toEqual([
      "seed",
      "references.mask",
    ]);

    await act(async () => (style.querySelector('button[aria-label^="Remove"]') as HTMLButtonElement).click());
    expect(current().references).toEqual([{ id: "x", role: "mask" }]);
  });

  it("shows plan errors", async () => {
    await render(
      <GenerationSettings
        capabilities={{ ...caps, references: { roles: { start_frame: { max: 1, min: 1 } } } }}
        value={{}}
        onChange={() => {}}
      />,
    );
    const errors = container.querySelector("[data-generation-errors]")!;
    expect(errors.getAttribute("role")).toBe("alert");
    expect(errors.textContent).toMatch(/start_frame/);
  });
});

describe("JobProgress", () => {
  it("renders a progressbar with a time label and ticks until done", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(60_000);
    await render(<JobProgress startedAt={0} expectedMs={300_000} title="Image One" />);
    const bar = container.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-valuenow")).toBe("20");
    expect(container.querySelector("[data-job-progress-label]")!.textContent).toBe("~4m left");
    await act(async () => {
      vi.advanceTimersByTime(240_000);
    });
    expect(bar.getAttribute("aria-valuenow")).toBe("95");
    expect(container.querySelector("[data-job-progress-label]")!.textContent).toBe("Almost done…");
    await render(<JobProgress startedAt={0} expectedMs={300_000} title="Image One" done />);
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(container.querySelector("[data-job-progress-label]")!.textContent).toBe("Done");
  });

  it("uses a fixed `now` without ticking", async () => {
    await render(<JobProgress startedAt={0} now={0} />);
    expect(container.querySelector("[data-job-progress-label]")!.textContent).toBe("Starting…");
  });
});
