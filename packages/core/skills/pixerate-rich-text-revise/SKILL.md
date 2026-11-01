---
name: pixerate-rich-text-revise
description: The revision workflow in the Pixerate rich text editor - proofreading for spelling and grammar, renaming a term consistently while leaving quotations and names alone, tightening wordy passages, unifying how numbers, dates and terms are written, and making minimal, targeted edits that keep the author's formatting and voice, with a check that nothing else changed. Use when asked to proofread, copy-edit, revise, tighten, shorten, fix typos, rename or replace a term throughout, make wording consistent or polish a document, or when find_text, replace_text and replace_range are available. Load with pixerate-rich-text, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-rich-text
---

# Revising a document

Revision changes as little as possible to make the document right: each fix is a targeted
replacement of the words that are wrong, so formatting, links and the author's voice survive.
Find before replacing, decide which matches should change (a quotation, a name or a published
title often should not), and check afterwards that only what you meant changed.

This skill is the method. `pixerate-rich-text` has the full tool reference.

## Goal and quality bar

- Every error the user asked about is fixed (`find_text` for it returns no matches).
- Only the intended text changed: the rest of the document reads exactly as before.
- Replacements respect case (`Teh` becomes `The`), whole words (`teh` but not `tehran`) and
  exceptions (quotations, names, titles of published works).
- Tightened passages keep their point and the author's voice; nothing is added that was not
  there.
- Formatting (bold, links, headings, lists) is untouched by text fixes.

## Inputs to confirm

- **Scope:** spelling only, grammar and style, or a rewrite of named passages.
- **Exceptions:** text that must stay as written (quotes, legal text, product names, titles).
- **House style:** spelling variant (UK or US), how numbers and dates are written.

## Working method

1. **Read.** `get_text` (with `blocks: true` for positions).
   **Check:** you have a list of fixes with the exact wrong text and the right text.
2. **Find before replacing.** `find_text` for each term (`wholeWord`, `matchCase`, or `regex`
   for families of errors); read the matches in context and decide which change.
   **Check:** the match count is what you expect; note the occurrences to leave alone.
3. **Replace in one call per fix.** `replace_text` with `find`, `replace`, `wholeWord: true`;
   `matchCase: true` with one call per capitalisation (`teh` and `Teh`); `occurrence` for only
   some matches, working from the last occurrence to the first so the numbering holds.
   **Check:** `find_text` for the wrong text returns no matches (except the exceptions).
4. **Rewrite a passage** with `replace_range` over exactly its range (`from` / `to` of the block
   or a `find_text` match), keeping the surrounding text.
   **Check:** `get_text` `blocks`: the other blocks' text is unchanged.
5. **Consistency.** Terms, numbers and dates one way: `find_text` with a `regex` for the
   variants, then `replace_text`.
6. **Report** the fixes made, the matches you left and why.

## Decision table

| Fix | Tool and settings |
| --- | --- |
| A misspelling everywhere | `replace_text`, `wholeWord: true`, one call per capitalisation with `matchCase` |
| Rename a term, with exceptions | `find_text`, then `replace_text` with `occurrence` per change, last first |
| A family of variants (e-mail, email, E-mail) | `find_text` / `replace_text` with `regex: true` |
| Rewrite a sentence or paragraph | `replace_range` over its exact range |
| Insert a missing word | `insert_text` at the position from `find_text` |
| Formatting only | `format_text` on the range; leave the words |

## Recipes

**Typos.** `replace_text` `{ find: "recieve", replace: "receive", wholeWord: true }`; for a word
that starts sentences, `{ find: "Teh", replace: "The", matchCase: true, wholeWord: true }` and
the same in lower case.

**Rename except a quotation.** `find_text` "Acme Cloud" lists three matches; the second is in a
quoted title: `replace_text` with `occurrence: 3`, then `occurrence: 1`.

**Tighten the intro.** `get_text` `blocks` → `replace_range` `{ from: blocks[0].from, to:
blocks[0].to, text }` with one sentence.

## Pitfalls

- **Case-insensitive replace** turns `Teh` into `the` at the start of a sentence; match case.
- **Partial words**: without `wholeWord`, fixing `teh` breaks words containing it.
- **Changing quotations, names or published titles** that must stay as written.
- **`occurrence` after an earlier change** counts the remaining matches; replace from the last
  to the first.
- **Rewriting whole paragraphs** to fix one word loses formatting and links; replace only the
  words.
- **Adding content** while tightening; keep the author's point and facts.

## Tools used

- `get_text`, `find_text`: read the text, blocks, positions and matches
- `replace_text`: targeted replacements, with case, whole-word, regex and occurrence
- `replace_range`, `insert_text`: rewrite or insert at exact positions
- `format_text`: formatting fixes without touching words
- `undo_rich_text`: take back a step
