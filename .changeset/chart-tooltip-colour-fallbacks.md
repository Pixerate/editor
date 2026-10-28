---
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
---

Chart tooltips fall back to `--background` / `--foreground` when the host defines only one of `--popover` and `--popover-foreground`, so the text stays readable in dark themes that leave `--popover-foreground` out.
