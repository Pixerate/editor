---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Edit the variants of a canvas component set. Core adds `addCanvasVariant` (duplicate a variant with new ids and property values; new property names are added to every variant; duplicate combinations are refused; laid out next to the source or by the set's auto layout), `removeCanvasVariant` (refuses the last variant; instances switch to the closest variant, keeping overrides), `setCanvasVariantProperties`, `renameCanvasVariantProperty`, `renameCanvasVariantValue` and `getNextVariantValues`. The components controller gains undoable `addVariant`, `removeVariant`, `setVariantProperties`, `renameVariantProperty` and `renameVariantValue` with `can…` reasons, registered as `canvas.*` commands and agent tools (`add_variant`, `remove_variant`, `set_variant_properties`, `rename_variant_property`, `rename_variant_value`). React and Svelte `CanvasComponentsPanel` take an optional `components` (and `onError` / `onerror`) to show "+ Variant" on sets, inline property / value renames, and a per-variant menu (also on right click) to edit, duplicate or remove a variant.
