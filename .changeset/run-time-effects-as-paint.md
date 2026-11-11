---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
"@pixerate/swift": minor
---

Effects written at run time can now be used as paint (#750). **Pixel expressions** are a bounded per-pixel language (no loops, no memory or API access, a cost cap) that this package evaluates itself, so agents can write effects even where generated code may not run. `createPixelEffectProvider` has templates that open with source editing, and the generic authoring session now edits source through an optional backend. The paint editor keeps authored effects in the painting with their source (`authored.<name>` ids). They work as effect paint, paper, effect layers, fills and light, and replay anywhere. New tools: `open_effect_authoring`, `save_authored_effect`, `list_authored_effects`, `remove_authored_effect` and `close_effect_authoring`. New options: an `authoredEffects` policy (`off` / `replay` (default) / `author`), `rawShaders` and `authoredEffectLimits`. The React and Svelte paint effects panels list authored effects. Swift ports the language (CPU, and Metal through generated MSL), the authoring contract and session, the tools and authored effects in paint documents.
