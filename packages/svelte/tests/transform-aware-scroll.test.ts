import { describe, it, expect } from "vitest";
import { transformAwareScrollPluginKey } from "@pixerate/editor";
import { initiateEditor } from "../src/editor.svelte.js";

const hasPlugin = (options?: Parameters<typeof initiateEditor>[3]) => {
  const editor = initiateEditor(undefined, undefined, undefined, options);
  const found = editor.state.plugins.some((p) => (p as any).key === transformAwareScrollPluginKey.key);
  editor.destroy();
  return found;
};

describe("initiateEditor transformAwareScroll", () => {
  it("is on by default", () => expect(hasPlugin()).toBe(true));
  it("can be turned off with the shorthand or the preset option", () => {
    expect(hasPlugin({ transformAwareScroll: false })).toBe(false);
    expect(hasPlugin({ richTextOptions: { transformAwareScroll: false } })).toBe(false);
  });
  it("takes options", () => expect(hasPlugin({ transformAwareScroll: { padding: 24, axis: "vertical" } })).toBe(true));
});
