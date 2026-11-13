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
  `distinguishable` (`minDistance`) and `fonts-allowed` (`fonts`). A `min-contrast` finding
  carries `suggestion: { color, ratio }` when the brand's text or background colour (else
  near-black or white) reads on that background; `ink` and `contrast` in
  `@pixerate/editor/color` make the same choice for your own code.
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

### `rich-text.json` (documents)

```json
{
  "headingCase": "sentence",
  "properNouns": ["Acme", "GitHub"],
  "maxHeadingLevel": 3,
  "listItemEnd": "none",
  "quotes": "curly",
  "terms": [{ "avoid": "utilize", "use": "use" }],
  "thousandsSeparator": ",",
  "dateFormat": "day-month-year",
  "checks": ["heading-case", "heading-levels", "list-punctuation", "quotes", "terms", "number-format", "date-format"]
}
```

`check_rich_text_style` reports each finding with a `{ from, to }` range and, when the fix is
certain, its `replacement`; `fix_rich_text_style` applies those as one undo step. Text colours
and fonts set in the document are checked against the brand (`palette-only`, `fonts-allowed`).
React and Svelte: `useRichTextStyleFindings(styles, editor)`.

## Saving, removing and a document layer

A store that implements `save` and `remove` can take new and changed skills.
`saveStyleSkill(styles, name, files, { layer, replace })` checks the result exactly as the
resolver will load it and writes nothing unless it loads cleanly; files merge over the layer's
copy unless `replace`. `removeStyleSkill` deletes a layer's copy (another layer's copy applies
again). Agents get `save_style` and `remove_style`, offered only when a layer can be written.

Put a **document layer** last, so a file keeps its own look for every reader: a
`memoryStyleStore` saved with the document (`store.toJSON()`) and restored with
`memoryStyleStore(json.files, json.state)`. A locked org layer still wins over it.

The `pixerate-style-authoring` skill is the agent's method for writing, fixing and saving
styles with the user.

## Limits and safety

A skill is text an agent may read, so the resolver keeps it small and plain: files up to
256 KB, 200 files, folders up to four deep, text types only (md, json, yaml, csv, svg, ...), no
hidden files, no `..` or absolute paths. Files outside the limits are left out with an issue
(`createStyleResolver({ limits })` changes them; `checkStyleSkill` also checks the 4 MB skill
total). Skill text reaches models inside `<style_skill>` blocks that name the layer, and text
that tries to close a block is escaped. For a system prompt, `renderStyleCatalog(await
styles.list())` lists the skills in a few lines and agents read the detail with `get_style`.
When an agent will write or edit a skill for one domain, `renderStyleDomain(domain)` gives a
`<style_domain>` block: where its profile goes, `extends`, the format version, the checks it can
turn on, an example and the schema (`get_style_schema` returns the same text).

### `spreadsheet.json` and `diagram.json`

```json
{ "headerCase": "sentence", "numberFormats": { "currency": "\"$\"#,##0.00", "percentage": "0.0%" }, "freezeHeader": true,
  "checks": ["header-case", "number-formats", "freeze-header", "palette-only"] }
```

```json
{ "directions": ["LR", "TB"], "labelCase": "sentence", "maxLabelLength": 40, "maxNodes": 25,
  "shapes": ["rect", "round", "diam", "cyl"], "checks": ["direction", "label-case", "label-length", "max-nodes", "allowed-shapes"] }
```

Spreadsheet findings target cells in A1 notation (`{ cell: "B3", numberFormat }`), conditional
format rules (`{ rule }`) whose colours the brand checks, or the sheet. Diagram findings target
nodes, edges and groups by id (with the `label` to set), or the diagram (with the `direction`).
`fix_spreadsheet_style` and `fix_diagram_style` apply the certain fixes as one undo step. In
React and Svelte, `useStyleFindings(styles, "spreadsheet", document)` and `useStyleFindings(styles,
"diagram", graph)` show the findings; pass a new value after each change.

### `canvas.json` and `typography.json`

```json
{ "cornerRadii": [0, 4, 8], "strokeWidths": [1, 2], "fontSizes": [12, 14, 16, 20, 24, 32], "grid": 8,
  "checks": ["corner-radii", "stroke-widths", "font-sizes", "grid", "palette-only", "fonts-allowed"] }
```

```json
{ "weights": [400, 600], "sizes": [12, 14, 16, 20, 25, 31], "lineHeight": { "min": 1.3, "max": 1.7 },
  "checks": ["weights", "sizes", "line-height", "letter-spacing", "fonts-allowed"] }
```

Canvas findings target `{ node, property, value }` and read node styles as strings (SvelteFlow),
objects (React Flow) or shape paints; `createCanvasStyleToolProvider({ getNodes, setNodes,
history })` records `fix_canvas_style` as one undoable command. Typography checks the font
picker's selection; `fix_typography_style` snaps it to the house type in one change.

### `image-editor.json` and `paint-editor.json`

```json
{ "aspectRatios": ["1:1", "4:5", "16:9"], "minSize": { "width": 1080 },
  "adjustments": { "saturation": { "min": -20, "max": 20 } }, "checks": ["aspect-ratio", "min-size", "adjustment-ranges"] }
```

```json
{ "papers": ["cold-pressed", "hot-pressed"], "brushes": ["watercolor-round", "pencil-hb"], "maxLayers": 12,
  "checks": ["paper", "brushes", "max-layers", "palette-only"] }
```

An aspect-ratio finding carries the centred crop that reaches the nearest house ratio, for
`set_crop`; `fix_image_style` clamps the base adjustments. `fix_paint_style` switches to the house
paper and brush; strokes already painted stay as they are. The Swift paint editor reads the same
`paint-editor.json`, `brushes.json` and `brand.json` (`PaintHouseStyles` in `PixeratePaint`), with
`check_paint_style`, `fix_paint_style` and `check_brush_style` matching the TS core.

### `animation-editor.json` and `video-editor.json`

```json
{ "easings": ["ease-out", "ease-in-out"], "durations": { "min": 200, "max": 1200 }, "minHold": 600,
  "maxLength": 15000, "fps": [30, 60], "checks": ["easings", "durations", "holds", "max-length", "fps"] }
```

```json
{ "aspectRatios": ["16:9", "9:16"], "fps": [30, 25], "maxLength": 60000, "titleSizes": { "min": 48 },
  "transitions": ["crossfade", "dip"], "maxTransition": 500,
  "checks": ["aspect-ratio", "fps", "max-length", "title-sizes", "transitions", "min-contrast"] }
```

`fix_animation_style` applies the house easings, durations, holds and frame rate, and
`fix_video_style` the frame rate, title sizes and transitions, each as one undo step.

### `generation.json` and `parameters.json`

```json
{ "models": ["image-standard"], "aspectRatios": ["1:1", "16:9"], "maxCount": 4,
  "promptSuffix": "flat vector illustration, soft daylight", "negativeTerms": ["text", "watermark"],
  "bannedTerms": ["photorealistic"], "checks": ["models", "limits", "prompt-suffix", "negative-terms", "banned-terms"] }
```

```json
{ "values": { "grain": 0.2 }, "ranges": { "intensity": { "max": 0.6 } }, "checks": ["house-values", "ranges", "palette-only"] }
```

Generation is checked before anything is spent: `check_generation_style` and
`apply_generation_style` take the request (as `plan_generation` does) and the second returns it
in the house style, without generating. `fix_parameters_style` sets the house values in one step.

### `vector.json` and `effect-authoring.json`

```json
{ "strokeWidths": [1, 2, 4], "cornerRadii": [4, 8], "checks": ["stroke-widths", "corner-radii", "palette-only", "fonts-allowed"] }
```

```json
{ "languages": ["pixel"], "maxDuration": 4000, "loop": true, "presets": ["Subtle", "Strong"],
  "checks": ["languages", "timing", "presets", "palette-only"] }
```

`fix_vector_style` snaps stroke widths and live corner radii to the nearest house value in one
undo step; the brand checks run on solid fills, strokes, text and the artboard. Effect authoring
checks the effect open in a session (`createEffectAuthoringStyleToolProvider({ session })`):
`fix_effect_authoring_style` sets the house timing in one step, and the house presets and colour
controls are left to the agent. The Swift vector editor does not read house styles yet.

### `stickers.json` and `brushes.json`

```json
{ "libraries": ["acme-brand"], "commercialOnly": true, "allowAiGenerated": false, "bannedTags": ["food"],
  "checks": ["libraries", "commercial", "ai-art", "banned-tags", "palette-only"] }
```

```json
{ "media": ["paint", "dry"], "requireSourceLicence": true, "checks": ["media", "source-licences", "palette-only"] }
```

These are about which assets the house uses, so their checks only read: `check_sticker_style`
checks stickers by ref before they are placed and returns the `find_stickers` filters that keep a
search in the house style; `check_brush_style` checks the user's saved brushes, or any brushes by
id before painting with them.

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

## Variants: `extends`

A skill can build on another and give only what differs:

```markdown
---
name: night
description: The night look, built on paper.
group: look
extends: paper
---
```

Its profiles merge over the base's (objects field by field, lists and values replace), so
`night/chart.json` can be `{ "palette": ["#f5c542", "#42a5f5"] }` and keep paper's fonts and
defaults. The base is the copy in use, found through the layers like any skill: a user-layer
variant can extend an org-layer base, and overriding the base in a later layer changes every
skill built on it. A base that is switched off (because a variant was chosen over it) still
serves as a base. Only profiles inherit, `brand.json` included; the base's prose does not apply
through the variant.

Each merged profile is checked whole, so a variant's own file may be partial. `list_styles` and
`get_style` show the chain in `inherits`, nearest first, and `sources` say `<layer> (from paper)`
for inherited fields. A variant's profiles are left out, with an issue naming the skills, when
its base is missing, the chain goes round in a circle, or it is more than eight skills deep
(`MAX_STYLE_INHERITANCE_DEPTH`). `checkStyleSkill(name, files, { bases: resolver })` and
`save_style` check a draft over the installed base; `pixerate-style check` reads it from a sibling
folder. `remove_style` reports the skills left without a base in `extendedBy`.

## In the editors

- **Pickers offer the house colours.** `styleSwatches(style)` lists the profile palette, the
  brand palette and its role colours, and the fonts. React and Svelte have
  `useStyleSwatches(styles, domain)`; pass `colors` to `ColorPicker`'s `swatches` or
  `ChartEditor`'s `swatches`. `get_style` returns the same list, so agents and people pick from
  one set.
- **New work starts in the house style.** `styleDefaults(domain, style)` is a domain's starting
  patch (`StyleDomain.defaults`; charts: palette and defaults, `chartStylePatch`). Agents call
  `apply_chart_style`.
- **Instructions for the agent.** Add `STYLE_AGENT_INSTRUCTIONS` to the system prompt while a
  house style is active, then your own conventions after it. It is domain-neutral on purpose.

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

### In the browser

`storageStyleStore()` keeps a store in `localStorage` (or any `storage` with `getItem`,
`setItem` and `removeItem`, such as `sessionStorage`) as one JSON value under one key
(`pixerate-styles` by default; give each store its own `key`). It can take, save, switch and
remove skills, so `save_style` and `choose_style` work over it.

```ts
import { createStyleResolver, storageStyleStore } from '@pixerate/editor/tools';

const user = storageStyleStore({ key: 'acme-user-styles', initial: starterSkills });
const styles = createStyleResolver({ layers: [{ id: 'org', store: orgStore, locked: true }, { id: 'user', store: user }], domains });
```

- **Every read checks the value again.** Any script on the page can change browser storage, so
  names, paths, file types and sizes are checked on each read. What fails is left out, and
  `problems()` says what and why.
- **Unreadable data is never overwritten.** A value that is not JSON or not this store's
  format throws, naming the key, on reads and writes alike, so a later save cannot wipe the
  user's skills. Remove the key to start again.
- **Quota.** A site gets about 5 MB. A write past it throws "Browser storage refused the
  write", which `save_style` reports.
- **Tabs.** Reads go to storage on every call, so each tab sees the others' writes. Subscribers
  hear about writes through the store and, where there is a window, other tabs' changes to the
  key (the `storage` event; `watchOtherTabs: false` turns that off).
- **`initial`** gives the skills a new user starts with; nothing is written until the first
  change.
- **No storage** (a server or worker, or storage blocked) throws on first use; pass `storage`.

## Adding a style domain (contributors)

A `StyleDomain` names its profile file (`<id>.json`), its `profileSchema` and checks, and
optionally `themeFromBrand` (its profile from the brand), `surface` (the colours and fonts its
state uses, so the shared checks run there), an `example` and a `preview`. Map it in
`packages/core/tests/style-coverage.test.ts`; that test fails for any editor domain without one.

### Changing a profile's shape: versions

Hosts keep the profiles people wrote. When a domain renames or restructures a field, give it a
`profileVersion` (a whole number, starting at 2 for the first change) and a `migrateProfile`
that upgrades a profile one step:

```ts
profileVersion: 2,
migrateProfile(profile, from, { partial }) {
	if (from === 1) {
		const { colors, ...rest } = profile;
		return { ...rest, ...(colors ? { palette: colors } : {}) };
	}
	throw new Error(`no upgrade from version ${from}`);
}
```

A profile records its version in a top-level `"version"` (missing means 1). The resolver
upgrades each copy step by step when it reads it, before `$token` references resolve and bases
merge; `partial` is true for a variant's copy, so only add defaults when it is false. Nothing is
written back: the skill's `migrations` (in `list_styles` and `checkStyleSkill`) hold each
upgraded copy for the host or agent to save. A profile newer than the domain's version, a
`"version"` that is not a whole number from 1, a missing step, or a migration that throws or
gives no object leaves that profile out with an issue naming the file. `get_style_schema`,
`styleProfileSchema` and `scaffoldStyleSkill` include the current version. A domain without
`profileVersion` treats `"version"` as an ordinary field.

Bump the version only for changes an older profile would fail or be misread under; adding an
optional field needs no new version.
