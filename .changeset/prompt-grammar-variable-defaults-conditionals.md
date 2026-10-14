---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Prompt grammar: variable defaults, descriptions, conditional sections and resolution with values.

- `{name|default|description}` variables (FILLIN-style). The tokenizer exposes `defaultValue` and `description` on variable tokens, and `\|`, `\{`, `\}`, `\\` escapes are supported.
- `{?name}…{/name}` and `{!name}…{/name}` conditional sections, emitted as `conditional` tokens. They nest, and they work inside template bodies with cycle detection. Unbalanced tags stay literal text and are reported as diagnostics (`tokenizePromptWithDiagnostics`, `getPromptDiagnostics`).
- New `values` option on `resolveTemplates` / `resolveTemplatesWithMapping`, and a new `resolvePrompt()` that returns `{ text, map, diagnostics }`. Source maps gain `variable` and `conditional` segments. Without `values`, output is unchanged.
- Headless fill-in form helpers: `extractVariables`, `getVariableFormFields`, `compactVariableValues`, plus `evaluatePromptTokens` for renderers.
- `GradientText` styles variables that have defaults, balanced conditional tags, and unbalanced conditional tags (each differently).
- React and Svelte: `TemplateRenderer` accepts `values` and `bindings` and renders the new tokens. New `VariableForm` component.
- `extractVariableNames` now strips defaults and includes names used by conditions. `resolveVariables` honors defaults and sections.
