---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add house-style skills: preferences and rules a host hands agents at runtime, per editor domain. `createStyleResolver` merges layers of style skills (org, workspace, user, ...; locked and required layers, per-field profile merge with sources, `$token` references resolved against design tokens), `memoryStyleStore` holds them, and `createStyleToolProvider` adds `list_styles`, `get_style`, `get_style_file` and `get_style_schema`. Charts (`chartStyleDomain`, `check_chart_style`: palette-only, distinguishable, min-contrast, allowed-type) and design tokens (`tokensStyleDomain`, `createTokenStyleSource`, `check_tokens_style`: required-variables, name-pattern, required-modes, contrast-pairs) are the first domains. Discovery views (`discovery.styles`) mark toolsets that have a house style. React and Svelte add `useStyle`, `useStyleFindings` and `<StyleFindings>`.
