import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  plainTextToTipTapHtml,
  htmlToPlainText,
} from "../src/serializers";

describe("Serializers: Plain Text & TipTap HTML", () => {
  it("escapes special HTML characters", () => {
    expect(escapeHtml(`<b>"test" & 'it'</b>`)).toBe(
      "&lt;b&gt;&quot;test&quot; &amp; &#039;it&#039;&lt;/b&gt;",
    );
  });

  it("converts plain text with newlines to TipTap paragraphs", () => {
    const text = "First line\nSecond line\n\nThird line";
    const html = plainTextToTipTapHtml(text);
    expect(html).toBe(
      "<p>First line</p><p>Second line</p><p></p><p>Third line</p>",
    );
  });

  it("leaves existing paragraph HTML untouched", () => {
    const existingHtml = "<p>Already HTML</p>";
    expect(plainTextToTipTapHtml(existingHtml)).toBe(existingHtml);
  });

  it("converts HTML paragraphs back to plain text with newlines", () => {
    const html = "<p>Line 1</p><p>Line 2</p>";
    const text = htmlToPlainText(html);
    expect(text).toBe("Line 1\nLine 2");
  });
});
