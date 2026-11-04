---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
"@pixerate/swift": patch
---

Sticker provider contract additions (#488):

- **AI-generated art.** `StickerSummary.aiGenerated?: boolean`; `checkStickerProvider` rejects a value that isn't a boolean. `find_stickers` and `describe_sticker` return it, and the React and Svelte `StickerLibraryPicker` label such art "AI".
- **Light / dark variants.** `StickerSummary.variants?: ("light" | "dark")[]` (always with `light`) and `load(id, { variant })`, defaulting to `light`. A variant the sticker lacks is refused with an `unsupported_variant` `StickerError` that names the ones it has (`checkStickerVariant` does it for providers). The old, unused `StickerDescription.variants` (`{ id, name }[]`) is replaced by this field. `insert_sticker` takes `variant` and otherwise uses the dark art when the host's background is dark (`dark` option on `createVectorStickerHost`, `createImageStickerHost` and `createCanvasStickerHost`), and returns the variant used. The paint editor's sticker brush sprays dark variants on a dark colour scheme, and each sticker keeps the variant it was drawn in (`Sticker.variant`).
- **Collections.** `StickerSummary.collection`, `StickerSearchOptions.collection` and an optional `listCollections()`. `combineStickerProviders` namespaces collection ids as `provider:collection`. `find_stickers` filters by `collection` and returns the collections, the `StickerBrowser` has `setCollection`, and the pickers show a collection filter.
- The fake provider has AI-generated stickers, dark variants and collections to test against.
- Swift: `find_stickers` takes `collection` (from the regenerated contract) and refuses it, as the editor's own stickers are in no collection.
