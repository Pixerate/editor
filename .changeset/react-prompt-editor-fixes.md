---
"@pixerate/editor-react": patch
"@pixerate/editor": patch
---

Fix `usePromptEditor` lifecycle bugs:

- Passing `templateColorMap` inline (`new Map(...)` in render) no longer causes an infinite render loop ("Maximum update depth exceeded"). The map is now compared by value.
- Toggling `isEditing`, or changing `placeholder`, `className` or `jsonVariables`, updates the live editor instead of destroying and recreating it. Undo history, focus and the caret are kept.
- `content` is now applied when the parent changes it, so you can clear the editor after submit with `setPrompt("")`. Echoes of the editor's own `onContentChange` are ignored, so typing never resets the caret.
- Milestones use the core tokenizer, so `__award_winning__` now fires `used_magic`. Each milestone fires once per mount instead of on every keystroke.
- Plain-text paste handling uses the new core `plainTextToSlice` helper, which replaces two duplicated copies. Core now exports `plainTextToSlice(text, schema)` from its serializers.
