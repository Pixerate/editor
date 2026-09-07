# Prompt Grammar & Resolution Engine

The `@pixerate/editor` prompt engine handles parsing, recursion, cycle detection, and bidirectional sourcemapping for complex prompt engineering workflows.

---

## 1. Prompt Grammar Tokens

The engine identifies three primary token classes:

| Token Type | Syntax Pattern | Purpose | Example |
| :--- | :--- | :--- | :--- |
| **Template** | `{{\s*([^}]+?)\s*}}` | Reusable prompt snippet | `{{cyberpunk_lighting}}` |
| **Variable** | `(?<!\{)\{([a-zA-Z0-9_-]+)\}(?!\})` | Dynamic input field | `{user_name}` |
| **Instruction** | `__([^_]+?)__` | Meta-instruction for LLM | `__do not include text__` |

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

---

## 2. Recursive Template Resolution

Templates can reference other templates arbitrarily deep. The resolver traverses the graph and replaces template references with their defined bodies.

### Cycle Detection
When circular references are encountered (e.g. `templateA` calls `templateB`, which in turn calls `templateA`), the resolver catches this using a visited set:

```typescript
import { resolveTemplates } from "@pixerate/editor";

const templates = [
  { name: "loop_a", body: "calls {{loop_b}}" },
  { name: "loop_b", body: "calls {{loop_a}}" },
];

const result = resolveTemplates("Start {{loop_a}}", templates);
console.log(result);
// => "[Template loop detected]"
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
