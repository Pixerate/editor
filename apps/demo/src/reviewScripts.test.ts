// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { CommentStore, createRichTextPreset, getTrackedChanges } from "@pixerate/editor";
import { ToolRegistry, createReviewToolProvider, createRichTextToolProvider } from "@pixerate/editor/agent";
import { runAgentScript } from "./agentScript";
import { REVIEW_SCRIPTS } from "./agentScripts";

describe("review agent scripts", () => {
  it("suggest then triage: a tracked edit and a comment, then one accepted and the comment resolved", async () => {
    const store = new CommentStore();
    const editor = new Editor({
      extensions: createRichTextPreset({ markdown: false, comments: { store }, trackChanges: true }),
      // The review view's starting text.
      content:
        "<h3>Review mode</h3><p>Select text and use the bubble menu to add a comment. Turn on tracking and edit this paragraph: insertions are underlined, deletions struck through until accepted or rejected.</p>",
    });
    const reg = new ToolRegistry();
    reg.register(createRichTextToolProvider(editor, { id: "review-text", namespace: "review" }));
    reg.register(createReviewToolProvider(editor, { id: "review", namespace: "review" }));
    const run = async (id: string) => {
      const errors: string[] = [];
      const { ok } = await runAgentScript(reg, REVIEW_SCRIPTS.find((s) => s.id === id)!, {
        wait: () => Promise.resolve(),
        onEvent: (e) => e.type === "error" && errors.push(e.message),
      });
      expect(errors).toEqual([]);
      expect(ok).toBe(true);
    };

    await run("review-suggest");
    const suggested = getTrackedChanges(editor);
    expect(suggested.map((c) => c.type).sort()).toEqual(["deletion", "insertion"]);
    expect(store.getSnapshot().threads.map((t) => [t.anchor?.quote, t.resolved])).toEqual([["until accepted or rejected", false]]);

    await run("review-triage");
    expect(getTrackedChanges(editor)).toHaveLength(1);
    const [thread] = store.getSnapshot().threads;
    expect(thread.resolved).toBe(true);
    expect(thread.replies).toHaveLength(1);
  });
});
