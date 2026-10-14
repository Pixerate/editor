import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { Editor } from "@tiptap/core";
import { CommentStore, createRichTextPreset, docxToDocumentImport } from "@pixerate/editor";
import { ExportDocxButton, createDocxExport } from "../src";

let downloads: { name: string; blob: Blob }[];

beforeAll(() => {
  document.elementFromPoint = () => null;
  HTMLElement.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  downloads = [];
  const blobs = new Map<string, Blob>();
  (URL as any).createObjectURL = (blob: Blob) => {
    const url = `blob:test-${blobs.size}`;
    blobs.set(url, blob);
    return url;
  };
  (URL as any).revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, blob: blobs.get(this.href)! });
  });
});

afterEach(() => vi.restoreAllMocks());

const alice = { id: "alice", name: "Alice" };

function makeEditor() {
  const store = new CommentStore();
  store.load([{ id: "t1", anchor: null, author: alice, createdAt: 1_700_000_000_000, body: "Why?", replies: [], resolved: false, orphaned: false }]);
  return new Editor({
    extensions: createRichTextPreset({ comments: { store, author: alice }, trackChanges: { enabled: false, author: alice } }),
    content:
      '<p><span data-comment-id="t1">Hello</span> <ins data-change-type="insertion" data-change-id="c1" data-author-id="alice" data-author-name="Alice" data-created-at="1700000000000">new</ins></p>',
  });
}

describe("createDocxExport / ExportDocxButton", () => {
  it("downloads the document with comments and tracked changes", async () => {
    const editor = makeEditor();
    const onExported = vi.fn();
    const target = document.createElement("div");
    document.body.appendChild(target);
    const component = mount(ExportDocxButton, { target, props: { editor, fileName: "from-button", onExported } });
    flushSync();
    const button = target.querySelector("button")!;
    expect(button.textContent?.trim()).toBe("Export to Word");
    button.click();
    await vi.waitFor(() => expect(onExported).toHaveBeenCalled());
    expect(downloads.map((d) => d.name)).toEqual(["from-button.docx"]);
    const imported = await docxToDocumentImport(await downloads[0].blob.arrayBuffer(), { trackedChanges: "marks" });
    expect(imported.comments!.threads[0]).toMatchObject({ body: "Why?", author: alice });
    expect(imported.html).toContain('data-author-name="Alice"');
    unmount(component);
    target.remove();
    editor.destroy();
  });

  it("exposes reactive state from the rune", async () => {
    const editor = makeEditor();
    const docx = createDocxExport(() => editor, { title: "Report" });
    expect(docx.isExporting).toBe(false);
    const report = await docx.download();
    expect(downloads[0].name).toBe("Report.docx");
    expect(docx.lastReport).toEqual(report);
    expect(report?.written.comments).toBe(1);
    expect(await createDocxExport(() => null).download()).toBeNull();
    editor.destroy();
  });
});
