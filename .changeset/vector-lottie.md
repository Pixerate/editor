---
"@pixerate/editor": minor
---

Lottie export and import for vector documents.

- `toLottie` / `vectorDocumentToLottie` export, keeping path effects live as Lottie modifiers and gradients as gradient fills.
- `importLottie` / `parseVectorLottie` read one frame. Modifiers become live effects, and layers, parenting, precomps and additive masks are supported.
- Each direction returns notes on what was approximated.
- New agent commands: `vector.exportLottie` and `vector.importLottie`.
