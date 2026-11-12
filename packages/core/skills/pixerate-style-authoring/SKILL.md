---
name: pixerate-style-authoring
description: The house-style workflow across Pixerate editors - writing a house style with the user (a brand, chart rules, a writing style) as a style skill, fixing one that does not apply, and choosing a look, checked before it is saved. Use when asked to set up, write, change, fix or save a house style, brand guidelines, style guide or writing style, to switch a look or theme, or when check_style_skill, save_style or choose_style are available. Load with pixerate-agent-tools, which lists the style tools.
metadata:
  kind: workflow
  reference: pixerate-agent-tools
---

# Writing and managing house styles

A house style is a skill: a folder whose `SKILL.md` holds preferences in prose and whose
profiles (brand.json, chart.json, rich-text.json, ...) hold the rules a check can test.
The host stores skills in layers (org, user, document); you draft, check and save into one of
them. Anything that can be checked belongs in a profile, not in the prose.

This skill is the method. `pixerate-agent-tools` has the style tool reference.

## Goal and quality bar

- The skill loads cleanly: `check_style_skill` returns `ok: true` and no `errors`.
- Each rule the user gave is in the profile of the domain it governs, with exact values.
- `SKILL.md` has `name` (the folder name), a `description` that says when it applies, and short
  preferences that do not repeat the profiles.
- After saving, `get_style` for each domain shows the rules, and `list_styles` shows no issues.

## Inputs to confirm

- **Name:** lowercase letters, digits and hyphens (`acme-brand`). Default: the brand or purpose.
- **Layer:** the user's own layer by default (`save_style` picks the most specific writable one);
  an org layer only when the user says so and the host offers it.
- **Domains:** which editors the style covers. Without a `domains` list it applies everywhere.

## Working method

1. **Read what exists.** `list_styles` (names, layers, issues) and `list_style_choices`. If the
   user wants an existing style changed, `get_style_file` its files.
   **Check:** you know whether you are creating or editing, and in which layer.
2. **Learn the shapes.** `get_style_schema` for `brand` and each domain: properties, the checks
   a profile can turn on and an `example`.
3. **Draft.** Brand colours by role in `brand.json` `colors` (`primary`, `secondary`,
   `accent`, `text`, `background`), fonts in `fonts`; domain rules in `<domain>.json`; turn on
   the checks that enforce them in `checks`. Prose only for taste a check cannot test.
   A variant of an existing style (a night look, a print look) gets `extends: <that skill>` in
   its frontmatter and only the fields that differ; write `"version"` in a profile when
   `get_style_schema` gives one.
   **Check:** `check_style_skill` with all the files: `ok: true`; read its `profiles` to confirm
   each domain gets what the user asked (charts take the brand palette by default).
4. **Save.** `save_style` with the files (merge by default; `replace: true` to drop files).
   **Check:** `get_style` for each domain shows the values; `list_styles` lists no issues.
5. **Choose a look** when the user asks to switch one: `list_style_choices`, then
   `choose_style` with the option's name.
   **Check:** `list_style_choices` shows it as `chosen`.

## Decision table

| Situation | Approach |
| --- | --- |
| A new brand | `brand.json` with roles and fonts; domains derive palettes and themes from it |
| A rule for one editor only | That domain's profile, and `domains` in the frontmatter |
| A style that "does not apply" | `list_styles` issues: fix the file named there, then `save_style` (merge) |
| One of several looks | `choose_style`; never edit the other looks to switch |
| A variant of an existing look | A new skill with `extends: <look>`, the same `group`, and only what differs; then `choose_style` |
| `list_styles` shows `migrations` | The profile is in an older format: with the user's agreement, `save_style` the upgraded `profile` it gives |
| The org layer is locked | Save under a new name in the user layer; say the org rule wins |
| No writable layer (`save_style` missing) | Hand the checked files to the user |

## Recipes

**A brand style.** `get_style_schema` `brand` → `check_style_skill` `{ name, files: { SKILL.md,
brand.json, chart.json: { checks: ["palette-only"] } } }` → `save_style` → `get_style` `chart`.

**A variant.** `get_style_file` the base's profile → `check_style_skill` `{ name: "night", files:
{ SKILL.md (with `group: look` and `extends: paper`), chart.json: { palette: [...] } } }` (its
`profiles` show the merged result) → `save_style` → `choose_style` `night`.

**Fix a broken profile.** `list_styles` → read the issue (`chart.json is left out: /palette:
...`) → `save_style` with only the corrected file → `list_styles` shows none.

## Pitfalls

- **Unquoted `#` in frontmatter.** `color: #0b5fff` is a comment; quote colours or use JSON files.
- **Folder and `name` differ.** The folder name is the id; keep `name` the same.
- **Rules only in prose.** "Use the brand blue" cannot be checked; put it in a profile.
- **Copying a base instead of extending it.** A copy drifts when the base changes; `extends`
  follows it. Keep a variant's profile to the fields that differ.
- **Extending a skill that is not installed.** The variant's profiles are left out until its
  base exists; `check_style_skill` reports it.
- **Saving without checking.** `save_style` refuses what would not load; draft with
  `check_style_skill` so the user sees one clean save.

## Tools used

- `list_styles`, `get_style`, `get_style_file`: read what exists and what applies
- `get_style_schema`: what a profile can hold, its checks and an example
- `check_style_skill`: check a draft exactly as it will load
- `save_style`, `remove_style`: write or delete a skill in a writable layer (`extends` for variants)
- `list_style_choices`, `choose_style`: switch a one-of-a-kind look
