---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Tracked moves and paragraph styles.

- **Tracked moves** (`TrackChanges`): with tracking on, a cut followed by a paste of the same text, or a drag within the document, of at least a sentence (`isMoveSized`; configurable with the `isMove` and `trackMoves` options) is recorded as one move. Both ends are `insertion`/`deletion` marks sharing a `moveId` (`data-move-id`) and styled with a green double strike/underline (`moveHTMLAttributes`). `getTrackedChanges` lists a move once (`type: "move"` with `move.from`/`move.to`); new `acceptMove(id)`/`rejectMove(id)` commands (and `acceptChange`/`rejectChange`/accept-all) remove the source or the destination, taking an emptied top-level paragraph with it. New `selectChange(id)` command and `trackedChangeLabel` helper. `getEditorText` resolves moved paragraphs without leaving empty lines. Block changes of a paragraph style read "Changed style to …".
- **`compareDocuments({ detectMoves: true })`** records a uniquely identical top-level paragraph deleted in one place and inserted elsewhere as a move; the summary has a new `moves` count.
- **Paragraph styles**: `createStyleRegistry` / `StyleRegistry` with built-in Normal, Title, Subtitle, Heading 1–6, Quote, Code and List Paragraph styles (plus linked and Emphasis/Strong character styles), `basedOn` chains (cycle-safe), `next` styles, document defaults, cascade resolution, user styles, JSON round-trip and a scoped stylesheet (`toCSS`). The `ParagraphStyles` extension (`paragraphStyles` preset option) adds a `styleId` attribute (`data-style`) to paragraphs, headings and code blocks, a `characterStyle` mark, `setParagraphStyle`, `clearParagraphStyle`, `setCharacterStyle`, `unsetCharacterStyle`, `updateParagraphStyleFromSelection` and `createParagraphStyleFromSelection` commands, next-style on Enter and CSS injection. Headings without a `styleId` map to Heading N, so existing documents are unchanged.
- **React**: `StylesGallery` (dropdown or gallery, update/new style from selection) and `useParagraphStyles`; `TrackedChangesList`; `useTrackChanges` gains `select`, `acceptMove` and `rejectMove`.
- **Svelte**: `StylesGallery` and `createParagraphStyles`; `TrackedChangesList`; `createTrackChanges` gains `select`, `acceptMove` and `rejectMove`.
