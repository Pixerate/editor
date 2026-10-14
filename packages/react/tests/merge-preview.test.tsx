// @vitest-environment jsdom
// The DOM must exist before react-dom loads (see variables.test.tsx).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  MergePreview,
  TemplateRenderer,
  useMergePreview,
  type MergePreviewState,
  type MergeRecordsResult,
} from "../src";

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

async function setValue(
  element: HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  event: "input" | "change",
) {
  const proto = Object.getPrototypeOf(element);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new window.Event(event, { bubbles: true }));
  });
}

async function click(selector: string) {
  await act(async () => {
    (container.querySelector(selector) as HTMLButtonElement).click();
  });
}

const csv = "First Name,City,Amount\nAda,London,250\nAlan,Wilmslow,40\n,Arlington,";
const template = "Dear {firstName|friend} of {place}{?amount>100}, VIP{/amount}.";
const text = (selector: string) => container.querySelector(selector)!.textContent;

describe("React MergePreview", () => {
  it("previews records, steps through them and maps fields", async () => {
    await render(<MergePreview content={template} defaultSource={csv} />);
    expect(text("[data-merge-summary]")).toBe("3 records · 3 fields");
    expect(text("[data-merge-position]")).toBe("Record 1 of 3");
    // `place` has no automatic match, so it stays a placeholder.
    expect(text("[data-merge-output]")).toBe("Dear Ada of {place}, VIP.");
    const townSelect = container.querySelector(
      '[data-merge-mapping="place"] select',
    ) as HTMLSelectElement;
    expect(townSelect.value).toBe("");
    expect(
      (container.querySelector('[data-merge-mapping="firstName"] select') as HTMLSelectElement)
        .value,
    ).toBe("First Name");

    await setValue(townSelect, "City", "change");
    expect(text("[data-merge-output]")).toBe("Dear Ada of London, VIP.");

    await click("[data-merge-next]");
    expect(text("[data-merge-position]")).toBe("Record 2 of 3");
    expect(text("[data-merge-output]")).toBe("Dear Alan of Wilmslow.");
    await click("[data-merge-next]");
    expect(text("[data-merge-output]")).toBe("Dear friend of Arlington.");
    expect((container.querySelector("[data-merge-next]") as HTMLButtonElement).disabled).toBe(true);
    await click("[data-merge-prev]");
    expect(text("[data-merge-position]")).toBe("Record 2 of 3");
  });

  it("merges all records with skipIf and exposes text output", async () => {
    const onMerge = vi.fn<(result: MergeRecordsResult) => void>();
    await render(
      <MergePreview
        content="{City}"
        defaultSource={csv}
        skipIf="Amount<100"
        separator={"\n"}
        onMerge={onMerge}
      />,
    );
    await click("[data-merge-all]");
    expect(onMerge).toHaveBeenCalledTimes(1);
    expect(onMerge.mock.calls[0][0].outputs.map((o) => o.text)).toEqual(["London"]);
    expect(text("[data-merge-result]")).toBe("1 merged, 2 skipped");
    expect((container.querySelector("[data-merge-text]") as HTMLTextAreaElement).value).toBe(
      "London",
    );
  });

  it("re-parses pasted data and resets to the first record", async () => {
    await render(<MergePreview content="{name}" defaultSource={"name\nA\nB"} />);
    await click("[data-merge-next]");
    expect(text("[data-merge-output]")).toBe("B");
    const source = container.querySelector("[data-merge-source]") as HTMLTextAreaElement;
    await setValue(source, '[{"name":"Json"}]', "input");
    expect(text("[data-merge-position]")).toBe("Record 1 of 1");
    expect(text("[data-merge-output]")).toBe("Json");
    await setValue(source, "", "input");
    expect(text("[data-merge-position]")).toBe("No records");
    expect((container.querySelector("[data-merge-all]") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("React useMergePreview", () => {
  it("exposes headless state", async () => {
    let state!: MergePreviewState;
    const Probe = () => {
      state = useMergePreview({ template: "{first} {n}", initialSource: "GivenName,n\nAda,1\nBo,2" });
      return null;
    };
    await render(<Probe />);
    expect(state.variables).toEqual(["first", "n"]);
    expect(state.mapping).toEqual({ first: "GivenName", n: "n" });
    expect(state.values).toMatchObject({ first: "Ada", n: "1" });
    await act(async () => state.setIndex(5));
    expect(state.index).toBe(1);
    await act(async () => state.setFieldMapping("first", null));
    expect(state.values.first).toBeUndefined();
    await act(async () => {
      state.merge();
    });
    expect(state.serialize("text")).toBe("{first} 1\n\n{first} 2");
    expect(JSON.parse(state.serialize("json"))[1]).toEqual({ record: 2, text: "{first} 2" });
    await act(async () => state.loadFile(new Blob(["n\n9"])));
    expect(state.count).toBe(1);
    expect(state.result).toBeNull();
  });
});

describe("React TemplateRenderer comparison tags", () => {
  it("shows comparison tags and evaluates them with values", async () => {
    await render(<TemplateRenderer content="{?n>3}many{/n}" />);
    const tags = Array.from(container.querySelectorAll("[data-conditional]"));
    expect(tags.map((t) => t.textContent)).toEqual(["{?n>3}", "{/n}"]);
    expect(tags[0].getAttribute("title")).toBe('Shown when "n" > 3');
    await render(<TemplateRenderer content="{?n>3}many{/n}" values={{ n: 2 }} />);
    expect(container.textContent).toBe("");
  });
});
