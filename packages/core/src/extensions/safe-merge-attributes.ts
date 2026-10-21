import { mergeAttributes } from "@tiptap/core";
import { isUnsafeJsonKey } from "../tools/safe-json";

/**
 * `mergeAttributes()` from `@tiptap/core` that drops own `__proto__`,
 * `constructor` and `prototype` keys first. Before `@tiptap/core` 2.27.3 /
 * 3.30.4, TipTap's version turned an own `__proto__` key (from JSON) into the
 * merged object's prototype, and ProseMirror's `DOMSerializer` then rendered
 * the inherited keys (`onerror`, `src`, …) as DOM attributes
 * (GHSA-cp6q-959q-f8rh). Use this in `renderHTML` instead of the TipTap one
 * whenever an input can come from options or content you don't control.
 */
export function safeMergeAttributes(...objects: Array<Record<string, any> | null | undefined>): Record<string, any> {
  return mergeAttributes(
    ...objects.filter((item): item is Record<string, any> => !!item).map((item) => {
      const keys = Object.keys(item);
      if (!keys.some(isUnsafeJsonKey)) return item;
      const copy: Record<string, any> = {};
      for (const key of keys) if (!isUnsafeJsonKey(key)) copy[key] = item[key];
      return copy;
    }),
  );
}
