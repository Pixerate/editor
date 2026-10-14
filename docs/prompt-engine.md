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

### Backwards Compatibility

Without the new syntax, prompts tokenize exactly as before. The only change to `VARIABLE_REGEX` is backslash escaping, which can change the match for text that has a backslash directly before a brace. `resolveTemplates` and `resolveTemplatesWithMapping` behave exactly as before unless `values` is passed. `extractVariableNames` now returns `subject` for `{subject|default}` and includes names used by conditions.

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

React and Svelte ship a `VariableForm` component built on these helpers. It renders a text input per variable, or a checkbox for condition-only variables, and calls `onChange(values, entered)`. `TemplateRenderer` accepts the same `values` to preview the filled prompt: values and defaults are highlighted, and failing sections are hidden. For custom renderers, use `evaluatePromptTokens(text, values)`.

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
