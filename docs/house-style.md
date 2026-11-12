# House style

House-style skills tell agents what good looks like in your product: your brand, your chart
conventions, your token rules. **You write and store the skills; `@pixerate/editor` reads
them**, merges them across layers, gives them to agents (`get_style`) and checks work against
them (`check_<domain>_style`).

This guide is for people who write skills and for hosts that store them.

## A skill

A skill is a folder named by its id (lowercase letters, digits and hyphens, at most 64):

```text
acme/
  SKILL.md            preferences, in prose (required)
  brand.json          the brand every editor shares (optional)
  chart.json          one profile per editor domain (optional)
  references/tone.md  longer guidance, read on demand
```

```markdown
---
name: acme
description: Acme's house style. Use when making charts or anything visual.
domains: [chart, tokens]   # optional; without it the skill applies everywhere
---

Lead with the finding in titles. Read references/tone.md before writing labels.
```

The body is given to the agent as a preference: it never outranks the user or a tool error,
and it cannot grant tools. Keep anything that can be checked in a profile instead.

## `brand.json`

Every domain reads the brand. Each domain derives its own starting style from it (charts take
the palette and a theme), and a domain profile refines that field by field.

```json
{
  "$schema": "./brand.schema.json",
  "name": "Acme",
  "colors": { "primary": "#0b5fff", "secondary": "#ff6a00", "text": "#1a1a1a", "background": "#ffffff" },
  "palette": ["#0b5fff", "#ff6a00", "#12a150"],
  "fonts": { "heading": "Inter", "body": "Inter" },
  "logo": { "svg": "<svg …>…</svg>", "aspect": 3.2 },
  "checks": ["palette-only", "min-contrast", "fonts-allowed"]
}
```

- **Roles are looked up by several names**, so an Office theme works as is: `primary` is also
  `brand`, `accent1` or `accent`; `text` is also `foreground` or `dk1`; `background` is also
  `lt1`. `get_style_schema` with domain `"brand"` lists every role and its names.
- **`palette`** is optional: without it, the palette is primary, secondary, accent, then
  `accent1`…`accent6`.
- **`checks`** run in every domain that can be checked against the brand: `palette-only`
  (with `tolerance` and `allowNeutrals`), `min-contrast` (`ratio`, `largeRatio`),
  `distinguishable` (`minDistance`) and `fonts-allowed` (`fonts`).
- Any value can be a design token: `{ "$token": "brand/primary", "mode": "Dark" }`.
- `$schema` is ignored when the profile loads; it is there for your editor.

### Frontmatter

Frontmatter is read by a strict YAML subset: `key: value` maps, `- item` lists, one-line
`[a, b]` and `{ a: 1 }`, quoted strings, `|` and `>` block text, comments, numbers and
booleans. Anchors, aliases, tags, `?` keys, several documents and duplicate keys are refused
with the line, and the skill still loads with what can be read. Quote colours: in
`color: #0b5fff` the `#` starts a comment.

A store that keeps only `SKILL.md` (a database row, a platform's skill) can put a profile under
its domain's key instead of a file; a file of the same name wins:

```markdown
---
name: acme
description: Acme's charts.
chart:
  palette: ["#0b5fff", "#ff6a00"]
  checks: [palette-only]
---
```

## Domain profiles

`<domain>.json` holds the structured rules for one editor: `chart.json`, `tokens.json`, and
more as each editor gains a style domain. `get_style_schema` (or `pixerate-style schema
<domain>`) describes each one, with its checks and a valid example.

## Limits and safety

A skill is text an agent may read, so the resolver keeps it small and plain: files up to
256 KB, 200 files, folders up to four deep, text types only (md, json, yaml, csv, svg, ...), no
hidden files, no `..` or absolute paths. Files outside the limits are left out with an issue
(`createStyleResolver({ limits })` changes them; `checkStyleSkill` also checks the 4 MB skill
total). Skill text reaches models inside `<style_skill>` blocks that name the layer, and text
that tries to close a block is escaped. For a system prompt, `renderStyleCatalog(await
styles.list())` lists the skills in a few lines and agents read the detail with `get_style`.

## Layers

A host stacks stores from general to specific, for example `org`, `workspace`, `user`,
`document`. A later layer's skill with the same id replaces an earlier one, profiles merge
field by field (a user layer can change one brand colour), and `sources` says which layer set
each field. A `locked` layer keeps what it sets; a `required` layer's skills cannot be
switched off.

## One of a kind, and scope

Some styles apply one at a time: a look, a theme. Put them in a group (`group: look` in the
frontmatter, or `group` in the host's state). Of the switched-on skills in a group, only the
first applies. `resolver.choose(name)` switches one on and its rivals off in one write to the
most specific writable layer (a store with `setState`); `resolver.chosen(group)` and
`resolver.choices()` read it back, and agents use `list_style_choices` / `choose_style`. React
and Svelte pickers use `useStyleChoices`.

A host can scope a skill to where it applies (`scope: ["report"]` in its state). Scoped skills
apply only when the resolver is asked for that scope (`resolve(domain, { scope })`, or the
`scope` option of the tool providers); unscoped skills apply everywhere. Each scope keeps its own
choice.

## Writing and checking a skill

```bash
npx pixerate-style init skills/acme --profiles brand,chart   # start from example profiles
npx pixerate-style check skills/acme                          # what a host would offer, leave out and why
npx pixerate-style preview skills/acme                        # live page on 127.0.0.1: swatches, fonts, logo, a sample chart
npx pixerate-style schema chart --out skills/chart.schema.json
```

`check` exits 1 when anything would be left out, so it works in CI. Pass `--tokens
tokens.json` (a flat `{ "brand/primary": "#0b5fff" }` map, or nested groups with `$value`) to
resolve `$token` references. The command knows the domains this package ships; a host with its
own domains calls the same functions from `@pixerate/editor/tools`:

| Function | Does |
| --- | --- |
| `checkStyleSkill(name, files, { domains, tokens })` | Reads a draft as a resolver would: ok, errors, warnings, the profile each domain gets, the brand |
| `styleProfileSchema(domain)` | A domain's standalone JSON Schema, with its checks |
| `scaffoldStyleSkill({ name, profiles, domains })` | A new skill's files from the domains' examples |
| `renderStylePreview(report, domains)` | The preview page as HTML |

Agents get the same check as the `check_style_skill` tool, so a model can help a user write a
style and hand over files that load.

## Storing skills (hosts)

Implement `StyleStore` over your storage (`list`, `read`, `files`, optional `subscribe`, and
`setState` if people or agents may choose styles) and
test it with the kit:

```ts
import { styleStoreConformance } from '@pixerate/editor/tools';

for (const c of styleStoreConformance((seed) => myStore(seed))) it(c.name, c.run);
```

`STYLE_FIXTURE_SKILLS` holds the skills the cases seed: a brand with a reference file, a
preferences-only skill and a broken one.

## Adding a style domain (contributors)

A `StyleDomain` names its profile file (`<id>.json`), its `profileSchema` and checks, and
optionally `themeFromBrand` (its profile from the brand), `surface` (the colours and fonts its
state uses, so the shared checks run there), an `example` and a `preview`. Map it in
`packages/core/tests/style-coverage.test.ts`; that test fails for any editor domain without one.
