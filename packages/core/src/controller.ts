import { Editor, EditorOptions, Content, Extensions } from "@tiptap/core";
import { Slice, Fragment, Node as ProsemirrorNode } from "@tiptap/pm/model";
import { Token, tokenizePrompt } from "./grammar";
import { plainTextToTipTapHtml, getEditorText } from "./serializers";

export interface EditorControllerOptions
  extends Partial<Omit<EditorOptions, "element" | "content">> {
  element?: Element | HTMLElement | null;
  content?: string | Content;
  plainTextMode?: boolean;
  extensions?: Extensions;
  onPlainTextChange?: (text: string) => void;
  onTokensChange?: (tokens: Token[]) => void;
  onSelectionChange?: (range: { from: number; to: number } | null) => void;
}

/**
 * UI-agnostic controller managing the lifecycle, commands, and plain-text/token
 * synchronization of a rich text or prompt editor.
 */
export class EditorController {
  public readonly editor: Editor;
  private readonly plainTextMode: boolean;
  private readonly onPlainTextChange?: (text: string) => void;
  private readonly onTokensChange?: (tokens: Token[]) => void;
  private readonly onSelectionChange?: (range: { from: number; to: number } | null) => void;

  constructor(options: EditorControllerOptions = {}) {
    const {
      element,
      content,
      plainTextMode = false,
      extensions = [],
      onPlainTextChange,
      onTokensChange,
      onSelectionChange,
      ...editorOptions
    } = options;

    this.plainTextMode = plainTextMode;
    this.onPlainTextChange = onPlainTextChange;
    this.onTokensChange = onTokensChange;
    this.onSelectionChange = onSelectionChange;

    const initialContent =
      plainTextMode && typeof content === "string"
        ? plainTextToTipTapHtml(content)
        : content;

    this.editor = new Editor({
      element: element || undefined,
      content: initialContent,
      extensions,
      ...editorOptions,
      onUpdate: (props) => {
        editorOptions.onUpdate?.(props);
        this.handleUpdate();
      },
      onSelectionUpdate: (props) => {
        editorOptions.onSelectionUpdate?.(props);
        this.handleSelectionUpdate();
      },
    });

    if (plainTextMode) {
      this.enforcePlainTextClipboard();
    }
  }

  private enforcePlainTextClipboard() {
    this.editor.setOptions({
      editorProps: {
        ...this.editor.options.editorProps,
        clipboardTextParser: (text: string, context: any, _plain: boolean, view?: any) => {
          const schema =
            context?.doc?.type?.schema ||
            context?.schema ||
            view?.state?.schema ||
            this.editor.schema;

          if (!schema) return Slice.empty;

          const blocks = text.replace(/\r\n?/g, "\n").split("\n");
          const nodes: ProsemirrorNode[] = [];

          blocks.forEach((line) => {
            const nodeJson: any = { type: "paragraph" };
            if (line.length > 0) {
              nodeJson.content = [{ type: "text", text: line }];
            }
            try {
              const node = ProsemirrorNode.fromJSON(schema, nodeJson);
              nodes.push(node);
            } catch {
              // Ignore invalid node
            }
          });

          return Slice.maxOpen(Fragment.fromArray(nodes));
        },
      },
    });
  }

  private handleUpdate() {
    if (this.plainTextMode || this.onPlainTextChange || this.onTokensChange) {
      const text = this.getPlainText();
      this.onPlainTextChange?.(text);

      if (this.onTokensChange) {
        const tokens = tokenizePrompt(text);
        this.onTokensChange(tokens);
      }
    }
  }

  private handleSelectionUpdate() {
    if (this.onSelectionChange) {
      const { from, to } = this.editor.state.selection;
      this.onSelectionChange({ from, to });
    }
  }

  public getPlainText(): string {
    return getEditorText(this.editor);
  }

  public setPlainText(text: string, emitUpdate = true) {
    const html = plainTextToTipTapHtml(text);
    this.editor.commands.setContent(html, emitUpdate);
  }

  public insertText(text: string) {
    this.editor.commands.insertContent(text);
  }

  public insertTextAt(pos: number, text: string) {
    this.editor.chain().focus().insertContentAt(pos, text).run();
  }

  public replaceRange(from: number, to: number, text: string) {
    this.editor.chain().focus().deleteRange({ from, to }).insertContentAt(from, text).run();
  }

  public destroy() {
    this.editor.destroy();
  }
}

/**
 * Creates and initializes an EditorController instance.
 */
export function createEditor(options: EditorControllerOptions = {}): EditorController {
  return new EditorController(options);
}
