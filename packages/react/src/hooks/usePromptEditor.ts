import React, { useMemo, useEffect, useRef } from "react";
import { useEditor } from "@tiptap/react";
import {
  createPromptEditorOptions,
  promptEditorConfigKey,
  syncPromptEditor,
  type PromptEditorConfig,
} from "@pixerate/editor";
import { createReactLoadingNodeView, type LoadingIndicatorProps } from "../loading-node";

export interface UsePromptEditorProps extends PromptEditorConfig {
  /**
   * Component drawn inside each `loadingNode` placeholder instead of the default SVG spinner,
   * e.g. your design system's loader. It receives `state` (`id`, `label`). Read when a
   * placeholder renders, so changing it does not recreate the editor.
   */
  loadingIndicator?: React.ComponentType<LoadingIndicatorProps>;
}

/**
 * The plain-text prompt editor (`createPromptEditorOptions` from `@pixerate/editor`) as a React
 * hook. Only options baked into extensions recreate the editor; editable state, placeholder,
 * class names and content are applied to the live instance (`syncPromptEditor`).
 */
export function usePromptEditor(props: UsePromptEditorProps) {
  const propsRef = useRef(props);
  propsRef.current = props;

  const { loadingIndicator } = props;
  const loadingIndicatorRef = useRef(loadingIndicator);
  loadingIndicatorRef.current = loadingIndicator;
  const hasLoadingIndicator = !!loadingIndicator;
  // One node view for the editor's lifetime: swapping components does not recreate the editor.
  const loadingNodeView = useMemo(
    () =>
      hasLoadingIndicator
        ? createReactLoadingNodeView((indicatorProps: LoadingIndicatorProps) => {
            const Indicator = loadingIndicatorRef.current;
            return Indicator ? React.createElement(Indicator, indicatorProps) : null;
          })
        : null,
    [hasLoadingIndicator],
  );

  const reachedMilestonesRef = useRef(new Set<string>());
  const configKey = promptEditorConfigKey(props, { hasLoadingNodeView: hasLoadingIndicator });

  const editor = useEditor(
    {
      immediatelyRender: false,
      ...createPromptEditorOptions(() => propsRef.current, {
        loadingNodeView,
        reachedMilestones: reachedMilestonesRef.current,
      }),
    },
    [configKey, loadingNodeView],
  );

  // Apply content changes made by the parent (e.g. clearing after submit), editability,
  // class names and placeholder to the live editor.
  const syncedRef = useRef<{ editor: typeof editor; config: PromptEditorConfig } | null>(null);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const previous = syncedRef.current?.editor === editor ? syncedRef.current.config : undefined;
    syncPromptEditor(editor, props, previous);
    syncedRef.current = { editor, config: props };
  });

  return editor;
}
