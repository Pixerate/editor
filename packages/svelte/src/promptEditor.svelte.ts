import type { Component } from "svelte";
import { Editor } from "@tiptap/core";
import {
  createPromptEditorOptions,
  promptEditorConfigKey,
  syncPromptEditor,
  type LoadingNodeViewMount,
  type LoadingNodeViewState,
  type PromptEditorConfig,
} from "@pixerate/editor";
import { createSvelteLoadingNodeView } from "./loading-node/index.js";

type MaybeGetter<T> = T | (() => T);
const read = <T>(value: MaybeGetter<T>): T =>
  typeof value === "function" ? (value as () => T)() : value;

export interface UsePromptEditorProps extends PromptEditorConfig {
  /** Optional DOM element to mount the editor into (or use `mount()` / `use:prompt.action`). */
  element?: HTMLElement;
  /**
   * Svelte component drawn inside each `loadingNode` placeholder instead of the default SVG spinner,
   * e.g. your design system's loader. It receives `view` (`id`, `label`). Read when a
   * placeholder renders, so changing it does not recreate the editor.
   */
  loadingIndicator?: Component<{ view: LoadingNodeViewState }>;
}

export interface SveltePromptEditor {
  /** The active TipTap `Editor` instance (reactive). */
  readonly editor: Editor | null;
  /** Alias for `editor` (matches `createReactiveEditor`). */
  readonly current: Editor | null;
  /** Mounts the editor DOM into `element`. */
  mount(element: HTMLElement): Editor | null;
  /** Svelte action (`use:prompt.action`) that mounts the editor DOM into `node`. */
  action(node: HTMLElement): { destroy(): void };
  /** Destroys the editor instance. */
  destroy(): void;
}

/**
 * Reactive prompt editor for Svelte 5 (the counterpart of React's `usePromptEditor`).
 * Manages plain-text serialization, animated gradient tokens, `{{template}}` autocomplete,
 * `/command` slash triggers, milestone tracking (`used_variable`, `used_magic`),
 * plain-text clipboard handling, and custom `loadingNode` indicators without recreating
 * the editor when content, editability, placeholder, className, or inline `templateColorMap`
 * references update.
 *
 * Pass a getter `() => ({ content, onContentChange, ... })` to react to prop/state updates.
 */
export function usePromptEditor(
  props: MaybeGetter<UsePromptEditorProps>,
): SveltePromptEditor {
  let editorState = $state.raw<Editor | null>(null);
  let currentEditor: Editor | null = null;
  let currentConfigKey: string | null = null;
  let mountedElement: HTMLElement | undefined;
  let latestProps: UsePromptEditorProps = read(props);
  const reachedMilestones = new Set<string>();

  // One node view for the editor's lifetime: swapping indicator components does not recreate
  // the editor. It is only installed while `loadingIndicator` is set (part of the config key).
  const dynamicLoadingNodeView: LoadingNodeViewMount = (dom, state) => {
    const Comp = latestProps.loadingIndicator;
    if (!Comp) return { update() {}, destroy() {} };
    return createSvelteLoadingNodeView(Comp)(dom, state);
  };

  function buildEditor(p: UsePromptEditorProps): Editor {
    return new Editor({
      ...createPromptEditorOptions(() => latestProps, {
        loadingNodeView: p.loadingIndicator ? dynamicLoadingNodeView : null,
        reachedMilestones,
      }),
      element: p.element ?? mountedElement,
    });
  }

  function syncProps(p: UsePromptEditorProps) {
    const previous = latestProps;
    latestProps = p;
    const nextKey = promptEditorConfigKey(p, { hasLoadingNodeView: !!p.loadingIndicator });

    if (!currentEditor || currentEditor.isDestroyed || currentConfigKey !== nextKey) {
      currentEditor?.destroy();
      currentConfigKey = nextKey;
      currentEditor = buildEditor(p);
      editorState = currentEditor;
      return;
    }

    // Content is applied only when the prop changed, so echoes of `onContentChange` and
    // unrelated prop updates never reset the document or the cursor.
    syncPromptEditor(currentEditor, p, previous);
  }

  // Initialize synchronously so `prompt.editor` is immediately available, then track updates reactively.
  syncProps(latestProps);

  $effect(() => {
    const next = read(props);
    syncProps(next);
  });

  $effect(() => () => {
    currentEditor?.destroy();
    currentEditor = null;
    currentConfigKey = null;
  });

  function mount(element: HTMLElement): Editor | null {
    mountedElement = element;
    if (currentEditor && !currentEditor.isDestroyed) {
      if (currentEditor.view.dom.parentElement !== element) {
        element.appendChild(currentEditor.view.dom);
      }
    }
    return currentEditor;
  }

  return {
    get editor() {
      return editorState;
    },
    get current() {
      return editorState;
    },
    mount,
    action(node: HTMLElement) {
      mount(node);
      return {
        destroy() {
          if (mountedElement === node) {
            mountedElement = undefined;
          }
        },
      };
    },
    destroy() {
      currentEditor?.destroy();
      currentEditor = null;
      currentConfigKey = null;
      editorState = null;
    },
  };
}

export const createPromptEditor = usePromptEditor;
