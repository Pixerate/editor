import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import { Editor } from "@tiptap/core";
import {
  Comments,
  CommentStore,
  TrackChanges,
  createRichTextPreset,
  getTrackedChanges,
} from "@pixerate/editor";
import {
  CommentButton,
  CommentsPanel,
  ReviewToolbar,
  createComments,
  createTrackChanges,
} from "../src/review";
import * as RootExports from "../src";

const alice = { id: "alice", name: "Alice" };
let cleanups: (() => void)[] = [];

beforeAll(() => {
  // ProseMirror measures layout; jsdom does not implement these.
  document.elementFromPoint = () => null;
  HTMLElement.prototype.scrollIntoView = () => {};
  Range.prototype.getClientRects = () => [] as any;
  Range.prototype.getBoundingClientRect = () => ({}) as DOMRect;
});

afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

function makeEditor(content = "<p>Hello brave new world</p>") {
  let n = 0;
  const store = new CommentStore({ generateId: () => `r-${++n}` });
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...createRichTextPreset(),
      Comments.configure({ store, author: alice }),
      TrackChanges.configure({ author: alice }),
    ],
    content,
  });
  cleanups.push(() => editor.destroy());
  return { editor, store };
}

function render(component: any, props: Record<string, any>) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = mount(component, { target, props });
  flushSync();
  cleanups.unshift(() => {
    unmount(instance);
    target.remove();
  });
  return target;
}

const button = (root: Element, label: string) =>
  Array.from(root.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  ) as HTMLButtonElement;

function click(el: Element) {
  (el as HTMLElement).click();
  flushSync();
}

function typeInto(el: HTMLTextAreaElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

describe("Svelte review runes", () => {
  it("exports the review components from the package root", () => {
    expect(RootExports.CommentsPanel).toBe(CommentsPanel);
    expect(RootExports.ReviewToolbar).toBe(ReviewToolbar);
    expect(RootExports.CommentButton).toBe(CommentButton);
  });

  it("createComments tracks the store and follows the store contract", () => {
    const { editor, store } = makeEditor();
    const comments = createComments(editor);
    expect(comments.store).toBe(store);
    expect(comments.threads).toEqual([]);
    const seen: number[] = [];
    const unsubscribe = comments.subscribe((s) => seen.push(s.threads.length));

    editor.commands.setTextSelection({ from: 7, to: 12 });
    editor.commands.addComment({ body: "Hi", id: "t1" });
    expect(comments.threads.map((t) => t.id)).toEqual(["t1"]);
    expect(comments.activeThreadId).toBe("t1");
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(1);
    unsubscribe();
    comments.destroy();

    const empty = createComments(null);
    expect(empty.threads).toEqual([]);
    expect(empty.store).toBeNull();
  });

  it("createTrackChanges exposes state and commands", () => {
    const { editor } = makeEditor("<p>one</p>");
    const review = createTrackChanges(editor);
    expect(review.enabled).toBe(false);
    review.toggle();
    expect(review.enabled).toBe(true);
    editor.commands.setTextSelection(4);
    editor.view.dispatch(editor.state.tr.insertText("!"));
    expect(review.changes.map((c) => c.text)).toEqual(["!"]);
    expect(review.currentChange?.text).toBe("!");
    review.acceptAll();
    expect(review.changes).toEqual([]);
    expect(editor.getText()).toBe("one!");
    review.destroy();

    const none = createTrackChanges(null);
    expect(() => none.acceptAll()).not.toThrow();
  });
});

describe("Svelte CommentsPanel", () => {
  it("lists threads, replies, resolves and deletes", () => {
    const { editor, store } = makeEditor();
    editor.commands.setTextSelection({ from: 7, to: 12 });
    editor.commands.addComment({ body: "Too bold?", id: "t1" });
    const root = render(CommentsPanel, { editor });

    const card = root.querySelector('[data-thread-id="t1"]')!;
    expect(card.textContent).toContain("Alice");
    expect(card.textContent).toContain("Too bold?");
    expect(card.querySelector("blockquote")!.textContent!.trim()).toBe("brave");

    const textarea = card.querySelector("textarea")!;
    expect(textarea.getAttribute("aria-label")).toBe("Reply");
    typeInto(textarea, "Agreed");
    click(button(root, "Reply"));
    expect(store.getThread("t1")!.replies.map((r) => r.body)).toEqual(["Agreed"]);
    expect(root.textContent).toContain("Agreed");

    click(button(root, "Resolve"));
    expect(store.getThread("t1")!.resolved).toBe(true);
    expect(root.querySelector('[data-thread-id="t1"]')).toBeNull();
    click(button(root, "Show resolved"));
    expect(root.querySelector('[data-thread-id="t1"]')).not.toBeNull();
    click(button(root, "Reopen"));
    expect(store.getThread("t1")!.resolved).toBe(false);

    click(button(root, "Delete"));
    expect(store.getThread("t1")).toBeUndefined();
    expect(editor.getHTML()).not.toContain("data-comment-id");
    expect(root.textContent).toContain("No comments yet");
  });

  it("clicking a thread selects its text in the editor", () => {
    const { editor, store } = makeEditor();
    editor.commands.setTextSelection({ from: 7, to: 12 });
    editor.commands.addComment({ body: "One", id: "t1" });
    editor.commands.setTextSelection(1);
    const root = render(CommentsPanel, { editor });
    expect(store.getSnapshot().activeThreadId).toBeNull();
    click(root.querySelector('[data-thread-id="t1"]')!);
    expect(store.getSnapshot().activeThreadId).toBe("t1");
    expect(editor.state.selection.from).toBe(7);
    expect(editor.state.selection.to).toBe(12);
  });

  it("completes a draft created by CommentButton, or cancels it", () => {
    const { editor, store } = makeEditor();
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const buttonRoot = render(CommentButton, { editor });
    const root = render(CommentsPanel, { editor });

    click(button(buttonRoot, "Comment"));
    const [thread] = store.getSnapshot().threads;
    expect(thread.body).toBe("");
    const card = root.querySelector(`[data-thread-id="${thread.id}"]`)!;
    const textarea = card.querySelector("textarea")!;
    expect(textarea.getAttribute("aria-label")).toBe("Comment");
    typeInto(textarea, "Greeting is fine");
    click(button(card, "Comment"));
    expect(store.getThread(thread.id)!.body).toBe("Greeting is fine");

    editor.commands.setTextSelection({ from: 7, to: 12 });
    click(button(buttonRoot, "Comment"));
    const draft = store.getSnapshot().threads.find((t) => t.body === "")!;
    click(button(root, "Cancel"));
    expect(store.getThread(draft.id)).toBeUndefined();
  });

  it("marks orphaned threads", () => {
    const { editor } = makeEditor();
    editor.commands.setTextSelection({ from: 7, to: 12 });
    editor.commands.addComment({ body: "x", id: "t1" });
    const root = render(CommentsPanel, { editor });
    editor.commands.deleteRange({ from: 7, to: 12 });
    flushSync();
    const card = root.querySelector('[data-thread-id="t1"]')!;
    expect(card.textContent).toContain("The commented text was deleted.");
  });
});

describe("Svelte ReviewToolbar", () => {
  it("toggles tracking and navigates, accepts and rejects changes", () => {
    const { editor } = makeEditor("<p>one two three</p>");
    const root = render(ReviewToolbar, { editor });
    expect(root.textContent).toContain("No changes");
    expect(button(root, "Accept all").disabled).toBe(true);

    click(button(root, "Track changes"));
    expect(button(root, "Tracking on").getAttribute("aria-pressed")).toBe("true");

    editor.commands.setTextSelection(4);
    editor.view.dispatch(editor.state.tr.insertText("!"));
    editor.commands.setTextSelection(15);
    editor.view.dispatch(editor.state.tr.insertText("?"));
    editor.commands.setTextSelection(1);
    flushSync();
    expect(root.textContent).toContain("2 changes");
    expect(button(root, "Accept").disabled).toBe(true);

    click(button(root, "Next change"));
    expect(root.textContent).toContain("1 of 2");
    click(button(root, "Accept"));
    expect(editor.getText()).toBe("one! two three?");
    expect(getTrackedChanges(editor)).toHaveLength(1);

    click(button(root, "Previous change"));
    expect(root.textContent).toContain("1 of 1");
    click(button(root, "Reject"));
    expect(editor.getText()).toBe("one! two three");
    expect(root.textContent).toContain("No changes");

    editor.commands.setTextSelection(1);
    editor.view.dispatch(editor.state.tr.insertText(">"));
    flushSync();
    click(button(root, "Reject all"));
    expect(editor.getText()).toBe("one! two three");
    editor.view.dispatch(editor.state.tr.insertText(">"));
    flushSync();
    click(button(root, "Accept all"));
    expect(editor.getText()).toBe(">one! two three");
  });
});
