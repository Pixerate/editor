---
"@pixerate/editor-svelte": minor
---

New `@pixerate/editor-svelte/typography` subpath: `<FontPicker>` (a searchable combobox of families shown in their own face, category filter, weight and style selects, live preview, load status), `<TypographyControl>` (the picker plus size, line height and letter spacing) and `fontPickerOf` (follows a core `FontPickerModel` with runes). Pass a shared model to let agents drive the same control through `createFontPickerToolProvider`. Effect parameter panels show font controls (`format: "font"`) as a font choice. Re-exports `@pixerate/editor/typography`.
