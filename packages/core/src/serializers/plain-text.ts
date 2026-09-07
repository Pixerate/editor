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
  if (typeof document !== "undefined") {
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = html;
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
  return html
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
 * between block nodes.
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
