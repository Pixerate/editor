import { useCallback, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import {
  applyDocumentComparison,
  type CompareSource,
  type CompareSummary,
  type EditorCompareOptions,
} from "@pixerate/editor";

export type { CompareSource, CompareSummary, EditorCompareOptions } from "@pixerate/editor";

export interface UseDocumentCompareResult {
  /** Summary of the last comparison, or `null`. */
  summary: CompareSummary | null;
  /**
   * Replaces the editor content with the comparison of two versions (nodes,
   * JSON or HTML) as tracked changes, ready to review with `ReviewToolbar`.
   * Returns the summary, or `null` without an editor.
   */
  compare: (
    original: CompareSource,
    revised: CompareSource,
    options?: EditorCompareOptions,
  ) => CompareSummary | null;
  /** Forgets the last summary. */
  clear: () => void;
}

/**
 * Compare two document versions into an editor using `TrackChanges`.
 * `options` are defaults for every comparison.
 */
export function useDocumentCompare(
  editor: Editor | null | undefined,
  options?: EditorCompareOptions,
): UseDocumentCompareResult {
  const [summary, setSummary] = useState<CompareSummary | null>(null);
  const defaults = useRef(options);
  defaults.current = options;
  const compare = useCallback(
    (original: CompareSource, revised: CompareSource, overrides?: EditorCompareOptions) => {
      if (!editor || editor.isDestroyed) return null;
      const result = applyDocumentComparison(editor, original, revised, {
        ...defaults.current,
        ...overrides,
      });
      setSummary(result.summary);
      return result.summary;
    },
    [editor],
  );
  const clear = useCallback(() => setSummary(null), []);
  return useMemo(() => ({ summary, compare, clear }), [summary, compare, clear]);
}
