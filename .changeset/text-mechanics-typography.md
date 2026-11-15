---
"@pixerate/editor": minor
"@pixerate/conformance": minor
"@pixerate/swift": minor
---

Text mechanics (#892): typography, Markdown still being typed, and a fuller chat profile, moved from Swash's open pull requests into the editor.

- New checks, off unless the host turns them on (`TEXT_MECHANICS_OFF_BY_DEFAULT`): `curly-quotes` (straight quotes and apostrophes become curly in prose, including in the apostrophes other fixes write), `dashes` (`--` and `---` between words become en and em dashes, never a `--flag`), and `ellipses` (`...` → `…`).
- Markdown still being typed is left alone: a table row before its delimiter row, a link reference definition, a link or image address not yet closed, and front matter not yet closed.
- The `chat` profile leaves chat shorthand (`lol`, `idk`, `tbh`…) to the writer, skips spelling corrections that only change case, never touches Slack syntax (`<@user>`, `<!here>`), and runs no typography.
- 19 new typing scenarios in `@pixerate/conformance`; the Swift port in PixerateMarkdown reproduces them all.
