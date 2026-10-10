---
"@pixerate/editor": patch
---

Sanitize raw HTML in `markdownToTipTapHtml` (also used by `EditorController.setMarkdown` and markdown-mode initial content).

- Raw HTML embedded in markdown is now restricted to an allowlist of tags and attributes. Event handlers (`onerror`, `onclick`, …), `style`, and unsafe URL schemes (`javascript:`, including entity- and whitespace-obfuscated forms) are removed. Disallowed tags such as `<script>`, `<iframe>` and `<style>` are rendered as escaped text.
- Mention spans, `data-*` attributes, file/vscode/cursor links and task-list checkboxes keep working, so markdown round-trips are unaffected.
- `preprocessMarkdownFileLinks` now escapes link hrefs and labels, so a crafted `[x](file:///a"onmouseover="…)` can no longer inject attributes.
- Pass `allowUnsafeHtml: true` to restore the previous unsanitized behavior for fully trusted input.
