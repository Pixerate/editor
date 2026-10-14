---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Word-style Find and Replace for the rich-text editor.

- New `FindReplace` extension (opt-in `createRichTextPreset({ findReplace: true })`): commands `setSearch`, `openFindReplace`, `closeFindReplace`, `findNext`, `findPrevious`, `replaceCurrent`, `replaceAll` (one undo step) and `clearSearch`; Mod+F / Mod+H open the find state, F3 / Mod+G step. Matches are decorated with `pixerate-find-match` and `pixerate-find-match-current`. `getFindReplaceState(editor)`, `getFindReplaceStore(editor)` (cached snapshots), `formatFindStatus`, `FIND_OPTION_TOGGLES`.
- Options: match case, whole words, match prefix / suffix, ignore punctuation / white space, Word `^` special characters (`^p`, `^t`, `^l`, `^?`, `^#`, `^$`, `^w`, `^13`, `^u8212`, … and `^&` / `^c` in the replacement), Word wildcards (`?`, `*`, `[a-z]`, `[!x]`, `{n,m}`, `@`, `<`, `>`, groups with `\1`–`\9` in the replacement), a raw regex mode and a literal mode.
- Patterns compile with `compileFindPattern` and run on a linear-time Pike VM, so no Find text can backtrack catastrophically; searches are bounded by a time budget and match cap (`truncated`). Invalid patterns return a structured `{ code, message }` error instead of throwing. Regex mode uses `RegExp` and rejects nested repetition.
- Searching skips tracked-deleted text (matches never span a deletion; word boundaries see the live text), reads paragraphs together only when the pattern contains `^p`, and replacements made while Track Changes is on become tracked changes. A paragraph mark in the replacement splits the paragraph. `searchDocument(doc, query, options)` and `applyReplacements(tr, matches)` are exported for custom flows.
- `createFindReplaceCommands(editor)` returns command-registry specs (`findReplace.open`, `.openReplace`, `.find`, `.next`, `.previous`, `.replaceAll`) for menus, the palette and agents.
- React: `FindReplaceBar` and `useFindReplace(editor)`.
- Svelte: `FindReplaceBar` and the `createFindReplace(editor)` rune.
