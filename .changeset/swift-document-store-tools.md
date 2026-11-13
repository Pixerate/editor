---
"@pixerate/swift": minor
"@pixerate/editor": patch
"@pixerate/conformance": minor
---

The Swift editors can save, list and open documents and clean up their stored images, as the TS core does (follow-up to #742). `PixerateCore` adds named documents (`createEditorDocumentStore`, `SavedEditorDocument`), asset garbage collection (`collectEditorAssetGarbage`, `tryCollectEditorAssetGarbage`, `collectRetiredEditorAssets`, `withEditorAssets`, with write leases so a save in flight keeps its assets), and the store tools of `createDocumentToolProvider`: `save_<kind>_document`, `list_saved_<kind>_documents`, `open_saved_<kind>_document` and, for documents with assets on storage that lists its keys, `find_unreferenced_<kind>_assets` / `delete_unreferenced_<kind>_assets`, with the TS results and messages. `EditorStorage` gains `kind`, `remove` and key listing (`listsKeys`, `keys(_:)`); `MemoryEditorStorage` keeps insertion order like the TS memory storage, and `DirectoryEditorStorage` stores one file per key in a folder.

Paint registers them with the host's store: `createPaintDocumentToolProvider(_:store:)` and `PaintEditorModel(documentStore:)`, which the Swift demo passes a folder in Application Support, as the TS demo's paint tab passes its IndexedDB store.

The paint contract now lists the store tools (its conformance host has a memory document store with a fixed clock), and the new `document-store` paint scenario calls every one of them.
