import { describe, it, expect, vi, afterEach } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { GenerationRequest, ModelCapabilities, PlanStrategy } from "@pixerate/editor/generation";
import { GenerationSettings, JobProgress, createGenerationPlan, createJobProgress } from "../src";

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

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach((fn) => fn());
  cleanup = [];
  vi.useRealTimers();
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

function setValue(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  flushSync();
}

describe("createGenerationPlan", () => {
  it("follows reactive request, capabilities and options", () => {
    let request = $state<GenerationRequest>({ aspectRatio: "21:9", count: 3 });
    let strategy = $state<PlanStrategy>("downgrade");
    const cleanupRoot = $effect.root(() => {
      const plan = createGenerationPlan(() => request, () => caps, () => ({ strategy }));
      expect(plan.request).toMatchObject({ aspectRatio: "16:9", count: 3 });
      expect(plan.adjustments.map((a) => a.field)).toEqual(["aspectRatio"]);
      expect(plan.ok).toBe(true);
      request = { aspectRatio: "1:1", count: 9 };
      expect(plan.request.count).toBe(4);
      strategy = "error";
      expect(plan.ok).toBe(false);
      expect(plan.errors[0].field).toBe("count");
    });
    cleanupRoot();
  });
});

describe("Svelte GenerationSettings", () => {
  function setup(props: Record<string, unknown> = {}, initial: GenerationRequest = {}) {
    const state = { value: initial };
    const box = $state(state);
    const onchange = (next: GenerationRequest) => {
      box.value = next;
    };
    const target = mountComponent(GenerationSettings, {
      capabilities: caps,
      get value() {
        return box.value;
      },
      onchange,
      ...props,
    });
    return { target, current: () => $state.snapshot(box.value) as GenerationRequest };
  }

  it("renders controls from capabilities and edits the request", () => {
    const { target, current } = setup();
    const field = (key: string) => target.querySelector(`[data-field="${key}"]`) as HTMLInputElement;
    const keys = Array.from(target.querySelectorAll("[data-field]")).map((el) => el.getAttribute("data-field"));
    expect(keys).toEqual(["negativePrompt", "aspectRatio", "count", "seed", "params.guidance", "params.sampler", "params.tile"]);
    expect(field("aspectRatio").tagName).toBe("SELECT");
    expect(field("count").type).toBe("range");
    expect(field("params.guidance").value).toBe("7");

    setValue(field("aspectRatio") as any, "16:9");
    setValue(field("count"), "3");
    setValue(field("params.sampler") as any, "ddim");
    setValue(field("negativePrompt") as any, "blur");
    field("params.tile").click();
    flushSync();
    expect(current()).toEqual({
      aspectRatio: "16:9",
      count: 3,
      negativePrompt: "blur",
      params: { sampler: "ddim", tile: true },
    });
    setValue(field("seed"), "12");
    expect(current().seed).toBe(12);
    setValue(field("seed"), "");
    expect(current().seed).toBeUndefined();
  });

  it("renders reference slots by role with add/remove and shows plan adjustments", () => {
    const onaddreference = vi.fn();
    const { target, current } = setup(
      { onaddreference },
      { seed: 1.5, references: [{ id: "s1", role: "style_ref" }, { id: "x", role: "mask" }] },
    );
    const style = target.querySelector('[data-reference-role="style_ref"]')!;
    const character = target.querySelector('[data-reference-role="character_ref"]')!;
    expect(target.querySelector('[data-reference-role="mask"]')).toBeNull();
    expect(style.querySelector("[data-reference-count]")!.textContent).toBe("(1/1)");
    expect(style.textContent).not.toMatch(/Add/);
    (character.querySelector("button") as HTMLButtonElement).click();
    expect(onaddreference).toHaveBeenCalledWith("character_ref");

    const adjustments = target.querySelector("[data-generation-adjustments]")!;
    expect(adjustments.getAttribute("role")).toBe("status");
    expect(Array.from(adjustments.querySelectorAll("li")).map((li) => li.getAttribute("data-adjustment-field"))).toEqual([
      "seed",
      "references.mask",
    ]);

    (style.querySelector('button[aria-label^="Remove"]') as HTMLButtonElement).click();
    flushSync();
    expect(current().references).toEqual([{ id: "x", role: "mask" }]);
  });

  it("shows plan errors", () => {
    const target = mountComponent(GenerationSettings, {
      capabilities: { ...caps, references: { roles: { start_frame: { max: 1, min: 1 } } } },
      value: {},
      onchange: () => {},
    });
    const errors = target.querySelector("[data-generation-errors]")!;
    expect(errors.getAttribute("role")).toBe("alert");
    expect(errors.textContent).toMatch(/start_frame/);
  });
});

describe("Svelte JobProgress", () => {
  it("renders a progressbar with a time label and ticks until done", () => {
    vi.useFakeTimers();
    vi.setSystemTime(60_000);
    const props = $state({ startedAt: 0, expectedMs: 300_000, title: "Image One", done: false });
    const target = mountComponent(JobProgress, props);
    const bar = target.querySelector('[role="progressbar"]')!;
    const label = () => target.querySelector("[data-job-progress-label]")!.textContent;
    expect(bar.getAttribute("aria-valuenow")).toBe("20");
    expect(label()).toBe("~4m left");
    vi.advanceTimersByTime(240_000);
    flushSync();
    expect(bar.getAttribute("aria-valuenow")).toBe("95");
    expect(label()).toBe("Almost done…");
    props.done = true;
    flushSync();
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(label()).toBe("Done");
  });

  it("createJobProgress ticks and stops on destroy", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const progress = createJobProgress(() => ({ startedAt: 0, expectedMs: 100_000 }));
    expect(progress.label).toBe("Starting…");
    vi.advanceTimersByTime(50_000);
    expect(progress.percent).toBe(50);
    expect(progress.label).toBe("~50s left");
    progress.destroy();
    vi.advanceTimersByTime(20_000);
    expect(progress.percent).toBe(50);
  });
});
