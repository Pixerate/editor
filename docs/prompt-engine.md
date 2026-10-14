# Prompt Grammar & Resolution Engine

The `@pixerate/editor` prompt engine handles parsing, recursion, cycle detection, and bidirectional sourcemapping for complex prompt engineering workflows.

---

## 1. Prompt Grammar Tokens

The engine identifies three primary token classes:

| Token Type | Syntax Pattern | Purpose | Example |
| :--- | :--- | :--- | :--- |
| **Template** | `{{\s*([^}]+?)\s*}}` | Reusable prompt snippet | `{{cyberpunk_lighting}}` |
| **Variable** | `{name}`, `{name\|default}`, `{name\|default\|description}` | Dynamic input field | `{subject\|a red fox\|Describe the subject}` |
| **Conditional** | `{?name}…{/name}`, `{!name}…{/name}` | Section kept only when `name` is set / unset | `{?style}in the style of {style}{/style}` |
| **Instruction** | `__(.+?)__` | Meta-instruction for LLM | `__do not include text__` |

The canonical patterns are exported as `TEMPLATE_REGEX`, `VARIABLE_REGEX` and `INSTRUCTION_REGEX`. Variables and conditional tags share `VARIABLE_REGEX`; `parseVariableBody()` tells them apart.

### AST Tokenizer Output
Calling `tokenizePrompt("A photo of {character} in {{scene}}")` produces:

```typescript
[
  {
    type: "text",
    raw: "A photo of ",
    value: "A photo of ",
    start: 0,
    end: 11
  },
  {
    type: "variable",
    raw: "{character}",
    value: "character",
    start: 11,
    end: 22
  },
  {
    type: "text",
    raw: " in ",
    value: " in ",
    start: 22,
    end: 26
  },
  {
    type: "template",
    raw: "{{scene}}",
    value: "scene",
    start: 26,
    end: 35
  }
]
```

### Variable Defaults and Descriptions

Inspired by Word's `FILLIN` merge field, a variable can carry a default and a description (the prompt shown to whoever fills it in):

```text
{subject}                                    plain slot
{subject|a red fox}                          default "a red fox"
{subject|a red fox|Describe the main subject} default + description
{subject||Describe the main subject}         empty default + description
```

- The name, default and description are trimmed. A `|` always introduces a default, even an empty one (`{x|}` resolves to nothing when unfilled).
- Text after the second `|` is the description, so it may contain further `|` characters.
- A backslash escapes `|`, `{`, `}` and `\` inside a variable (`{shape|a \{curly\} brace}`); `escapeVariableText()` does this for you. Other backslashes are kept as written.
- Defaults are literal text: they cannot contain templates, variables or sections.

The tokenizer reports the parts on the variable token: `value` is the name, plus `defaultValue` and `description` when present.

### Conditional Sections

Similar to Word's `IF` field, a section is kept or removed depending on a variable:

```text
A fox{?style} in the style of {style}{/style}{!style}, photographed{/style}.
```

- `{?name}…{/name}` is kept when `name` has a value: not `null`/`undefined`/`false` and not blank.
- `{!name}…{/name}` is kept when it has none.
- Defaults do not count: `{?style}` tests only the supplied values.
- Sections nest and may contain templates, variables and instructions.
- A section must open and close within the same text: the prompt itself or a single template body.
- The prefix must directly follow the brace (`{ ?x}` is a variable named `?x`), and the name may not contain `|`.

Unbalanced tags never throw. A close tag pairs with the nearest open tag of the same name; any open tags it skips, and close tags with no partner, are treated as literal text and reported as diagnostics (`unclosed-section`, `unexpected-close`):

```typescript
import { tokenizePromptWithDiagnostics, getPromptDiagnostics } from "@pixerate/editor";

getPromptDiagnostics("a {?x} b");
// => [{ code: "unclosed-section", name: "x", start: 2, end: 6, message: "…" }]
```

Tags are only emitted as `conditional` tokens (with `conditional: "if" | "unless" | "end"`) when balanced.

### Comparison Conditions

Like the condition of Word's `IF` / `SKIPIF` fields, a section can compare a variable with a value. Write the comparison in the opening tag and close the section with the **bare variable name**:

```text
Total: {amount}{?amount>100} (free shipping){/amount}
{?status=paid}Thanks for paying.{/status}{!status=paid}Payment is due.{/status}
{?tier <> "gold plus"}…{/tier}    {?note=""}No note.{/note}
```

- Operators: `=`, `<>` (or `!=`), `<`, `>`, `<=`, `>=`. Spaces around the operator are ignored.
- When both sides parse as plain decimal numbers (`12`, `-3.5`, `1e3`) they compare numerically, so `7` equals `7.0`. Otherwise both compare as case-insensitive text (`Paid` = `paid`).
- The value is everything after the operator, trimmed. Quote it (`"…"`) to keep surrounding spaces, to compare with an empty value (`""`), or when it starts with `=`, `<`, `>` or `"`. It may not contain `{`, `}`, `|` or `\`.
- `{!x>3}…{/x}` keeps its body when the comparison fails.
- Only supplied values are compared (not defaults); a missing value compares as `""`.
- The token for the opening tag has `value` set to the variable (`amount`) and `comparison: { operator, operand }`. `formatConditionalTag()` and `describeConditionalTag()` render it for display; `compareConditionValues()` exposes the comparison rules.

A comparison whose value is malformed (`{?amount>}…{/amount}`, `{?amount=>5}…{/amount}`, an unterminated quote) is kept as literal text and reported once with the code `invalid-condition`.

**Why the bare close tag?** Before comparisons existed, `=`, `<` and `>` were ordinary name characters, so `{?a>1}…{/a>1}` was a valid presence check on a variable called `a>1`. It still is: a close tag that repeats the whole opening text keeps the old meaning. Only `{/a}` turns `{?a>1}` into a comparison, and that combination was previously always an unbalanced (reported) pair, so no prompt that used to resolve cleanly changes meaning.

Use `parseConditionExpression("amount>100")` / `evaluateConditionExpression()` to evaluate the same condition syntax outside a prompt (it also accepts `name` and `!name`).

### Backwards Compatibility

Without the new syntax, prompts tokenize exactly as before. The only change to `VARIABLE_REGEX` is backslash escaping, which can change the match for text that has a backslash directly before a brace. `resolveTemplates` and `resolveTemplatesWithMapping` behave exactly as before unless `values` is passed. `extractVariableNames` now returns `subject` for `{subject|default}` and includes names used by conditions (`amount` for a comparison `{?amount>100}…{/amount}`). Comparison conditions only give meaning to tag pairs that were previously reported as unbalanced; randomized tests in `grammar.test.ts` check that every prompt the old grammar accepted without diagnostics tokenizes and resolves identically.

---

## 2. Recursive Template Resolution

Templates can reference other templates arbitrarily deep. The resolver traverses the graph and replaces template references with their defined bodies.

### Cycle Detection
When circular references are encountered (e.g. `templateA` calls `templateB`, which in turn calls `templateA`), the resolver catches this using a visited set and replaces only the offending tag with `TEMPLATE_LOOP_ERROR` (`"[Template loop detected]"`). Tags nested deeper than `maxDepth` (default 10) are replaced with `TEMPLATE_DEPTH_ERROR` (`"[Template max depth exceeded]"`). The rest of the prompt still resolves, so check for errors with `result.includes(TEMPLATE_LOOP_ERROR)`:

```typescript
import { resolveTemplates } from "@pixerate/editor";

const templates = [
  { name: "loop_a", body: "calls {{loop_b}}" },
  { name: "loop_b", body: "calls {{loop_a}}" },
];

const result = resolveTemplates("Start {{loop_a}}", templates);
console.log(result);
// => "Start calls calls [Template loop detected]"
```

### Version Pinning
Templates can have multiple versions. Consumers can pass explicit version bindings:

```typescript
const templates = [
  {
    name: "lighting",
    versions: [
      { id: "v1", body: "soft morning light" },
      { id: "v2", body: "dramatic neon glow" }
    ]
  }
];

const result = resolveTemplates("Studio {{lighting}}", templates, {
  bindings: { lighting: "v2" }
});
// => "Studio dramatic neon glow"
```

### Resolving with Values

Pass `values` to fill variables and evaluate sections, in the prompt and in every template body:

```typescript
import { resolveTemplates, resolvePrompt } from "@pixerate/editor";

const templates = [{ name: "style", body: "{?artist} by {artist|Hokusai}{/artist}" }];
const prompt = "A {subject|red fox}{{style}}";

resolveTemplates(prompt, templates);
// => "A {subject|red fox}{?artist} by {artist|Hokusai}{/artist}"  (no values: as written)

resolveTemplates(prompt, templates, { values: { artist: "Monet" } });
// => "A red fox by Monet"

resolveTemplates(prompt, templates, { values: {} });
// => "A red fox"
```

- A supplied value wins. `null`/`undefined` count as unset, and an explicit `""` renders as empty.
- Otherwise the default is used. A variable with neither stays as its `{name}` placeholder.
- Substituted values are never re-parsed, so a value containing `{{x}}` stays literal.
- Templates inside a removed section are not expanded, so they cannot trigger loop or depth errors. Templates inside a kept section are still protected by cycle detection and `maxDepth`:

```typescript
const list = [{ name: "list", body: "item{?more}, {{list}}{/more}" }];
resolveTemplates("{{list}}", list, { values: {} });            // "item"
resolveTemplates("{{list}}", list, { values: { more: "y" } });  // "item, [Template loop detected]"
```

`resolvePrompt(text, templates, { bindings, maxDepth, values })` is the full entry point. It returns `{ text, map, diagnostics }`; diagnostics from template bodies carry `templateName` and offsets relative to that body. `resolveVariables(text, values)` fills values without expanding templates.

### Variable Fill-In Forms

`extractVariables(text, { templates })` lists every variable in order of first use, including those inside referenced templates. Each entry has its first default and description, and whether it is used as a slot (`usedAsValue`) or by a condition (`usedInCondition`). `getVariableFormFields()` turns that list into form field descriptors (`label` = description or name, `placeholder` = default, `required`, `conditionOnly`). `compactVariableValues()` drops blank inputs so defaults apply:

```typescript
import { getVariableFormFields, compactVariableValues, resolveTemplates } from "@pixerate/editor";

getVariableFormFields("{subject|a red fox|Describe the subject} {?hd}4k{/hd}");
// => [
//   { name: "subject", label: "Describe the subject", placeholder: "a red fox",
//     defaultValue: "a red fox", description: "Describe the subject",
//     required: false, conditionOnly: false },
//   { name: "hd", label: "hd", placeholder: "", required: false, conditionOnly: true },
// ]

const values = compactVariableValues({ subject: "", hd: "true" }); // { hd: "true" }
```

A variable used only in comparisons (`{?amount>100}`) is flagged `usedInComparison` and is not `conditionOnly`, so forms ask for its text.

React and Svelte ship a `VariableForm` component built on these helpers. It renders a text input per variable, or a checkbox for condition-only variables, and calls `onChange(values, entered)`. `TemplateRenderer` accepts the same `values` to preview the filled prompt: values and defaults are highlighted, and failing sections are hidden. For custom renderers, use `evaluatePromptTokens(text, values)`.

### Mail Merge: Data Sources and Multi-Record Merge

Like Word's mail merge, a prompt can be merged with every record of a data source.

**`parseDataSource(input, options)`** reads CSV / TSV text, JSON (an array of objects or of arrays), rows (`unknown[][]`) or objects, and returns `{ fields, records, warnings, format, delimiter? }`:

- Delimited text uses the RFC 4180 parser from the spreadsheet module (quotes, doubled quotes, CRLF/LF/CR, BOM). `delimiter: "auto"` (the default) picks whichever of `,` `;` and tab is most frequent in the first line outside quotes, preferring `,`.
- `hasHeader` (default `true`): the first row names the fields. Names are trimmed, blank names become `Column N`, and repeats (case-insensitive) are numbered `Name 2`. Without a header, fields are `Column 1…N`.
- Rows that are entirely blank are skipped; records are padded or cut to the header width (`ragged-rows` warning); records and fields are capped (`maxRecords` 100 000, `maxFields` 1 000).
- For objects the fields are the union of keys in first-seen order. Cells become strings (`null` → `""`, nested values → JSON). Field names such as `__proto__` are stored as plain data.
- It never throws: problems (`invalid-json`, `blank-header`, `duplicate-header`, `records-truncated`, …) are listed in `warnings`.

**`matchFields(variables, fields)`** maps variables to fields: an exact match, then a case-, space- and punctuation-insensitive one (`first_name` ↔ `First Name`), then aliases (`FIELD_ALIASES`: `FirstName`/`First`/`GivenName`, `LastName`/`Surname`, `PostalCode`/`ZIP`/`Postcode`, `Email`/`E-mail`, …; add groups with `{ aliases }`). `recordToValues(record, mapping)` builds the prompt values for one record; blank cells are left out so `{name|default}` falls back to its default (`blankAsMissing: false` renders them empty).

**`mergeRecords(template, source, options)`** resolves the template once per record with `resolvePrompt` and returns `{ outputs: { index, record, values, text, map }[], skipped, diagnostics, text, mapping, truncated }`:

```typescript
import { mergeRecords } from "@pixerate/editor";

const csv = "First Name,City,Budget,Status\nAda,London,1500,active\nAlan,Wilmslow,200,cancelled";
const { outputs, skipped, text } = mergeRecords(
  "Portrait of {firstName} in {city}{?budget>=1000}, 8k render{/budget}",
  csv,
  { skipIf: "status=cancelled", separator: "\n" },
);
// outputs[0].text === "Portrait of Ada in London, 8k render"; skipped[0].index === 1
```

- `mapping` overrides the automatic field matching (`null` leaves a variable unset).
- `skipIf` drops a record's output, like `SKIPIF`: a condition string in the section syntax without braces (`status=cancelled`, `!email`, `amount<10`) evaluated against the record's values, or a function `(record, values, index) => boolean`. A malformed string is reported as `invalid-skip-condition` and skips nothing.
- `separator` joins `text` (default `"\n\n"`; `"none"` joins with nothing). `from` / `to` (1-based, inclusive) choose a record range.
- `maxOutputs` (default 10 000) and `maxLength` (default 20 000 000 characters) stop the merge early with a `max-outputs` / `max-length` diagnostic and `truncated: true`. Skipped records do not count.
- Diagnostics also include the template's grammar diagnostics (once), `unmapped-variable` for value slots with no field and no default, and data source warnings (`data-source`) when `source` was not already parsed.
- `serializeMergeOutputs(outputs, "text" | "json")` formats the result for copying or download.

Record-level directives such as Word's `NEXT` are not part of the grammar: `{!next}` already means "section kept when `next` is empty", so a directive would change existing prompts. Filter records with `skipIf`, or pre-process the records instead.

React and Svelte ship `<MergePreview content defaultSource skipIf separator onMerge />`: paste or pick a CSV / TSV / JSON file, adjust the automatic field mapping, step through records ("Record 3 of 20") with the resolved prompt shown by `TemplateRenderer`, and "Merge all" to copy or download the outputs as text or JSON. The headless state is `useMergePreview(options)` in React and `createMergePreview(() => options, initialSource)` in Svelte.

---

## 3. Bidirectional Sourcemapping

When generating AI prompts, downstream models or validators often report issues at specific character offsets in the *resolved* string. To highlight the exact token in the user's *input* editor, the sourcemapper builds an index map:

```typescript
import {
  resolveTemplatesWithMapping,
  mapResolvedOffsetToRaw,
  mapRawOffsetToResolved
} from "@pixerate/editor";

const templates = [
  { name: "style", body: "hyper-realistic 8k render" }
];

const raw = "Portrait of {{style}} in studio";
const { text, map } = resolveTemplatesWithMapping(raw, templates);

console.log(text);
// "Portrait of hyper-realistic 8k render in studio"

// Downstream lint error at resolved index 15 ("hyper-realistic...")
const rawIndex = mapResolvedOffsetToRaw(15, map);
console.log(rawIndex);
// => 12 (points to the start of "{{style}}" in the raw prompt)
```

With `values` (the fourth argument: `resolveTemplatesWithMapping(raw, templates, bindings, { values })`, or `resolvePrompt`), the map gains two more segment kinds:

| `source` | Covers | Resolved length |
| :--- | :--- | :--- |
| `raw` | Text copied verbatim (offsets map 1:1) | same as raw |
| `template` | A `{{template}}` tag and its expansion | body length |
| `variable` | A `{variable}` tag and its value or default (`variableName`, `valueSource: "value" \| "default"`) | value length |
| `conditional` | A kept section's tag, or a whole removed section (`variableName`) | 0 |

Segments tile both texts without gaps. Offsets inside a non-raw segment map to the start of its raw range, and offsets inside a removed tag or section collapse to where it was in the resolved text:

```typescript
const { text, map } = resolvePrompt("A{?x}B{x}{/x}C", [], { values: { x: "yy" } });
// text === "AByyC"
mapResolvedOffsetToRaw(1, map); // 5  ("B")
mapRawOffsetToResolved(13, map); // 4  ("C")
mapRawOffsetToResolved(3, map); // 1  (inside "{?x}")
```

---

## 4. Editor Styling

The `GradientText` extension decorates tokens in the live editor. Variables with a default get a dashed underline and `data-default` / `data-description` attributes (shown as a tooltip). Balanced conditional tags get an amber highlight and `data-conditional="if" | "unless" | "end"`. Tags are paired across the whole document, so a section may span paragraphs. Unbalanced tags get a red wavy underline and `data-conditional-error`.

---

## 5. Asset Mentions with Roles

An asset mention can say what the asset is for: `@fox_photo:subject`, `@"Old Monet":style`. Roles are not part of the prompt grammar (prompts tokenize exactly as before); they belong to mentions.

- **Text syntax is opt-in.** `extractMentions(text)` and `preprocessMarkdownMentions(text)` behave exactly as before. Pass `{ roles: true }` (any role name) or `{ roles: ["style", "subject"] }` (only these, case-insensitive) to read `:role`. `findTextMentions(text)` (roles on by default) returns every mention with offsets, and `setMentionRoleInText(text, start, role | null)` adds, replaces or removes a role.
- **Mention nodes** store the role in the `assetRole` attribute, rendered as `data-role`. Mentions without a role render exactly as before, and an entity's own `role` field (e.g. a job title) is ignored. `getMentionNodes(editor)` and `setMentionRoleAt(editor, pos, role)` edit roles in rich text. `htmlToPlainText` writes `@label:role`. `extractMentionsFromDoc` and `extractMentions(html, { details: true })` report `role`.
- **Models declare roles.** `references.roles` in `ModelCapabilities` lists the roles a model accepts, with `max`, `min`, `label` and `accepts` (media kinds, wildcards or MIME types: `["image"]`, `["image/*"]`, `["image/png"]`). Built-in roles (`style_ref`, `character_ref`, `start_frame`, …) keep their labels. Any other name a model declares (`subject`, `pose`) is valid for that model. Hand-written aliases (`style`, `character`, `reference`, `start-frame`, …) map to built-in roles unless the model declares the alias itself (`normalizeReferenceRole`).
- **Planning.** Pass mentions as `planGenerationRequest(request, caps, { mentions })`. They become references and are checked per role. An alias is snapped to the model's role. A media type the role does not accept, a role the model does not take, or too many assets for a role are dropped (under `nearest` / `downgrade`) or reported as errors (under `error` / `upgrade`). A mention without a role gets `defaultMentionRole` or the first role that accepts its media (reported as `defaulted`). `validateAssetMentions` and `describeAssetMentions` report the same problems per mention for UI feedback. `capabilitiesToJsonSchema` and the agent tools list role enums, including custom roles.

React and Svelte ship `<AssetMentionChips content assets capabilities onChange />`. It shows each asset mention as a chip with a role badge and opens a role picker popover when clicked.

---

## 6. Generation Records and Recreate

`createGenerationRecord(options)` records everything needed to reproduce an output:

- the provenance (`createProvenance`): raw prompt, the exact body and version of every template the prompt reached, variable values, the resolved prompt and source map, the planned request and its adjustments;
- a hash per template body, a hash of the model's capabilities (presentation fields and timing are left out), and a hash of the resolved prompt;
- the user's original settings before planning, the strategy, the seed, and the referenced assets with roles, media types and content hashes;
- `parentId` and `kind` (`generate`, `recreate`, `variation`), with timestamps.

The hashes (`hashText`) are short and stable, and detect changes. They are not cryptographic.

`recreateRequest(record, { templates, capabilities, assets, mode })` rebuilds the request and reports **drift**:

| Drift | When |
| :--- | :--- |
| `template-changed` / `template-missing` | A template's current body differs from the recorded one, or the template is gone (the recorded body is used) |
| `prompt-changed` | The re-resolved prompt differs |
| `model-missing` (blocking) / `model-changed` | The model is gone, or its capability hash changed |
| `setting-unsupported` / `setting-changed` | A recorded setting is no longer accepted (`exact`), or the original settings now plan differently (`latest`). Plan errors are blocking |
| `asset-missing` (blocking) / `asset-changed` | A referenced asset is gone, or its content hash changed |

`mode: "exact"` (default) uses the recorded template bodies and the planned settings that were sent. `mode: "latest"` resolves the raw prompt with today's templates and re-plans the original settings. Both modes report template edits; only `latest` applies them. `result.ok` is false when an item has `severity: "error"`. `result.recordOptions` can be passed to `createGenerationRecord` once the new job has run. Called with bare provenance, `recreateRequest(provenance)` still returns the request that was sent, as it did before.

`variationRequest(record, { seed, values, settings, rawPrompt })` returns the same request with a new seed (random within the model's range, never the recorded one) and your overrides.

`createGenerationRecordStore({ storage })` persists records on any persistence adapter (memory, localStorage, IndexedDB, OPFS). It provides `put`, `get`, `list` / `summaries` with filters (`model`, `template` name or id, `asset`, `role`, `kind`, `parentId`, `since` / `until`, `text`, `offset` / `limit`, newest first), `remove`, `prune({ maxRecords, olderThan, keep })` and `subscribe`. React's `<GenerationHistory>` + `useGenerationRecords(store)` and Svelte's `<GenerationHistory>` + `createGenerationRecords(store)` list records with role badges and the drift report, and have Recreate (exact / latest) and Variation buttons.
