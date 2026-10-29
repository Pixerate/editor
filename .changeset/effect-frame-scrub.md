---
"@pixerate/editor-svelte": patch
---

The effect layer frame slider keeps working through a whole drag. `effectDescriptionOf` reloaded (and cleared) the effect's description on every edit of the layer, which took the frame controls off the page mid-drag; it now reloads only when the provider or the effect id changes.
