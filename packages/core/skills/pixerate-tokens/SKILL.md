---
name: pixerate-tokens
description: How to read and change Pixerate design tokens (collections of variables with a value per mode, such as Light and Dark, and aliases between variables) through the shared document tools - getting the whole token set, editing collections, modes, variables and aliases, loading it back as one undo step, undo and redo, and saving or opening named token sets. Use when token tools (get_tokens_document, load_tokens_document...) are available or the user asks to change design tokens, theme colours, spacing scales or light / dark modes.
---

# Design tokens

A token set holds **collections** (for example "Colours" or "Spacing"), each with one or more
**modes** ("Light" and "Dark", or "Mobile" and "Desktop"), and **variables** (`color`,
`number`, `string` or `boolean`) with a value for each mode of their collection. A value can be
an alias to another variable, so `button/background` can point at `brand/primary` and follow it.
Hosts turn the set into CSS variables per mode (`exportTokensCss`) and W3C design-token JSON.

There are no per-variable tools yet: read the whole set with `get_tokens_document`, change the
JSON, and write it back with `load_tokens_document`. Read `pixerate-agent-tools` first for tool
naming and errors.

## Working method

1. **Read.** `get_tokens_document`. Note collection, mode and variable ids: values are keyed by
   mode id, and aliases name variable ids.
2. **Change the copy.** Keep every id you are not deliberately removing. New ids must be unique
   strings. Give every variable a value for every mode of its collection.
3. **Write once.** `load_tokens_document` with the whole edited document. It is checked first: a
   variable in a missing collection, a value for a missing mode or a broken alias is refused and
   nothing changes. One load is one undo step.
4. **Check.** Read the result's `revision`; if it did not change, nothing was different.
5. **House style.** When the host has one, read its rules with `get_style` (`domain:
   "tokens"`) before you change the set, and run `check_tokens_style` after loading. Each
   finding names the variable, mode or collection to fix; fix them all in one more load, then
   check again.

## Best practices

- Name variables by role, not value: `text/primary`, not `grey-900`. Use `/` for groups.
- Put raw values in one primitives collection and point role variables at them with aliases,
  so a theme change touches one place.
- Keep modes for real alternatives (Light / Dark). Do not make a mode per brand colour.
- Do not alias a variable to itself or in a cycle.

## Save and open

The host may add the shared document tools (see `pixerate-agent-tools`). A tokens document is the whole `TokenState`: `{ collections: [{ id, name, modes: [{ id, name }] }], variables: [{ id, collectionId, name, type, valuesByMode }] }`. A value is a literal for its type (`"#rrggbb"` colours, numbers, strings, booleans) or an alias `{ "alias": "<variable id>" }`.

| Tool | Use |
| --- | --- |
| `check_tokens_style` | Check the token set against the house style: runs the checks its `tokens.json` profile turns on (`required-variables`, `name-pattern`, `required-modes`, `contrast-pairs`, the last in every mode). Returns `ok`, findings with a severity, a sentence saying how to fix it, a `target` (variable id or name, mode id, collection id) and the layer that asked, plus the checks that `ran` and those `skipped` with the reason. Run after each `load_tokens_document`. |
| `get_tokens_document` | Take a copy of the whole token set as `{ kind, formatVersion, revision, document }` before a risky rewrite, or to hand it on. To read the token set, use `get_tokens_document`: it is smaller and says more. Refuses very large documents. |
| `load_tokens_document` | Put back a copy from `get_tokens_document` (its `document`, or the whole result). Checked first: when anything is wrong nothing changes and the error says what. One undo step (`undo_tokens` brings the previous token set back). Use it for every change: read the document, edit the JSON, load it back. |
| `undo_tokens` | Undo the last token set edit (one tool call or one user gesture). Returns `undone` (the step's name, when it has one) and whether more can be undone. Fails with "Nothing to undo." when there is nothing. |
| `redo_tokens` | Redo the last undone token set edit. |
| `save_tokens_document` | Save the token set under a `name` in the host's storage (the same name replaces that copy). Returns the `key`. Only listed when the host has storage. Save when the user asks, not after every edit. |
| `list_saved_tokens_documents` | List saved token sets (`key`, `name`, `savedAt`), newest first. |
| `open_saved_tokens_document` | Replace the token set with a saved one by `key`. One undo step. Ask before opening over changes the user has not saved. |

## Pitfalls

- Removing a variable that others alias leaves broken aliases: point them elsewhere in the same
  load.
- `load_tokens_document` replaces everything. Do not send a partial document: missing
  collections and variables are deleted.
