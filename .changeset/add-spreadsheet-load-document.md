---
'@pixerate/editor': patch
'@pixerate/editor-svelte': patch
'@pixerate/editor-react': patch
---

Add `loadDocument` and `syncWithDataSource` methods to `SpreadsheetController`, `createReactiveSpreadsheet`, and `useSpreadsheetEditor`. Deep clones loaded documents to prevent reactive proxy mutation cascades.
