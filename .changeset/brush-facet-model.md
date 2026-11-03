---
"@pixerate/editor": minor
---

Add `@pixerate/editor/brushes`, the shared brush model: a `Brush` made of facets (kind, medium, variety or tool; tip; marks; dynamics; behaviour; light; motion; colour) that people and agents can put together, instead of the paint engine's flat `PaintBrush` with every engine block.

- `resolveBrush(brush)` gives the flat form the paint engine reads (`ResolvedBrush`, today's `PaintBrush`); `resolveEngine` and `resolveCategory` derive the engine and library category from the tip, marks and behaviour, so nobody picks an engine directly.
- `migrateBrushV1(paintBrush)` reads brushes written before the facet model. What the engine reads survives exactly; settings of engine blocks the brush never uses are dropped, and the category is derived again.
- `normalizeBrushSpec(raw, problems)` clamps and checks a brush against `BRUSH_JSON_SCHEMA` (strict, every field described) and reports each fix.
- Stamp tips hold sticker refs (`editor:star`, or any provider's sticker, for objects marks); particle marks lay only the editor's own stamps, and the normaliser says so when it drops one.
- `BRUSH_PRESETS`: the 67 built-in brushes as facet specs, each with a medium and variety. Each resolves to exactly the paint editor's `BUILTIN_BRUSHES` entry of the same id. The highlighter is now ink / highlighter, with a spill hint of 0 and a fluorescent palette.

Nothing changes for the paint, canvas, vector or image editors yet: they still read `PaintBrush`. The sticker spray, particle and bristle settings (types, defaults, normalisers) moved to `paint-editor/mark-settings.ts` so the brush model does not bundle the renderers; `stickers.ts` and `procedural.ts` re-export them, so imports from `@pixerate/editor/paint-editor` are unchanged.
