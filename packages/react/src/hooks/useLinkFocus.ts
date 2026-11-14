import { useCallback, useState, useSyncExternalStore, type FocusEvent, type KeyboardEvent } from "react";
import { createLinkFocus, type LinkFocusModel, type LinkFocusOptions, type LinkFocusState } from "@pixerate/editor/tools";

export interface UseLinkFocusOptions extends Partial<LinkFocusOptions> {
  /** Use an existing model instead of creating one from `marks` and `links`. */
  model?: LinkFocusModel;
}

/** Handlers for one mark's element: hover and keyboard focus put its key in focus. */
export interface LinkFocusMarkProps {
  onPointerEnter: () => void;
  onFocus: () => void;
  "data-link-focus": string;
}

/** Handlers for the picture's container: arrow keys, Home, End, Escape, and clearing on leave. */
export interface LinkFocusRootProps {
  onKeyDown: (event: KeyboardEvent) => void;
  onPointerLeave: () => void;
  onBlur: (event: FocusEvent) => void;
}

export interface UseLinkFocusResult {
  model: LinkFocusModel;
  state: LinkFocusState;
  /** Spread on a mark's element (the key it focuses: an item or a tag). */
  markProps(key: string): LinkFocusMarkProps;
  /** Spread on the picture's container. */
  rootProps: LinkFocusRootProps;
  /** Opacity for the mark at `index`: 1 when lit, the model's `dim` otherwise. */
  opacity(index: number): number;
  /** The focused key and its links, for a live region. */
  description: string;
}

/**
 * Focus across linked marks (#812): creates (or adopts) a `createLinkFocus` model and re-renders on
 * its changes. Hovering or focusing a mark lights it and everything linked to it; arrow keys walk
 * the keys, Escape clears, and leaving the picture (pointer or focus) clears too.
 */
export function useLinkFocus(options: UseLinkFocusOptions): UseLinkFocusResult {
  const [model] = useState(() => options.model ?? createLinkFocus({ marks: options.marks ?? [], links: options.links ?? {}, order: options.order, labels: options.labels, dim: options.dim }));
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const markProps = useCallback(
    (key: string): LinkFocusMarkProps => ({ onPointerEnter: () => model.focus(key), onFocus: () => model.focus(key), "data-link-focus": key }),
    [model],
  );
  const rootProps: LinkFocusRootProps = {
    onKeyDown: (event) => {
      if (model.handleKey(event)) event.preventDefault();
    },
    onPointerLeave: () => {
      model.clear();
    },
    onBlur: (event) => {
      // Clear only when focus leaves the picture (focus-within), not when it moves between marks.
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) model.clear();
    },
  };
  return {
    model,
    state,
    markProps,
    rootProps,
    opacity: (index) => (state.lit[index] ? 1 : model.dim),
    description: model.describe(state.focus),
  };
}
