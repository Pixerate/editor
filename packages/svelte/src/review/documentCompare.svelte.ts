import type { Editor } from "@tiptap/core";
import {
  applyDocumentComparison,
  type CompareSource,
  type CompareSummary,
  type EditorCompareOptions,
} from "@pixerate/editor";

export type { CompareSource, CompareSummary, EditorCompareOptions } from "@pixerate/editor";

export interface SvelteDocumentCompare {
  /** Summary of the last comparison, or `null` (reactive). */
  readonly summary: CompareSummary | null;
  /**
   * Replaces the editor content with the comparison of two versions (nodes,
   * JSON or HTML) as tracked changes, ready to review with `ReviewToolbar`.
   * Returns the summary, or `null` without an editor.
   */
  compare(
    original: CompareSource,
    revised: CompareSource,
    options?: EditorCompareOptions,
  ): CompareSummary | null;
  /** Forgets the last summary. */
  clear(): void;
}

/**
 * Compare two document versions into an editor using `TrackChanges`.
 * `options` are defaults for every comparison.
 */
export function createDocumentCompare(
  editor: Editor | null | undefined,
  options?: EditorCompareOptions,
): SvelteDocumentCompare {
  let summary = $state.raw<CompareSummary | null>(null);
  return {
    get summary() {
      return summary;
    },
    compare(original, revised, overrides) {
      if (!editor || editor.isDestroyed) return null;
      const result = applyDocumentComparison(editor, original, revised, { ...options, ...overrides });
      summary = result.summary;
      return result.summary;
    },
    clear() {
      summary = null;
    },
  };
}
