---
"@pixerate/editor": minor
"@pixerate/swift": minor
---

Effects authoring: `EffectAuthoringDocument` has an optional `provider` object for the provider's own data (such as code compiled ahead of time from the document's source). The generic authoring session (TypeScript and Swift) gives it back unchanged from `exportDocument`, so it survives a paint editor's save, reopen and save again, and drops it when the source is edited, since it may describe the old source (undo brings it back). A `provider` that is not an object is refused as `invalid_values`.
