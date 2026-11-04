import type { Component } from "svelte";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Slice } from "@tiptap/pm/model";
import {
  type Template,
  type ColorGradient,
  GradientText,
  TemplateSuggestions,
  LoadingNode,
  type LoadingNodeViewMount,
  type LoadingNodeViewState,
  plainTextToTipTapHtml,
  plainTextToSlice,
  getEditorText,
  tokenizePrompt,
  FileImport,
  type FileImportOptions,
} from "@pixerate/editor";
import { createSvelteLoadingNodeView } from "./loading-node/index.js";

type MaybeGetter<T> = T | (() => T);
const read = <T>(value: MaybeGetter<T>): T =>
  typeof value === "function" ? (value as () => T)() : value;

export interface UsePromptEditorProps {
  /**
   * The editor content as plain text. Changes from the parent (e.g. clearing
   * after submit) are applied to the editor; echoes of the editor's own
   * updates via `onContentChange` are ignored.
   */
  content: string;
  /** Callback fired when the editor content changes (returns plain text) */
  onContentChange: (text: string) => void;
  /** Optional DOM element to mount the editor into */
  element?: HTMLElement;
  /** List of available templates to be suggested and highlighted */
  templates?: Template[];
  /** Custom gradient color map for templates */
  templateColorMap?: Map<string, ColorGradient>;
  /** Whether the editor is editable */
  isEditing?: boolean;
  /** Placeholder text for the editor */
  placeholder?: string;
  /** Additional CSS classes for the editor container */
  className?: string;
  /** Callback fired when the Escape key is pressed */
  onEscape?: () => void;
  /** Custom keydown handler. Return true to prevent default behavior */
  onKeyDown?: (event: KeyboardEvent) => boolean;
  /** Callback fired when text selection changes */
  onSelectionChange?: (selection: { from: number; to: number } | null) => void;
  /** Callback fired when a slash command (e.g., /template) matches */
  onSlashCommandMatch?: (
    match: RegExpMatchArray,
    from: number,
    to: number,
    coords: { top: number; left: number },
  ) => void;
  /** Callback to dismiss/clear the active slash command */
  clearSlashCommand?: () => void;
  /** Whether a slash command menu is currently active */
  slashCommandActive?: boolean;
  /**
   * Callback fired the first time each milestone is reached while the editor
   * is mounted: `used_variable` ({variable}) and `used_magic` (__instruction__).
   */
  onMilestone?: (milestone: string) => void;
  /** DOM element ID of the container, used for positioning popovers */
  containerId?: string;
  /** Variable names originating from structured JSON output steps */
  jsonVariables?: string[];
  /** Animation speed for gradient decorations */
  speed?: number;
  /**
   * Import text from .md, .html, .txt and .rtf files dropped onto the editor
   * (opt-in). Content is always inserted as plain text. Pasting keeps the
   * plain-text paste handler, so pasted files are not imported.
   */
  fileImport?: Omit<FileImportOptions, "asPlainText"> | boolean;
  /**
   * Svelte component drawn inside each `loadingNode` placeholder instead of the default SVG spinner,
   * e.g. your design system's loader. It receives `view` (`id`, `label`). Read when a
   * placeholder renders, so changing it does not recreate the editor.
   */
  loadingIndicator?: Component<{ view: LoadingNodeViewState }>;
  /** Accessible label of loading placeholders, announced by screen readers (default `"Loading…"`). */
  loadingLabel?: string;
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

const DEFAULT_TEMPLATES: Template[] = [];
const DEFAULT_COLOR_MAP = new Map<string, ColorGradient>([
  ["default", { from: "#f43f5e", to: "#8b5cf6" }],
]);
const DEFAULT_CLASS_NAME =
  "w-full border border-input rounded-md p-3 font-mono text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary whitespace-pre-wrap break-words";

const normalizeNewlines = (text: string) => text.replace(/\r\n?/g, "\n");

const StarterKitExt =
  (StarterKit as any)?.configure
    ? StarterKit
    : (StarterKit as any)?.default?.configure
      ? (StarterKit as any)?.default
      : StarterKit;

const PlaceholderExt =
  (Placeholder as any)?.configure
    ? Placeholder
    : (Placeholder as any)?.default?.configure
      ? (Placeholder as any)?.default
      : Placeholder;

function resolveTemplateColorMap(
  templates: Template[],
  userColorMap?: Map<string, ColorGradient>,
): Map<string, ColorGradient> {
  if (userColorMap) return userColorMap;
  const map = new Map<string, ColorGradient>();
  templates.forEach((t) => {
    map.set(t.name, { from: "#f43f5e", to: "#8b5cf6" });
  });
  return map.size > 0 ? map : DEFAULT_COLOR_MAP;
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

  // One node view function for the editor's lifetime so swapping indicator components
  // does not recreate the editor.
  const dynamicLoadingNodeView: LoadingNodeViewMount = (dom, state) => {
    const Comp = latestProps.loadingIndicator;
    if (!Comp) return {};
    return createSvelteLoadingNodeView(Comp)(dom, state);
  };

  function buildEditor(p: UsePromptEditorProps): Editor {
    const templates = p.templates ?? DEFAULT_TEMPLATES;
    const isEditing = p.isEditing ?? true;
    const placeholder =
      p.placeholder ?? "Write a prompt, use {{template}}, {variable}, or /command...";
    const speed = p.speed ?? 2;
    const fileImportEnabled = !!p.fileImport;
    const hasLoadingIndicator = !!p.loadingIndicator;
    const resolvedColorMap = resolveTemplateColorMap(templates, p.templateColorMap);

    const ed = new Editor({
      element: p.element ?? mountedElement,
      enablePasteRules: false,
      enableInputRules: false,
      editable: isEditing,
      extensions: [
        StarterKitExt.configure({
          heading: false,
          codeBlock: false,
        }),
        PlaceholderExt.configure({ placeholder }),
        GradientText.configure({
          templateColorMap: resolvedColorMap,
          speed,
          jsonVariables: p.jsonVariables,
        }),
        TemplateSuggestions.configure({
          templates,
        }),
        LoadingNode.configure({
          nodeView: hasLoadingIndicator ? dynamicLoadingNodeView : null,
          ...(p.loadingLabel ? { label: p.loadingLabel } : {}),
        }),
        ...(fileImportEnabled
          ? [
              FileImport.configure({
                ...(typeof p.fileImport === "object" ? p.fileImport : {}),
                asPlainText: true,
              }),
            ]
          : []),
      ],
      content: plainTextToTipTapHtml(p.content),
      onUpdate: ({ editor: active }) => {
        const plainText = getEditorText(active);
        latestProps.onContentChange?.(plainText);

        if (latestProps.onMilestone) {
          for (const token of tokenizePrompt(plainText)) {
            const milestone =
              token.type === "variable"
                ? "used_variable"
                : token.type === "instruction"
                  ? "used_magic"
                  : null;
            if (milestone && !reachedMilestones.has(milestone)) {
              reachedMilestones.add(milestone);
              latestProps.onMilestone(milestone);
            }
          }
        }

        const { state, view } = active;
        const { selection } = state;
        const { $from: resolvedFrom, from, to } = selection;

        latestProps.onSelectionChange?.({ from, to });

        if (latestProps.onSlashCommandMatch && latestProps.clearSlashCommand) {
          const textBeforeCursor = resolvedFrom?.parent?.textBetween
            ? resolvedFrom.parent.textBetween(0, resolvedFrom.parentOffset)
            : "";
          const slashMatch = textBeforeCursor.match(
            /(?:^|\s)\/([a-zA-Z0-9_-]*)$/,
          );

          if (slashMatch) {
            const coords = view.coordsAtPos(resolvedFrom.pos);
            const containerId = latestProps.containerId ?? "editor-container";
            const containerEl =
              document.getElementById(containerId) ||
              document.getElementById("editor-container") ||
              (view.dom.closest?.(".relative") as HTMLElement | null);
            const containerCoords = containerEl?.getBoundingClientRect();

            if (containerCoords) {
              latestProps.onSlashCommandMatch(
                slashMatch,
                resolvedFrom.pos -
                  slashMatch[0].length +
                  (slashMatch[0].startsWith(" ") ? 1 : 0),
                resolvedFrom.pos,
                {
                  top: coords.bottom - containerCoords.top + 5,
                  left: coords.left - containerCoords.left,
                },
              );
            }
          } else {
            latestProps.clearSlashCommand();
          }
        }
      },
      onSelectionUpdate: ({ editor: active }) => {
        const { from, to } = active.state.selection;
        latestProps.onSelectionChange?.({ from, to });
      },
      editorProps: {
        attributes: {
          class: p.className || DEFAULT_CLASS_NAME,
          role: "textbox",
          "aria-label": "Prompt editor",
        },
        handleKeyDown(_view, event) {
          if (latestProps.slashCommandActive) {
            if (
              event.key === "ArrowUp" ||
              event.key === "ArrowDown" ||
              event.key === "Enter"
            ) {
              event.preventDefault();
              return true;
            }
            if (event.key === "Escape") {
              latestProps.clearSlashCommand?.();
              event.preventDefault();
              event.stopPropagation();
              return true;
            }
          }
          if (latestProps.onKeyDown && latestProps.onKeyDown(event as KeyboardEvent)) {
            return true;
          }
          if (event.key === "Escape" && latestProps.onEscape) {
            latestProps.onEscape();
            return true;
          }
          return false;
        },
        handlePaste: (view, event) => {
          // Paste as plain text even when the clipboard also carries HTML.
          const text = event.clipboardData?.getData("text/plain");
          if (!text) return false;
          event.preventDefault();
          const schema = view.state.schema;
          if (!schema) return false;
          view.dispatch(
            view.state.tr.replaceSelection(plainTextToSlice(text, schema)),
          );
          return true;
        },
        clipboardTextParser: (text, context, _plain, view) => {
          const schema =
            (context as any)?.doc?.type?.schema ||
            (context as any)?.schema ||
            view?.state?.schema;

          if (!schema) return Slice.empty;
          return plainTextToSlice(text, schema);
        },
      },
    });

    return ed;
  }

  function computeConfigKey(p: UsePromptEditorProps): string {
    const templates = p.templates ?? DEFAULT_TEMPLATES;
    const templateKey = templates
      .map((t) => `${t.id || t.name}:${(t as any).latestVersion || ""}`)
      .sort()
      .join(",");
    const colorMapKey = p.templateColorMap
      ? JSON.stringify(Array.from(p.templateColorMap.entries()))
      : "";
    const jsonVariablesKey = (p.jsonVariables ?? []).join("\u0000");
    const speed = p.speed ?? 2;
    const fileImportEnabled = !!p.fileImport;
    const hasLoadingIndicator = !!p.loadingIndicator;
    const loadingLabel = p.loadingLabel ?? "";
    return JSON.stringify([
      colorMapKey,
      templateKey,
      speed,
      jsonVariablesKey,
      fileImportEnabled,
      hasLoadingIndicator,
      loadingLabel,
    ]);
  }

  function syncProps(p: UsePromptEditorProps) {
    latestProps = p;
    const nextKey = computeConfigKey(p);

    if (!currentEditor || currentEditor.isDestroyed || currentConfigKey !== nextKey) {
      currentEditor?.destroy();
      currentConfigKey = nextKey;
      currentEditor = buildEditor(p);
      editorState = currentEditor;
      return;
    }

    const isEditing = p.isEditing ?? true;
    if (currentEditor.isEditable !== isEditing) {
      currentEditor.setEditable(isEditing);
    }

    if (normalizeNewlines(p.content) !== getEditorText(currentEditor)) {
      const { from, to } = currentEditor.state.selection;
      currentEditor.commands.setContent(plainTextToTipTapHtml(p.content), false);
      const max = currentEditor.state.doc.content.size;
      currentEditor.commands.setTextSelection({
        from: Math.min(from, max),
        to: Math.min(to, max),
      });
    }

    const nextClass = p.className || DEFAULT_CLASS_NAME;
    const currentClass = (
      currentEditor.options.editorProps?.attributes as Record<string, string> | undefined
    )?.class;
    if (currentClass !== nextClass) {
      currentEditor.setOptions({
        editorProps: {
          ...currentEditor.options.editorProps,
          attributes: {
            ...(currentEditor.options.editorProps.attributes as Record<string, string>),
            class: nextClass,
          },
        },
      });
    }

    const placeholder =
      p.placeholder ?? "Write a prompt, use {{template}}, {variable}, or /command...";
    const placeholderExt = currentEditor.extensionManager.extensions.find(
      (ext) => ext.name === "placeholder",
    );
    if (placeholderExt && placeholderExt.options.placeholder !== placeholder) {
      placeholderExt.options.placeholder = placeholder;
      currentEditor.view.dispatch(currentEditor.state.tr);
    }
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
