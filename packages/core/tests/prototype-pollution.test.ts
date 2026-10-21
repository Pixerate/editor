// GHSA-cp6q-959q-f8rh: an own `__proto__` key from JSON must never become a
// prototype on its way to the DOM, whatever `@tiptap/core` version a consumer
// resolves. This file swaps in the `mergeAttributes()` of `@tiptap/core`
// <= 2.27.2 (the unpatched one) so the tests exercise the vulnerable code path.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { JSDOM } from "jsdom";

const legacy = vi.hoisted(() => ({
  // `mergeAttributes` as shipped in @tiptap/core 2.0.0 – 2.27.2 (class/style merging trimmed).
  mergeAttributes(...objects: Record<string, any>[]): Record<string, any> {
    return objects
      .filter((item) => !!item)
      .reduce((items, item) => {
        const merged: Record<string, any> = { ...items };
        Object.entries(item).forEach(([key, value]) => {
          if (!merged[key]) {
            merged[key] = value;
            return;
          }
          merged[key] = key === "class" ? `${merged[key]} ${value}` : value;
        });
        return merged;
      }, {});
  },
}));

vi.mock("@tiptap/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tiptap/core")>()),
  mergeAttributes: legacy.mergeAttributes,
}));

import { Editor } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import {
  Comments,
  CommentStore,
  EditorController,
  createRichTextPreset,
  createStyleRegistry,
  parseRichClipboardPayload,
  safeMergeAttributes,
  serializeRichClipboardPayload,
  stripPrototypeKeys,
} from "../src";
import { createToolRegistry } from "../src/tools";
import { loadSections } from "../src/persistence";

beforeAll(() => {
  const dom = new JSDOM();
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
});

const PAYLOAD = '{"onerror":"globalThis.__pwned = true","src":"x:","data-pwn":"1"}';
/** A JSON object with an own `__proto__` key carrying {@link PAYLOAD}. */
const evil = (base: Record<string, unknown> = {}) =>
  Object.assign(JSON.parse(`{"__proto__":${PAYLOAD}}`), base) as Record<string, unknown>;

const rendered = (editor: Editor) => `${editor.getHTML()}\n${editor.view.dom.innerHTML}`;

describe("the unpatched mergeAttributes (control)", () => {
  it("turns an own __proto__ key into inherited attributes", () => {
    const merged = legacy.mergeAttributes({}, evil());
    expect(Object.keys(merged)).toEqual([]);
    expect(merged.onerror).toBe("globalThis.__pwned = true");
  });
});

describe("stripPrototypeKeys", () => {
  it("drops __proto__, constructor and prototype keys at any depth without mutating the input", () => {
    const input = JSON.parse(
      `{"type":"doc","constructor":1,"content":[{"type":"image","attrs":{"src":"a.png","__proto__":${PAYLOAD},"prototype":{}}}]}`,
    );
    const out = stripPrototypeKeys(input);
    expect(out).toEqual({ type: "doc", content: [{ type: "image", attrs: { src: "a.png" } }] });
    expect(Object.getPrototypeOf(out.content[0].attrs)).toBe(Object.prototype);
    expect(Object.keys(input.content[0].attrs)).toContain("__proto__");
  });

  it("returns clean input unchanged and leaves class instances alone", () => {
    const clean = { a: [1, { b: 2 }], when: new Date(0) };
    expect(stripPrototypeKeys(clean)).toBe(clean);
    const date = new Date(0);
    expect(stripPrototypeKeys({ ...evil(), date }).date).toBe(date);
    expect(stripPrototypeKeys("text")).toBe("text");
    expect(stripPrototypeKeys(null)).toBe(null);
  });

  it("handles cycles", () => {
    const cyclic: any = evil({ name: "a" });
    cyclic.self = cyclic;
    const out = stripPrototypeKeys(cyclic);
    expect(out.self).toBe(out);
    expect(out.onerror).toBeUndefined();
  });
});

describe("safeMergeAttributes", () => {
  it("never yields inherited attributes, even with the unpatched mergeAttributes", () => {
    const merged = safeMergeAttributes({ class: "a" }, evil({ class: "b" }), null, undefined);
    expect(merged).toEqual({ class: "a b" });
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(merged.onerror).toBeUndefined();
  });
});

describe("library entry points", () => {
  it("does not render attributes inherited from JSON HTMLAttributes options", () => {
    const editor = new Editor({
      extensions: [...createRichTextPreset(), Comments.configure({ HTMLAttributes: evil({ class: "c" }) })],
      content: '<p><span data-comment-id="t1">hi</span></p>',
    });
    const html = rendered(editor);
    expect(html).toContain('data-comment-id="t1"');
    expect(html).not.toMatch(/onerror|data-pwn/);
    editor.destroy();
  });

  it("does not render attributes inherited through a custom attribute that renders a JSON object", () => {
    // A consumer extension whose attribute keeps an object from document JSON
    // (the advisory's precondition). TipTap hands our renderHTML an own
    // `__proto__` key; the unpatched mergeAttributes would make it a prototype.
    const Extended = Comments.extend({
      addAttributes() {
        return {
          ...this.parent?.(),
          extra: { default: null, renderHTML: (attrs: Record<string, any>) => attrs.extra ?? {} },
        };
      },
    });
    const editor = new Editor({
      extensions: [...createRichTextPreset(), Extended],
      content: JSON.parse(
        `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"hi","marks":[{"type":"comment","attrs":{"commentId":"t1","extra":{"__proto__":${PAYLOAD}}}}]}]}]}`,
      ),
    });
    const html = rendered(editor);
    expect(html).toContain('data-comment-id="t1"');
    expect(html).not.toMatch(/onerror|data-pwn/);
    editor.destroy();
  });

  it("strips __proto__ keys from EditorController JSON content", () => {
    const content = JSON.parse(
      `{"type":"doc","content":[{"type":"paragraph","attrs":{"__proto__":${PAYLOAD}},"content":[{"type":"text","text":"hi","marks":[{"type":"link","attrs":{"href":"https://example.com","__proto__":${PAYLOAD}}}]}]}]}`,
    );
    const controller = new EditorController({ extensions: createRichTextPreset(), content });
    expect(rendered(controller.editor)).not.toMatch(/onerror|data-pwn/);
    expect(controller.editor.getText()).toBe("hi");
    controller.editor.destroy();
  });

  it("strips __proto__ keys from the rich clipboard payload", () => {
    const editor = new Editor({ extensions: createRichTextPreset(), content: "<p>hi</p>" });
    const payload = JSON.parse(serializeRichClipboardPayload(Slice.fromJSON(editor.schema, {
      content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
    }), editor.schema));
    payload.slice.content[0].attrs = evil({ textAlign: null });
    const text = JSON.stringify(payload);
    expect(text).toContain('"__proto__"');
    const slice = parseRichClipboardPayload(text, editor.schema);
    expect(slice).not.toBeNull();
    expect(JSON.stringify(slice!.toJSON())).not.toMatch(/onerror|data-pwn/);
    editor.destroy();
  });

  it("strips __proto__ keys from agent tool arguments before the handler sees them", async () => {
    const registry = createToolRegistry();
    let seen: Record<string, unknown> | undefined;
    registry.register({
      id: "probe",
      tools: [
        {
          name: "set_attrs",
          title: "Set attributes",
          description: "Copies attributes key by key, like a handler building node attrs.",
          inputSchema: {
            type: "object",
            properties: { attrs: { type: "object", description: "Attributes to copy." } },
            required: ["attrs"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          handler: ({ attrs }) => {
            seen = Object.assign({}, attrs);
            return { keys: Object.keys(seen) };
          },
        },
      ],
    });
    const args = JSON.parse(`{"attrs":{"level":2,"__proto__":${PAYLOAD}}}`);
    const result = await registry.callTool("set_attrs", args);
    expect(result.isError).toBeFalsy();
    expect(seen).toEqual({ level: 2 });
    expect((seen as any).onerror).toBeUndefined();
  });

  it("does not let a stored comment thread change its prototype", () => {
    const [thread] = CommentStore.parse(
      `[{"id":"t1","__proto__":${PAYLOAD},"comments":[{"id":"c1","body":"hi","author":{"id":"a","name":"A"},"createdAt":1}]}]`,
    );
    expect(thread.id).toBe("t1");
    expect((thread as any).onerror).toBeUndefined();
  });

  it("keeps __proto__ keys out of persisted documents' unknown sections", () => {
    const { unknown } = loadSections(JSON.parse(`{"extra":1,"__proto__":${PAYLOAD}}`), {});
    expect(unknown).toEqual({ extra: 1 });
    expect(Object.getPrototypeOf(unknown)).toBe(Object.prototype);
  });

  it("does not let style definitions inherit formatting from a __proto__ key", () => {
    const styles = createStyleRegistry();
    styles.upsert({ id: "evil", name: "Evil", kind: "paragraph", character: evil({ bold: true }) as any });
    const { character } = styles.resolve("evil");
    expect(character.bold).toBe(true);
    expect(Object.getPrototypeOf(character)).toBe(Object.prototype);
    expect((character as any).onerror).toBeUndefined();
  });
});
