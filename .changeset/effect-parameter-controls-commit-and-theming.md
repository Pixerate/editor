---
"@pixerate/editor": minor
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
---

Effect parameter controls: commit typed values on Tab and native `change` as well as blur and Enter, and revert a refused edit every time it is retried. Theme the inputs, selects, buttons and sliders with `--pixerate-parameter-*` tokens (`input-bg`, `input-fg`, `select-bg`, `select-fg`, `button-fg`, `border`, `accent`), defined once in core as `parameterThemeStyles` / `parameterThemeStyleText`. Hosts can pass their own `input`, `slider` and `select` through a `components` prop or `ParameterComponentsProvider` / `setParameterComponents`. The image editor's host `Range` / `Select` are used for effect parameters, with values kept as their original types (`matchParameterOptionValue`).
