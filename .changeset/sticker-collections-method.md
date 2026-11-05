---
"@pixerate/editor": minor
---

**Stickers:** `StickerProvider` takes the optional `collections()` named in #614. `listCollections()` stays as its older name: the conformance checker, `combineStickerProviders`, `StickerBrowser` and `find_stickers` read `collections()` first, then `listCollections()`, through the new `providerCollections(provider)` helper. Combined and fake providers have both. Conformance messages now name `collections()`.
