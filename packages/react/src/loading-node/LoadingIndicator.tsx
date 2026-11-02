import React from 'react';
import { createRoot } from 'react-dom/client';
import type { LoadingNodeViewMount, LoadingNodeViewState } from '@pixerate/editor';

export interface LoadingIndicatorProps {
  /** What the editor's `loadingNode` passes (see `LoadingNodeViewState`). */
  state: LoadingNodeViewState;
}

/**
 * The `nodeView` for the core `loadingNode`, drawing `component` inside each placeholder in its
 * own React root: `LoadingNode.configure({ nodeView: createReactLoadingNodeView(MyLoader) })`.
 * The placeholder keeps `role="status"` and its `aria-label`, so the component can be decorative.
 * Works with any TipTap editor (it does not need `EditorContent`); app context does not reach it.
 */
export function createReactLoadingNodeView(
  component: React.ComponentType<LoadingIndicatorProps>,
): LoadingNodeViewMount {
  const Component = component;
  return (dom, state) => {
    const root = createRoot(dom);
    let latest = state;
    let scheduled = false;
    let destroyed = false;
    // ProseMirror creates and updates node views inside other renders (e.g. while
    // `EditorContent` mounts), where rendering another root is an error: render in a microtask.
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!destroyed) root.render(<Component state={latest} />);
      });
    };
    schedule();
    return {
      update: (next) => {
        latest = next;
        schedule();
      },
      destroy: () => {
        destroyed = true;
        queueMicrotask(() => root.unmount());
      },
    };
  };
}
