---
"@pixerate/editor": minor
---

House style: a browser-storage style store, and a prompt-ready description of one style domain (#796, #798).

- `storageStyleStore({ key, storage, limits, initial, watchOtherTabs })` keeps a style store in `localStorage` (or any `getItem` / `setItem` / `removeItem` storage) as one JSON value under one key. Every read checks names, paths, file types and sizes again and leaves out what fails (`problems()` says what). Data that is not this store's format throws, naming the key, instead of being overwritten. A full quota throws a clear error that `save_style` reports. Subscribers hear about the store's own writes and, where there is a window, other tabs' changes to the key. It passes `styleStoreConformance`. The demo's user layer now uses it.
- `renderStyleDomain(domain)` gives a `<style_domain>` block for a model about to write a skill for one domain: where the profile goes (file or frontmatter key), `extends`, the format version, the checks it can turn on, an example and the schema. `get_style_schema` returns it as its text. `escapeStyleBlocks` (now exported) also escapes `<style_domain>`.
