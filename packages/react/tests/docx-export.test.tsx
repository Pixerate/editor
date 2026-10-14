// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { CommentStore, docxToDocumentImport } from "@pixerate/editor";
import { useEditor, useDocxExport, ExportDocxButton, type UseDocxExportResult } from "../src";

let container: HTMLDivElement;
let root: Root;
let downloads: { name: string; blob: Blob }[];

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.elementFromPoint = () => null;
  HTMLElement.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
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

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const alice = { id: "alice", name: "Alice" };

describe("useDocxExport / ExportDocxButton", () => {
  it("downloads the document with comments and tracked changes", async () => {
    const store = new CommentStore();
    store.load([{ id: "t1", anchor: null, author: alice, createdAt: 1_700_000_000_000, body: "Why?", replies: [], resolved: false, orphaned: false }]);
    let editor: Editor | null = null;
    let docx!: UseDocxExportResult;
    const onExported = vi.fn();
    function Harness() {
      editor = useEditor({
        immediatelyRender: true,
        content:
          '<p><span data-comment-id="t1">Hello</span> <ins data-change-type="insertion" data-change-id="c1" data-author-id="alice" data-author-name="Alice" data-created-at="1700000000000">new</ins></p>',
        richTextOptions: { comments: { store, author: alice }, trackChanges: { enabled: false, author: alice } },
      });
      docx = useDocxExport(editor, { title: "Report" });
      return <ExportDocxButton editor={editor} fileName="from-button" onExported={onExported} />;
    }
    await act(async () => root.render(<Harness />));
    const button = container.querySelector("button")!;
    expect(button.textContent).toBe("Export to Word");

    await act(async () => {
      button.click();
      await vi.waitFor(() => expect(onExported).toHaveBeenCalled());
    });
    expect(downloads.map((d) => d.name)).toEqual(["from-button.docx"]);
    expect(downloads[0].blob.type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const imported = await docxToDocumentImport(await downloads[0].blob.arrayBuffer(), { trackedChanges: "marks" });
    expect(imported.comments!.threads[0]).toMatchObject({ body: "Why?", author: alice });
    expect(imported.html).toContain('data-author-name="Alice"');

    await act(async () => {
      await docx.download();
    });
    expect(downloads[1].name).toBe("Report.docx");
    expect(docx.isExporting).toBe(false);
    expect(docx.lastReport?.written.comments).toBe(1);
    expect(editor).not.toBeNull();
  });
});
