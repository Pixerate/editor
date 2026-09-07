// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  Mention,
  createMentionExtension,
  createRichTextPreset,
} from "../src/extensions";
import {
  htmlToPlainText,
  getEditorText,
  extractMentionsFromDoc,
} from "../src/serializers";

describe("Mention Extension & Serializers", () => {
  it("serializes mention HTML nodes to @label in plain text", () => {
    const html = `<p>Hello <span data-type="mention" data-id="ag-1" data-label="violet">@violet</span>, please review <span data-type="mention" data-id="usr-2" data-label="alex">@alex</span>'s task.</p>`;
    const plain = htmlToPlainText(html);
    expect(plain).toBe("Hello @violet, please review @alex's task.");
  });

  it("extracts mentions from HTML string", () => {
    const html = `<p>Ping <span data-type="mention" data-id="ag-violet" data-label="violet" data-type-name="agent" data-color="#7c3aed">@violet</span></p>`;
    const mentions = extractMentionsFromDoc(html);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatchObject({
      id: "ag-violet",
      label: "violet",
      type: "agent",
      color: "#7c3aed",
    });
  });

  it("extracts mentions from a TipTap document and serializes properly", () => {
    const editor = new Editor({
      extensions: [
        StarterKit,
        createMentionExtension(),
      ],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Assigning to " },
              {
                type: "mention",
                attrs: {
                  id: "agent-1",
                  label: "coordinator",
                  type: "agent",
                  color: "#3b82f6",
                },
              },
            ],
          },
        ],
      },
    });

    const mentions = extractMentionsFromDoc(editor);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatchObject({
      id: "agent-1",
      label: "coordinator",
      type: "agent",
      color: "#3b82f6",
    });

    const plain = getEditorText(editor);
    expect(plain).toBe("Assigning to @coordinator");

    editor.destroy();
  });

  it("extracts mentions from JSONContent tree", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "mention",
              attrs: { id: "u-1", label: "jack", type: "user" },
            },
          ],
        },
      ],
    };

    const mentions = extractMentionsFromDoc(json);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].label).toBe("jack");
  });

  it("creates rich text preset with mention support enabled", () => {
    const extensions = createRichTextPreset({
      mention: true,
    });
    const editor = new Editor({
      extensions,
      content: "<p>Testing preset</p>",
    });

    expect(editor.schema.nodes.mention).toBeDefined();
    expect(editor.schema.nodes.taskItem).toBeDefined();
    expect(editor.schema.nodes.taskList).toBeDefined();

    editor.destroy();
  });
});
