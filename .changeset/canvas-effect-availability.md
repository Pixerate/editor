---
"@pixerate/editor": patch
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
---

Canvas effects that cannot be drawn now say why instead of vanishing. `canvasEffectStatus` (and `CanvasEffectsController.status`) reports an effect saved from another provider; the React and Svelte effect layers draw a faint hatch with the reason for that and for failed renders, and `CanvasEffectsPanel` shows it. The shared `list_applied_effects` tool now marks effects saved from another provider `available: false`, with a `reason`, in every editor.
