// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
  useComments,
  useTrackChanges,
} from "../src";

let container: HTMLDivElement;
let root: Root;
let editors: Editor[] = [];

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  // ProseMirror measures layout; jsdom does not implement these.
  document.elementFromPoint = () => null;
  HTMLElement.prototype.scrollIntoView = () => {};
  Range.prototype.getClientRects = () => [] as any;
  Range.prototype.getBoundingClientRect = () => ({}) as DOMRect;
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  editors.forEach((e) => e.destroy());
  editors = [];
});

const alice = { id: "alice", name: "Alice" };

function makeEditor(content = "<p>Hello brave new world</p>", trackChanges = false) {
  let n = 0;
  const store = new CommentStore({ generateId: () => `r-${++n}` });
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...createRichTextPreset(),
      Comments.configure({ store, author: alice }),
      TrackChanges.configure({ enabled: trackChanges, author: alice }),
    ],
    content,
  });
  editors.push(editor);
  return { editor, store };
}

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

const buttons = () => Array.from(container.querySelectorAll("button"));
const button = (label: string) =>
  buttons().find((b) => b.textContent === label || b.getAttribute("aria-label") === label)!;

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

async function typeInto(el: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("useComments / useTrackChanges", () => {
  it("re-render only when the stores change and keep snapshots stable", async () => {
    const { editor, store } = makeEditor();
    let renders = 0;
    let latest: any = null;
    function Probe() {
      renders++;
      latest = { comments: useComments(editor), review: useTrackChanges(editor) };
      return null;
    }
    await render(<Probe />);
    const initialRenders = renders;
    expect(latest.comments.threads).toEqual([]);
    expect(latest.review.enabled).toBe(false);

    await act(async () => {
      editor.commands.setTextSelection({ from: 7, to: 12 });
      editor.commands.addComment({ body: "Hi", id: "t1" });
    });
    expect(latest.comments.threads.map((t: any) => t.id)).toEqual(["t1"]);
    expect(latest.comments.activeThreadId).toBe("t1");
    expect(latest.comments.store).toBe(store);

    await act(async () => latest.review.toggle());
    expect(latest.review.enabled).toBe(true);
    // Bounded renders: no snapshot loop.
    expect(renders - initialRenders).toBeLessThan(10);
  });

  it("accepts a store directly and handles a null editor", async () => {
    const store = new CommentStore();
    let result: any = null;
    function Probe() {
      result = { fromStore: useComments(store), none: useComments(null), review: useTrackChanges(null) };
      return null;
    }
    await render(<Probe />);
    await act(async () => {
      store.createThread({ body: "x", author: alice });
    });
    expect(result.fromStore.threads).toHaveLength(1);
    expect(result.none.threads).toEqual([]);
    expect(result.review.changes).toEqual([]);
    expect(() => result.review.acceptAll()).not.toThrow();
  });
});

describe("CommentsPanel", () => {
  it("lists threads, replies, resolves and deletes", async () => {
    const { editor, store } = makeEditor();
    editor.commands.setTextSelection({ from: 7, to: 12 });
    editor.commands.addComment({ body: "Too bold?", id: "t1" });
    await render(<CommentsPanel editor={editor} />);

    const card = container.querySelector('[data-thread-id="t1"]')!;
    expect(card.textContent).toContain("Alice");
    expect(card.textContent).toContain("Too bold?");
    expect(card.querySelector("blockquote")!.textContent).toBe("brave");
    expect(card.getAttribute("data-active")).toBe("true");

    // Reply (active thread shows the reply box).
    const textarea = card.querySelector("textarea")!;
    expect(textarea.getAttribute("aria-label")).toBe("Reply");
    await typeInto(textarea, "Agreed");
    await click(button("Reply"));
    expect(store.getThread("t1")!.replies.map((r) => r.body)).toEqual(["Agreed"]);
    expect(container.textContent).toContain("Agreed");

    // Resolve hides the thread until "Show resolved".
    await click(button("Resolve"));
    expect(store.getThread("t1")!.resolved).toBe(true);
    expect(container.querySelector('[data-thread-id="t1"]')).toBeNull();
    await click(button("Show resolved"));
    expect(container.querySelector('[data-thread-id="t1"]')).not.toBeNull();
    await click(button("Reopen"));
    expect(store.getThread("t1")!.resolved).toBe(false);

    await click(button("Delete"));
    expect(store.getThread("t1")).toBeUndefined();
    expect(editor.getHTML()).not.toContain("data-comment-id");
    expect(container.textContent).toContain("No comments yet");
  });

  it("clicking a thread selects its text in the editor", async () => {
    const { editor, store } = makeEditor();
    editor.commands.setTextSelection({ from: 7, to: 12 });
    editor.commands.addComment({ body: "One", id: "t1" });
    editor.commands.setTextSelection(1);
    await render(<CommentsPanel editor={editor} />);
    expect(store.getSnapshot().activeThreadId).toBeNull();

    await click(container.querySelector('[data-thread-id="t1"]')!);
    expect(store.getSnapshot().activeThreadId).toBe("t1");
    expect(editor.state.selection.from).toBe(7);
    expect(editor.state.selection.to).toBe(12);
  });

  it("completes a draft created by CommentButton, or cancels it", async () => {
    const { editor, store } = makeEditor();
    editor.commands.setTextSelection({ from: 1, to: 6 });
    await render(
      <>
        <CommentButton editor={editor} />
        <CommentsPanel editor={editor} />
      </>,
    );
    await click(button("Comment"));
    const [thread] = store.getSnapshot().threads;
    expect(thread.body).toBe("");
    const textarea = container.querySelector<HTMLTextAreaElement>(
      `[data-thread-id="${thread.id}"] textarea`,
    )!;
    expect(textarea.getAttribute("aria-label")).toBe("Comment");
    await typeInto(textarea, "Greeting is fine");
    const post = Array.from(
      container.querySelectorAll<HTMLButtonElement>(`[data-thread-id="${thread.id}"] button`),
    ).find((b) => b.textContent === "Comment")!;
    await click(post);
    expect(store.getThread(thread.id)!.body).toBe("Greeting is fine");

    editor.commands.setTextSelection({ from: 7, to: 12 });
    await click(button("Comment"));
    const draft = store.getSnapshot().threads.find((t) => t.body === "")!;
    await click(button("Cancel"));
    expect(store.getThread(draft.id)).toBeUndefined();
  });

  it("marks orphaned threads", async () => {
    const { editor } = makeEditor();
    editor.commands.setTextSelection({ from: 7, to: 12 });
    editor.commands.addComment({ body: "x", id: "t1" });
    await render(<CommentsPanel editor={editor} />);
    await act(async () => {
      editor.commands.deleteRange({ from: 7, to: 12 });
    });
    const card = container.querySelector('[data-thread-id="t1"]')!;
    expect(card.textContent).toContain("The commented text was deleted.");
    expect(card.querySelector("blockquote")!.textContent).toBe("brave");
  });
});

describe("ReviewToolbar", () => {
  it("toggles tracking and navigates, accepts and rejects changes", async () => {
    const { editor } = makeEditor("<p>one two three</p>");
    await render(<ReviewToolbar editor={editor} />);
    expect(container.textContent).toContain("No changes");
    expect(button("Accept all").disabled).toBe(true);

    await click(button("Track changes"));
    expect(button("Tracking on").getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      editor.commands.setTextSelection(4);
      editor.view.dispatch(editor.state.tr.insertText("!"));
      editor.commands.setTextSelection(15);
      editor.view.dispatch(editor.state.tr.insertText("?"));
      editor.commands.setTextSelection(1);
    });
    expect(container.textContent).toContain("2 changes");
    expect(button("Accept").disabled).toBe(true);

    await click(button("Next change"));
    expect(container.textContent).toContain("1 of 2");
    await click(button("Accept"));
    expect(editor.getText()).toBe("one! two three?");
    expect(getTrackedChanges(editor)).toHaveLength(1);

    await click(button("Previous change"));
    expect(container.textContent).toContain("1 of 1");
    await click(button("Reject"));
    expect(editor.getText()).toBe("one! two three");
    expect(container.textContent).toContain("No changes");

    await act(async () => {
      editor.commands.setTextSelection(1);
      editor.view.dispatch(editor.state.tr.insertText(">"));
    });
    await click(button("Reject all"));
    expect(editor.getText()).toBe("one! two three");
    await act(async () => {
      editor.commands.setTextSelection(1);
      editor.view.dispatch(editor.state.tr.insertText(">"));
    });
    await click(button("Accept all"));
    expect(editor.getText()).toBe(">one! two three");
    expect(getTrackedChanges(editor)).toEqual([]);
  });

  it("shows formatting and block changes with their descriptions", async () => {
    const { editor } = makeEditor("<p>Title</p><p>Body text</p>", true);
    editor.chain().setTextSelection(2).toggleHeading({ level: 2 }).run();
    editor.chain().setTextSelection({ from: 8, to: 12 }).toggleBold().run();
    await render(<ReviewToolbar editor={editor} descriptionClassName="my-desc" />);
    expect(container.textContent).toContain("2 of 2");
    const label = () => container.querySelector("[data-change-type]") as HTMLElement | null;
    expect(label()!.getAttribute("data-change-type")).toBe("format");
    expect(label()!.textContent).toBe("Alice: Formatted: Bold");
    expect(label()!.className).toBe("my-desc");

    await click(button("Previous change"));
    expect(label()!.getAttribute("data-change-type")).toBe("block");
    expect(label()!.textContent).toBe("Alice: Changed Paragraph to Heading 2");
    await click(button("Reject"));
    expect(editor.state.doc.firstChild!.type.name).toBe("paragraph");
    expect(container.textContent).toContain("1 changes");

    await click(button("Accept all"));
    expect(editor.getHTML()).toBe("<p>Title</p><p><strong>Body</strong> text</p>");
    expect(label()).toBeNull();
  });

  it("can hide the description", async () => {
    const { editor } = makeEditor("<p>Body</p>", true);
    editor.chain().setTextSelection({ from: 1, to: 5 }).toggleItalic().run();
    await render(<ReviewToolbar editor={editor} showDescription={false} />);
    expect(container.textContent).toContain("1 of 1");
    expect(container.querySelector("[data-change-type]")).toBeNull();
  });
});
