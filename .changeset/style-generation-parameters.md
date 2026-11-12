---
"@pixerate/editor": minor
---

House style for generation and effect parameters (#779).

- `generationStyleDomain` (`generation.json`): the models, aspect ratios and qualities allowed, count and duration limits, a house look appended to every prompt, negative terms every request carries, and banned terms. It checks a request before anything is spent: agent tools `check_generation_style` and `apply_generation_style` (returns the request in the house style; both read-only, neither generates), `createGenerationStyleToolProvider`.
- `parametersStyleDomain` (`parameters.json`): values the house fixes, ranges for numeric parameters, the presets allowed, and the brand's palette-only on colour parameters. Agent tools `check_parameters_style` and `fix_parameters_style` (one undo step; read-only parameters left; hidden when read-only), `createParametersStyleToolProvider`.
