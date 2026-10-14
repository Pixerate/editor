import { describe, it, expect, beforeAll, vi } from "vitest";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import {
  Comments,
  CommentStore,
  createCommentStore,
  createRichTextPreset,
  findCommentRanges,
  getCommentAnchors,
  getCommentStore,
  getEditorText,
  formatReviewTime,
  getCommentAuthor,
} from "../src";

beforeAll(() => {
  const dom = new JSDOM();
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
});

const alice = { id: "alice", name: "Alice" };
const bob = { id: "bob", name: "Bob" };

function makeStore() {
  let id = 0;
  let time = 1000;
  return new CommentStore({ generateId: () => `id-${++id}`, now: () => ++time });
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("CommentStore", () => {
  it("creates threads, replies, edits, resolves and deletes", () => {
    const store = makeStore();
    const thread = store.createThread({ body: "Typo?", author: alice });
    expect(thread.id).toBe("id-1");
    expect(store.getSnapshot().threads).toHaveLength(1);

    const reply = store.addReply(thread.id, { body: "Fixed", author: bob });
    expect(reply?.author).toEqual(bob);
    expect(store.getThread(thread.id)!.replies).toHaveLength(1);

    store.editComment(thread.id, "Typo here?");
    expect(store.getThread(thread.id)!.body).toBe("Typo here?");
    expect(store.getThread(thread.id)!.editedAt).toBeDefined();
    store.editComment(thread.id, "Fixed it", reply!.id);
    expect(store.getThread(thread.id)!.replies[0].body).toBe("Fixed it");

    store.resolveThread(thread.id, true, bob);
    expect(store.getThread(thread.id)!.resolved).toBe(true);
    expect(store.getThread(thread.id)!.resolvedBy).toEqual(bob);

    // Replying re-opens a resolved thread.
    store.addReply(thread.id, { body: "Not quite", author: alice });
    expect(store.getThread(thread.id)!.resolved).toBe(false);

    store.deleteReply(thread.id, reply!.id);
    expect(store.getThread(thread.id)!.replies.map((r) => r.body)).toEqual(["Not quite"]);

    expect(store.deleteThread(thread.id)).toBe(true);
    expect(store.getSnapshot().threads).toHaveLength(0);
    expect(store.addReply("missing", { body: "x", author: alice })).toBeNull();
  });

  it("keeps snapshot identity until something changes", () => {
    const store = makeStore();
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    store.createThread({ body: "Hi", author: alice });
    const second = store.getSnapshot();
    expect(second).not.toBe(first);
    expect(store.getSnapshot()).toBe(second);
    // No-op updates do not replace the snapshot.
    store.resolveThread(second.threads[0].id, false);
    store.setActiveThread(null);
    expect(store.getSnapshot()).toBe(second);
  });

  it("calls subscribers immediately and on every change", () => {
    const store = makeStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    store.createThread({ body: "Hi", author: alice });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.clear();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("serializes to JSON and loads it back", () => {
    const store = makeStore();
    const t = store.createThread({
      body: "Check",
      author: alice,
      anchor: { from: 1, to: 4, quote: "abc" },
    });
    store.addReply(t.id, { body: "OK", author: bob });
    store.resolveThread(t.id);

    const json = JSON.stringify(store.toJSON());
    const restored = createCommentStore({ threads: JSON.parse(json) });
    expect(restored.getSnapshot().threads).toEqual(store.getSnapshot().threads);

    const other = makeStore();
    other.load(json);
    expect(other.getThread(t.id)!.replies[0].body).toBe("OK");
    expect(CommentStore.parse({} as any)).toEqual([]);
    expect(CommentStore.parse({ version: 1, threads: [{ id: 7 } as any] })[0]).toMatchObject({
      id: "7",
      body: "",
      replies: [],
      resolved: false,
    });
  });

  it("orders threads by anchor position, orphans last", () => {
    const store = makeStore();
    const a = store.createThread({ body: "a", author: alice, anchor: { from: 10, to: 12, quote: "" } });
    const b = store.createThread({ body: "b", author: alice, anchor: { from: 2, to: 4, quote: "" } });
    const c = store.createThread({ body: "c", author: alice });
    expect(store.getSnapshot().threads.map((t) => t.id)).toEqual([b.id, a.id, c.id]);
  });

  it("syncAnchors orphans missing threads and restores deleted ones", () => {
    const store = makeStore();
    const t = store.createThread({ body: "x", author: alice, anchor: { from: 1, to: 3, quote: "ab" } });
    expect(store.syncAnchors(new Map())).toBe(true);
    expect(store.getThread(t.id)).toMatchObject({ orphaned: true, anchor: null, lastQuote: "ab" });
    expect(store.syncAnchors(new Map())).toBe(false);

    store.deleteThread(t.id);
    store.syncAnchors(new Map([[t.id, { from: 1, to: 3, quote: "ab" }]]));
    expect(store.getThread(t.id)).toMatchObject({ orphaned: false, anchor: { from: 1, to: 3 } });

    store.syncAnchors(new Map());
    expect(store.removeOrphanedThreads()).toEqual([t.id]);
    expect(store.getSnapshot().threads).toHaveLength(0);
  });
});

function createEditor(content = "<p>Hello brave new world</p>", store = makeStore()) {
  const editor = new Editor({
    extensions: [...createRichTextPreset(), Comments.configure({ store, author: alice })],
    content,
  });
  return { editor, store };
}

describe("Comments extension", () => {
  it("is opt-in via createRichTextPreset", () => {
    expect(createRichTextPreset().some((e: any) => e.name === "comment")).toBe(false);
    expect(createRichTextPreset({ comments: true }).some((e: any) => e.name === "comment")).toBe(true);
  });

  it("creates its own store when none is given", () => {
    const editor = new Editor({ extensions: [...createRichTextPreset({ comments: true })] });
    expect(getCommentStore(editor)).toBeInstanceOf(CommentStore);
    editor.destroy();
  });

  it("addComment marks the selection and creates an active thread", () => {
    const { editor, store } = createEditor();
    expect(editor.commands.addComment({ body: "No" })).toBe(false); // empty selection

    editor.commands.setTextSelection({ from: 7, to: 12 });
    expect(editor.commands.addComment({ body: "Too bold?", id: "t1" })).toBe(true);

    expect(editor.getHTML()).toContain('<span data-comment-id="t1">brave</span>');
    const thread = store.getThread("t1")!;
    expect(thread).toMatchObject({ body: "Too bold?", author: alice, resolved: false });
    expect(thread.anchor).toEqual({ from: 7, to: 12, quote: "brave" });
    expect(store.getSnapshot().activeThreadId).toBe("t1");
    expect(getEditorText(editor)).toBe("Hello brave new world");
    editor.destroy();
  });

  it("supports overlapping comments", () => {
    const { editor } = createEditor();
    editor.commands.setTextSelection({ from: 1, to: 12 });
    editor.commands.addComment({ body: "one", id: "a" });
    editor.commands.setTextSelection({ from: 7, to: 16 });
    editor.commands.addComment({ body: "two", id: "b" });
    const ranges = findCommentRanges(editor.state.doc);
    expect(ranges.get("a")).toEqual([{ from: 1, to: 12 }]);
    expect(ranges.get("b")).toEqual([{ from: 7, to: 16 }]);
    expect(getCommentAnchors(editor.state.doc).get("b")!.quote).toBe("brave new");
    editor.destroy();
  });

  it("parses comment marks from HTML", () => {
    const { editor, store } = createEditor('<p>Hi <span data-comment-id="x">there</span></p>');
    expect(findCommentRanges(editor.state.doc).get("x")).toEqual([{ from: 4, to: 9 }]);
    // Marks without a thread do not create one.
    expect(store.getThread("x")).toBeUndefined();
    editor.destroy();
  });

  it("resolveComment and setActiveComment update the store and decorations", async () => {
    const { editor, store } = createEditor();
    editor.commands.setTextSelection({ from: 7, to: 12 });
    editor.commands.addComment({ body: "?", id: "t1" });
    expect(editor.view.dom.querySelector(".pixerate-comment-active")).not.toBeNull();

    editor.commands.setActiveComment(null);
    expect(store.getSnapshot().activeThreadId).toBeNull();
    expect(editor.view.dom.querySelector(".pixerate-comment-active")).toBeNull();
    expect(editor.view.dom.querySelector(".pixerate-comment")).not.toBeNull();

    expect(editor.commands.resolveComment("t1")).toBe(true);
    expect(store.getThread("t1")!.resolved).toBe(true);
    expect(store.getThread("t1")!.resolvedBy).toEqual(alice);
    // Resolved comments are not highlighted by default.
    expect(editor.view.dom.querySelector(".pixerate-comment")).toBeNull();

    expect(editor.commands.resolveComment("missing")).toBe(false);
    expect(editor.commands.setActiveComment("missing")).toBe(false);

    // Changes made directly on the store redraw after a microtask.
    store.resolveThread("t1", false);
    await flush();
    expect(editor.view.dom.querySelector(".pixerate-comment")).not.toBeNull();
    editor.destroy();
  });

  it("deleteComment removes only that thread's mark and is undoable", () => {
    const { editor, store } = createEditor();
    editor.commands.setTextSelection({ from: 1, to: 12 });
    editor.commands.addComment({ body: "one", id: "a" });
    editor.commands.setTextSelection({ from: 7, to: 16 });
    editor.commands.addComment({ body: "two", id: "b" });

    expect(editor.commands.deleteComment("a")).toBe(true);
    expect(findCommentRanges(editor.state.doc).has("a")).toBe(false);
    expect(findCommentRanges(editor.state.doc).get("b")).toEqual([{ from: 7, to: 16 }]);
    expect(store.getThread("a")).toBeUndefined();

    editor.commands.undo();
    expect(findCommentRanges(editor.state.doc).get("a")).toEqual([{ from: 1, to: 12 }]);
    expect(store.getThread("a")).toMatchObject({ body: "one", orphaned: false });
    editor.destroy();
  });

  it("flags threads as orphaned when their text is deleted, and re-attaches on undo", () => {
    const { editor, store } = createEditor();
    editor.commands.setTextSelection({ from: 7, to: 12 });
    editor.commands.addComment({ body: "?", id: "t1" });

    editor.commands.deleteRange({ from: 6, to: 12 });
    expect(editor.getText()).toBe("Hello new world");
    expect(store.getThread("t1")).toMatchObject({
      orphaned: true,
      anchor: null,
      lastQuote: "brave",
    });

    editor.commands.undo();
    expect(store.getThread("t1")).toMatchObject({
      orphaned: false,
      anchor: { from: 7, to: 12, quote: "brave" },
    });
    editor.destroy();
  });

  it("updates anchors as text moves", () => {
    const { editor, store } = createEditor();
    editor.commands.setTextSelection({ from: 7, to: 12 });
    editor.commands.addComment({ body: "?", id: "t1" });
    editor.commands.insertContentAt(1, "Oh, ");
    expect(store.getThread("t1")!.anchor).toEqual({ from: 11, to: 16, quote: "brave" });
    // Typing right after the comment does not extend it.
    editor.commands.setTextSelection(16);
    editor.commands.insertContent("r");
    expect(store.getThread("t1")!.anchor!.quote).toBe("brave");
    editor.destroy();
  });

  it("focusComment selects the anchor and activates the thread", () => {
    const { editor, store } = createEditor();
    editor.commands.setTextSelection({ from: 7, to: 12 });
    editor.commands.addComment({ body: "?", id: "t1" });
    editor.commands.setTextSelection(1);
    expect(store.getSnapshot().activeThreadId).toBeNull();

    expect(editor.commands.focusComment("t1")).toBe(true);
    expect(editor.state.selection.from).toBe(7);
    expect(editor.state.selection.to).toBe(12);
    expect(store.getSnapshot().activeThreadId).toBe("t1");
    expect(editor.commands.focusComment("missing")).toBe(false);
    editor.destroy();
  });

  it("activates the thread under the caret", () => {
    const { editor, store } = createEditor();
    editor.commands.setTextSelection({ from: 7, to: 12 });
    editor.commands.addComment({ body: "?", id: "t1" });
    editor.commands.setTextSelection(2);
    expect(store.getSnapshot().activeThreadId).toBeNull();
    editor.commands.setTextSelection(9);
    expect(store.getSnapshot().activeThreadId).toBe("t1");
    editor.destroy();
  });

  it("excludes comments from markdown export", () => {
    const store = makeStore();
    const editor = new Editor({
      extensions: [
        ...createRichTextPreset({ markdown: true }),
        Comments.configure({ store, author: alice }),
      ],
      content: "Hello **brave** world",
    });
    editor.commands.setTextSelection({ from: 7, to: 12 });
    editor.commands.addComment({ body: "?" });
    expect(editor.storage.markdown.getMarkdown()).toBe("Hello **brave** world");
    editor.destroy();
  });
});

describe("review helpers", () => {
  it("formatReviewTime renders relative times", () => {
    const now = 10_000_000_000;
    expect(formatReviewTime(now - 10_000, now)).toBe("just now");
    expect(formatReviewTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatReviewTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatReviewTime(now - 3 * 86_400_000, now)).toBe(
      new Date(now - 3 * 86_400_000).toLocaleDateString(),
    );
  });

  it("getCommentAuthor reads the configured author", () => {
    const { editor } = createEditor();
    expect(getCommentAuthor(editor)).toEqual(alice);
    expect(getCommentAuthor(null)).toBeNull();
    editor.destroy();
    const dynamic = new Editor({
      extensions: [...createRichTextPreset(), Comments.configure({ author: () => bob })],
    });
    expect(getCommentAuthor(dynamic)).toEqual(bob);
    dynamic.destroy();
  });
});
