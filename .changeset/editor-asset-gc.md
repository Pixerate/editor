---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Garbage-collect unreferenced editor assets in storage (#348). `collectEditorAssetGarbage(storage, { keep, dryRun, only })` deletes the stored `pixerate.assets:` entries that no stored document, index or autosave snapshot refers to, keeping registries, documents and references passed in `keep`, and never racing a write in flight (leases in this realm, Web Locks across tabs). `StorageAdapter` gains an optional `keys(prefix)`, implemented by the memory, localStorage, IndexedDB and OPFS adapters and passed through `withStorageFailures` and `withEditorAssets`; `EditorAssetRegistry` gains an optional `refs()`. `createEditorDocumentStore` collects after `remove` and exposes `collectAssetGarbage()`; `createEditorAutosave` (core and Svelte) and React `useEditorAutosave` collect after `markClean` and `discard`, keeping the assets the open document uses (option `collectAssetGarbage`, default on). Image and paint document tools add `find_unreferenced_<kind>_assets` and `delete_unreferenced_<kind>_assets` when the store's storage can list keys.
