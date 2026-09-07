/**
 * Escapes characters that have syntactic meaning in HTML text.
 */
export function escapeHtml(text: string): string {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Converts a plain-text string with newlines into HTML paragraphs suitable
 * for TipTap initial content or setContent, preserving line breaks.
 */
export function plainTextToTipTapHtml(text: string): string {
  if (!text) return "<p></p>";
  if (/<p[\s>]/i.test(text)) {
    return text;
  }
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");
}

/**
 * Extracts plain text from an HTML string or TipTap HTML, preserving newlines between block tags.
 */
export function htmlToPlainText(html: string): string {
  if (!html) return "";

  // Normalize mentions so data-label is preserved as @label even if textContent is empty
  const mentionNormalized = html
    .replace(
      /<span[^>]*data-type=["']mention["'][^>]*data-label=["']([^"']+)["'][^>]*>.*?<\/span>/gi,
      "@$1",
    )
    .replace(
      /<span[^>]*data-type=["']mention["'][^>]*data-id=["']([^"']+)["'][^>]*>.*?<\/span>/gi,
      "@$1",
    );

  if (typeof document !== "undefined") {
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = mentionNormalized;
    tempDiv
      .querySelectorAll("br.ProseMirror-trailingBreak")
      .forEach((br) => br.remove());
    tempDiv.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    const paragraphs = tempDiv.querySelectorAll("p, div, li, h1, h2, h3, h4, h5, h6");
    if (paragraphs.length > 0) {
      const textParts: string[] = [];
      paragraphs.forEach((p) => {
        textParts.push(p.textContent || "");
      });
      return textParts.join("\n");
    }
    return tempDiv.textContent || "";
  }

  // Node.js fallback regex
  return mentionNormalized
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .trim();
}

/**
 * Extracts plain text from a TipTap editor instance, preserving newline separators
 * between block nodes and converting mention nodes to @label.
 */
export function getEditorText(editor: any): string {
  if (!editor) return "";
  const html = typeof editor.getHTML === "function" ? editor.getHTML() : "";
  if (html) {
    return htmlToPlainText(html);
  }
  if (typeof editor.getText === "function") {
    try {
      return editor.getText({ blockSeparator: "\n" });
    } catch {
      return editor.getText();
    }
  }
  return "";
}

export interface ExtractedMention {
  id: string;
  label: string;
  type?: string;
  avatarUrl?: string;
  color?: string;
  [key: string]: any;
}

/**
 * Traverses an editor instance, ProseMirror document, JSONContent, or HTML string
 * and extracts all mention attributes without needing regex.
 */
export function extractMentionsFromDoc(docOrEditor: any): ExtractedMention[] {
  if (!docOrEditor) return [];
  const mentions: ExtractedMention[] = [];

  // TipTap editor or ProseMirror Node with .descendants()
  const doc =
    docOrEditor?.state?.doc ||
    (typeof docOrEditor?.descendants === "function" ? docOrEditor : null);

  if (doc && typeof doc.descendants === "function") {
    doc.descendants((node: any) => {
      if (node.type?.name === "mention" && node.attrs) {
        mentions.push({
          id: node.attrs.id || "",
          label: node.attrs.label || "",
          type: node.attrs.type,
          avatarUrl: node.attrs.avatarUrl,
          color: node.attrs.color,
          ...node.attrs,
        });
      }
    });
    return mentions;
  }

  // JSONContent tree
  if (typeof docOrEditor === "object" && docOrEditor.content) {
    const walk = (nodes: any[]) => {
      for (const node of nodes) {
        if (node.type === "mention" && node.attrs) {
          mentions.push({
            id: node.attrs.id || "",
            label: node.attrs.label || "",
            type: node.attrs.type,
            avatarUrl: node.attrs.avatarUrl,
            color: node.attrs.color,
            ...node.attrs,
          });
        }
        if (Array.isArray(node.content)) {
          walk(node.content);
        }
      }
    };
    walk(docOrEditor.content);
    return mentions;
  }

  // HTML String
  if (typeof docOrEditor === "string") {
    if (typeof document !== "undefined") {
      const div = document.createElement("div");
      div.innerHTML = docOrEditor;
      div.querySelectorAll('span[data-type="mention"]').forEach((el) => {
        mentions.push({
          id: el.getAttribute("data-id") || "",
          label: el.getAttribute("data-label") || "",
          type: el.getAttribute("data-type-name") || undefined,
          avatarUrl: el.getAttribute("data-avatar-url") || undefined,
          color: el.getAttribute("data-color") || undefined,
        });
      });
    } else {
      const spanRegex = /<span([^>]*data-type=["']mention["'][^>]*)>/gi;
      let match;
      while ((match = spanRegex.exec(docOrEditor)) !== null) {
        const attrStr = match[1];
        const getAttr = (name: string) => {
          const m = new RegExp(`${name}=["']([^"']*)["']`, "i").exec(attrStr);
          return m ? m[1] : undefined;
        };
        mentions.push({
          id: getAttr("data-id") || "",
          label: getAttr("data-label") || "",
          type: getAttr("data-type-name") || getAttr("data-entity-type"),
          avatarUrl: getAttr("data-avatar-url"),
          color: getAttr("data-color"),
        });
      }
    }
  }

  return mentions;
}
