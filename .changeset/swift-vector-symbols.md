---
"@pixerate/swift": minor
---

**Swift vector editor: symbols and instances (#624).**

- Symbols (`Symbols.swift`): instances carry their symbol's art (`resolveVectorSymbols` after every change, `stripVectorSymbolArt` for saved documents) and draw it as a plain group (`vectorInstanceDrawn`): the rotation on the group, scale and skew baked into the art, strokes scaled with the instance unless `scaleStrokes` is off, fill / stroke tints and hidden art nodes applied. Nested symbols resolve through each other, and a symbol that would contain itself draws nothing (`vectorSymbolUses`).
- Instances take part in bounds, appearance, Expand Appearance, blends (instance keys blend as their art), render data and SVG export, as a `<use>` of a `<symbol>` in `defs` or, where `<use>` cannot draw an instance exactly, as its drawn art in a `<g data-vector-instance>`. SVG import reads them back, with unused symbols, and turns a `<use>` of any element into an instance.
- The controller has `makeSymbol`, `placeSymbol`, `setInstanceOptions`, `replaceSymbol`, `detachInstances`, `renameSymbol`, `deleteSymbol`, `editSymbol` and `exitSymbolEdit` (isolation mode, with undo stepping in and out), `getSymbols`, `getSymbolInstances`, `symbolEditState`, and the symbols panel's data (`symbolsPanel`, `symbolEditBackground`). `vector.list` lists instances.
- The 10 symbol commands run, and the `symbols` scenario passes (10 of 15 vector scenarios).
