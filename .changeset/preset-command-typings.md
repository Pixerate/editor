---
"@pixerate/editor": patch
---

Ship TipTap command typings with the rich-text preset. The preset installs StarterKit, Underline, TextAlign, Highlight, Color, TextStyle, Link, Image and TaskList, but the published declarations never referenced those packages, so `editor.chain().toggleBold()`, `toggleHeading()`, `setTextAlign()` and similar were type errors in apps that use the preset without depending on the extension packages directly. The declarations now import them (through the exported `RichTextPresetCommandPackages` type), so their `Commands` augmentations apply.
