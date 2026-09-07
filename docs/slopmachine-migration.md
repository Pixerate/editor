# SlopMachine Migration Guide

This guide details how to refactor `/Users/jack/Development/slopmachine` to use `@pixerate/editor` and `@pixerate/editor-react`, achieving full feature parity with zero regressions.

---

## 1. Install Dependencies in SlopMachine

In `/Users/jack/Development/slopmachine`:

```bash
pnpm add @pixerate/editor @pixerate/editor-react
```

You can now safely remove local duplicated dependencies if no longer used directly:
```bash
# Optional: remove locally maintained TipTap extensions if all are covered by @pixerate/editor
```

---

## 2. Refactor `hooks/useSlopEditor.tsx`

The custom hook `hooks/useSlopEditor.tsx` in SlopMachine (357 lines) can be replaced with a wrapper around `usePromptEditor`:

### Before:
```tsx
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { GradientText } from "@/app/extensions/gradient-text";
import { plainTextToTipTapHtml, getEditorText } from "@/lib/editor-utils";
// ~350 lines of custom clipboardTextParser, milestone tracking, and sync logic...
```

### After:
```tsx
import { usePromptEditor, UsePromptEditorOptions } from "@pixerate/editor-react";

export function useSlopEditor(options: UsePromptEditorOptions) {
  // @pixerate/editor-react's usePromptEditor provides 100% feature parity:
  // - plainTextToTipTapHtml / getEditorText newline preservation
  // - clipboardTextParser preserving line breaks and avoiding nested nodes
  // - GradientText inline highlights for {{templates}}, {vars}, and __instructions__
  // - Slash commands and autocomplete integration
  // - Selection change and milestone update events
  return usePromptEditor(options);
}
```

---

## 3. Refactor `lib/template-utils.ts`

SlopMachine currently maintains template parsing, recursive resolution, and source mapping in `lib/template-utils.ts`.

Replace imports in `lib/template-utils.ts` with re-exports from `@pixerate/editor`:

### Before:
```typescript
// 360 lines implementing resolveTemplates, resolveTemplatesRecursive,
// resolveTemplatesWithMapping, source map segments, etc.
```

### After:
```typescript
export {
  TEMPLATE_REGEX,
  VARIABLE_REGEX,
  INSTRUCTION_REGEX,
  tokenizePrompt,
  resolveTemplates,
  resolveTemplatesWithMapping,
  resolveVariables,
  getTemplateNames,
  getVariableNames,
  getInstructionNames,
  mapResolvedOffsetToRaw,
  mapRawOffsetToResolved,
} from "@pixerate/editor";

export type {
  Token,
  TokenType,
  Template,
  TemplateVersion,
  SourceMapSegment,
} from "@pixerate/editor";
```

All existing callers across SlopMachine (including UI components and Firebase Cloud Functions) continue to work seamlessly without changing their import paths!

---

## 4. Refactor `app/extensions/gradient-text.ts`

SlopMachine's custom TipTap extension for gradient highlights can simply re-export `GradientText`:

```typescript
export { GradientText, defaultPalette } from "@pixerate/editor";
export type { GradientTextOptions, ColorGradient } from "@pixerate/editor";
```

---

## 5. Refactor `<TemplateRenderer />`

Replace SlopMachine's AST rendering component in `components/TemplateRenderer.tsx`:

### Before:
Custom manual regex slicing and span rendering.

### After:
```tsx
import { TemplateRenderer } from "@pixerate/editor-react";

export default TemplateRenderer;
```

---

## Verification Checklist for SlopMachine
- [ ] Paste multiline text into the editor — verify line breaks are maintained without extra paragraph spacing.
- [ ] Type `{{` — verify template autocomplete pops up.
- [ ] Insert nested templates — verify recursive expansion and loop warning if circular references occur.
- [ ] Click templates in `<TemplateRenderer />` — verify click callbacks fire correctly.
