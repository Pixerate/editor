# Gleamforge Migration Guide

This guide details how to refactor `/Users/jack/Development/gleamforge` (Svelte 5) to use `@pixerate/editor` and `@pixerate/editor-svelte`, achieving full feature parity with zero regressions.

---

## 1. Install Dependencies in Gleamforge

In `/Users/jack/Development/gleamforge`:

```bash
pnpm add @pixerate/editor @pixerate/editor-svelte
```

---

## 2. Refactor `editable-text-node-editor.svelte`

Gleamforge currently defines an editable node editor in `src/lib/components/node-widgets/editable-text-node-editor.svelte` (93 lines), containing custom event containment, drag disabling, bubble menu mounting, and cleanup.

### Before:
```svelte
<script lang="ts">
  import { Editor } from "@tiptap/core";
  import StarterKit from "@tiptap/starter-kit";
  import { BubbleMenu } from "$lib/components/edra/bubble-menu";
  // Custom lifecycle, bubble menu DOM attachment, and drag event stops...
</script>
```

### After:
```svelte
<script lang="ts">
  import { EditableTextNodeEditor } from "@pixerate/editor-svelte";

  let {
    content = $bindable(),
    editable = true,
    showMenu = true,
    class: className = "",
    onUpdate,
    onFocus,
    onBlur,
    placeholder = "Type something...",
  } = $props();
</script>

<EditableTextNodeEditor
  bind:content
  {editable}
  {showMenu}
  class={className}
  {placeholder}
  {onUpdate}
  {onFocus}
  {onBlur}
/>
```

---

## 3. Refactor `editor.ts` (Edra Preset Initiation)

Gleamforge initiates TipTap instances in `src/lib/components/edra/editor.ts` (121 lines).

### Before:
Manually assembling `StarterKit`, `ColorHighlighter`, `SmilieReplacer`, and `FontSize`.

### After:
```typescript
import { initiateEditor as coreInitiateEditor } from "@pixerate/editor-svelte";
import type { Editor, Content, Extensions } from "@tiptap/core";

export const initiateEditor = (
  element?: HTMLElement,
  content?: Content,
  extensions?: Extensions,
  options?: any
): Editor => {
  return coreInitiateEditor(element, content, extensions, options);
};
```

---

## 4. Refactor Custom Extensions

Gleamforge's custom extensions:
- `SmilieReplacer.ts` -> re-export `SmilieReplacer` from `@pixerate/editor`
- `ColorHighlighter.ts` -> re-export `ColorHighlighter` from `@pixerate/editor`
- `FontSize.ts` -> re-export `FontSize` from `@pixerate/editor`

```typescript
// src/lib/components/edra/extensions/index.ts
export {
  SmilieReplacer,
  ColorHighlighter,
  FontSize,
  createRichTextPreset,
} from "@pixerate/editor";
```

---

## Verification Checklist for Gleamforge
- [ ] Type `:)` or `(y)` in text editor — verify automatic replacement with emoji `🙂` or `👍`.
- [ ] Type a hex color like `#ff0055` — verify the colored circle badge appears adjacent to the text.
- [ ] Select text — verify floating bubble menu appears above selection with Bold, Italic, and Strikethrough options.
- [ ] Drag parent node container — verify selecting text inside editor does NOT trigger canvas node drag.
