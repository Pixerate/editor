---
"@pixerate/editor": minor
---

Fix template resolution edge cases:

- Template bodies containing `$&`, `` $` ``, `$'` or `$$` are now inserted literally. Previously they were treated as `String.replace` patterns, which corrupted output and could hang the resolver forever.
- **Behavior change:** loop and max-depth errors now replace only the offending tag instead of the whole prompt. `resolveTemplates("Hello {{a}} world")` with a self-referencing `a` now returns `"Hello [Template loop detected] world"`. Use the new `TEMPLATE_LOOP_ERROR` / `TEMPLATE_DEPTH_ERROR` constants with `.includes()` to detect errors.
- `resolveTemplatesWithMapping` now produces exactly the same text as `resolveTemplates` (it previously expanded loops one level further and ignored `maxDepth`), and accepts an optional `{ maxDepth }` options argument.
- `mapResolvedOffsetToRaw` / `mapRawOffsetToResolved` now map the end of a trailing template to the end of its tag instead of jumping back to its start.
- New `getTemplateBody(template, bindings)` helper exposes version-binding resolution.
