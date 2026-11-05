import type { Editor, EditorOptions } from "@tiptap/core";
import * as _StarterKit from "@tiptap/starter-kit";
import * as _Placeholder from "@tiptap/extension-placeholder";
import { Slice } from "@tiptap/pm/model";
import type { ColorGradient, Template } from "../grammar/tokens";
import { tokenizePrompt } from "../grammar/tokenizer";
import { getEditorText, plainTextToSlice, plainTextToTipTapHtml } from "../serializers/plain-text";
import { GradientText } from "./gradient-text";
import { TemplateSuggestions } from "./template-suggestions";
import { LoadingNode, type LoadingNodeViewMount } from "./loading-node";
import { FileImport, type FileImportOptions } from "./file-import";

const resolveExt = (mod: any, name: string) =>
  mod?.[name]?.configure
    ? mod[name]
    : mod?.default?.configure
      ? mod.default
      : mod?.default?.[name]?.configure
        ? mod.default[name]
        : mod?.default?.default ?? mod?.default ?? mod;

const StarterKit = resolveExt(_StarterKit, "StarterKit");
const Placeholder = resolveExt(_Placeholder, "Placeholder");

/**
 * The framework-independent options of a prompt editor: the plain-text editor behind React's
 * and Svelte's `usePromptEditor`. The framework bindings add their own `loadingIndicator`
 * component on top and pass its node view to `createPromptEditorOptions`.
 */
export interface PromptEditorConfig {
  /**
   * The editor content as plain text. Changes from the parent (e.g. clearing
   * after submit) are applied to the editor; echoes of the editor's own
   * updates via `onContentChange` are ignored.
   */
  content: string;
  /** Callback fired when the editor content changes (returns plain text) */
  onContentChange: (text: string) => void;
  /** List of available templates to be suggested and highlighted */
  templates?: Template[];
  /** Custom gradient color map for templates */
  templateColorMap?: Map<string, ColorGradient>;
  /** Whether the editor is editable (default `true`) */
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
  /** DOM element ID of the container, used for positioning popovers (default `"editor-container"`) */
  containerId?: string;
  /** Variable names originating from structured JSON output steps */
  jsonVariables?: string[];
  /** Animation speed for gradient decorations (default `2`) */
  speed?: number;
  /**
   * Import text from .md, .html, .txt and .rtf files dropped onto the editor
   * (opt-in). Content is always inserted as plain text. Pasting keeps the
   * plain-text paste handler, so pasted files are not imported.
   */
  fileImport?: Omit<FileImportOptions, "asPlainText"> | boolean;
  /** Accessible label of loading placeholders, announced by screen readers (default `"Loading…"`). */
  loadingLabel?: string;
}

export interface PromptEditorOptionsExtras {
  /** Node view drawing a framework loading indicator inside `loadingNode` placeholders. */
  loadingNodeView?: LoadingNodeViewMount | null;
  /**
   * Milestones already reported. Pass the same set for the binding's lifetime so a recreated
   * editor does not report them again (default: a new set per call).
   */
  reachedMilestones?: Set<string>;
}

export const PROMPT_EDITOR_DEFAULT_PLACEHOLDER =
  "Write a prompt, use {{template}}, {variable}, or /command...";
export const PROMPT_EDITOR_DEFAULT_CLASS_NAME =
  "w-full border border-input rounded-md p-3 font-mono text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary whitespace-pre-wrap break-words";

const DEFAULT_TEMPLATES: Template[] = [];
const DEFAULT_GRADIENT: ColorGradient = { from: "#f43f5e", to: "#8b5cf6" };
const SLASH_COMMAND_PATTERN = /(?:^|\s)\/([a-zA-Z0-9_-]*)$/;

const normalizeNewlines = (text: string) => text.replace(/\r\n?/g, "\n");

/** The gradient map a prompt editor uses: the caller's, else one default gradient per template. */
export function resolvePromptTemplateColorMap(
  templates: Template[] = DEFAULT_TEMPLATES,
  userColorMap?: Map<string, ColorGradient>,
): Map<string, ColorGradient> {
  if (userColorMap) return userColorMap;
  const map = new Map<string, ColorGradient>();
  templates.forEach((t) => map.set(t.name, DEFAULT_GRADIENT));
  return map.size > 0 ? map : new Map([["default", DEFAULT_GRADIENT]]);
}

/**
 * A key of the options that are baked into the prompt editor's extensions. Bindings recreate
 * the editor only when it changes; content, editability, placeholder and class names are applied
 * to the live editor by `syncPromptEditor`. The color map and templates are keyed by value, so an
 * inline `new Map(...)` does not recreate the editor on every render.
 */
export function promptEditorConfigKey(
  config: PromptEditorConfig,
  extras: { hasLoadingNodeView?: boolean } = {},
): string {
  const templateKey = (config.templates ?? DEFAULT_TEMPLATES)
    .map((t) => `${t.id || t.name}:${(t as any).latestVersion || ""}`)
    .sort()
    .join(",");
  const colorMapKey = config.templateColorMap
    ? JSON.stringify(Array.from(config.templateColorMap.entries()))
    : "";
  return JSON.stringify([
    colorMapKey,
    templateKey,
    config.speed ?? 2,
    (config.jsonVariables ?? []).join("\u0000"),
    !!config.fileImport,
    !!extras.hasLoadingNodeView,
    config.loadingLabel ?? "",
  ]);
}

/** The milestones reached by `text`: `used_variable` for `{variable}`, `used_magic` for `__instruction__`. */
export function promptMilestones(text: string): string[] {
  const found = new Set<string>();
  for (const token of tokenizePrompt(text)) {
    if (token.type === "variable") found.add("used_variable");
    else if (token.type === "instruction") found.add("used_magic");
  }
  return [...found];
}

/**
 * TipTap `Editor` options for a plain-text prompt editor: gradient tokens, `{{template}}`
 * autocomplete, `loadingNode` placeholders, optional file import, `/command` matching with
 * keyboard capture while a menu is open, milestone tracking and plain-text clipboard handling.
 *
 * Callbacks are read through `getConfig()` when they fire, so the latest handlers are used
 * without recreating the editor. Everything else is read once here.
 */
export function createPromptEditorOptions(
  getConfig: () => PromptEditorConfig,
  extras: PromptEditorOptionsExtras = {},
): Partial<EditorOptions> {
  const config = getConfig();
  const templates = config.templates ?? DEFAULT_TEMPLATES;
  const reached = extras.reachedMilestones ?? new Set<string>();
  const fileImport = config.fileImport;

  return {
    enablePasteRules: false,
    enableInputRules: false,
    editable: config.isEditing ?? true,
    extensions: [
      StarterKit.configure({ heading: false, codeBlock: false }),
      Placeholder.configure({ placeholder: config.placeholder ?? PROMPT_EDITOR_DEFAULT_PLACEHOLDER }),
      GradientText.configure({
        templateColorMap: resolvePromptTemplateColorMap(templates, config.templateColorMap),
        speed: config.speed ?? 2,
        jsonVariables: config.jsonVariables,
      }),
      TemplateSuggestions.configure({ templates }),
      LoadingNode.configure({
        nodeView: extras.loadingNodeView ?? null,
        ...(config.loadingLabel ? { label: config.loadingLabel } : {}),
      }),
      ...(fileImport
        ? [
            FileImport.configure({
              ...(typeof fileImport === "object" ? fileImport : {}),
              // Prompt editors only ever receive plain text.
              asPlainText: true,
            }),
          ]
        : []),
    ],
    content: plainTextToTipTapHtml(config.content),
    onUpdate: ({ editor }) => {
      const latest = getConfig();
      const plainText = getEditorText(editor);
      latest.onContentChange?.(plainText);

      if (latest.onMilestone) {
        for (const milestone of promptMilestones(plainText)) {
          if (reached.has(milestone)) continue;
          reached.add(milestone);
          latest.onMilestone(milestone);
        }
      }

      const { state, view } = editor;
      const { selection } = state;
      const resolvedFrom = selection.$from;
      const { from, to } = selection;

      latest.onSelectionChange?.({ from, to });

      if (latest.onSlashCommandMatch && latest.clearSlashCommand) {
        const textBeforeCursor = resolvedFrom?.parent?.textBetween
          ? resolvedFrom.parent.textBetween(0, resolvedFrom.parentOffset)
          : "";
        const slashMatch = textBeforeCursor.match(SLASH_COMMAND_PATTERN);

        if (slashMatch) {
          const coords = view.coordsAtPos(resolvedFrom.pos);
          const containerEl =
            document.getElementById(latest.containerId ?? "editor-container") ||
            document.getElementById("editor-container") ||
            (view.dom.closest?.(".relative") as HTMLElement | null);
          const containerCoords = containerEl?.getBoundingClientRect();

          if (containerCoords) {
            latest.onSlashCommandMatch(
              slashMatch,
              resolvedFrom.pos - slashMatch[0].length + (slashMatch[0].startsWith(" ") ? 1 : 0),
              resolvedFrom.pos,
              {
                top: coords.bottom - containerCoords.top + 5,
                left: coords.left - containerCoords.left,
              },
            );
          }
        } else {
          latest.clearSlashCommand();
        }
      }
    },
    onSelectionUpdate: ({ editor }) => {
      const { from, to } = editor.state.selection;
      getConfig().onSelectionChange?.({ from, to });
    },
    editorProps: {
      attributes: {
        class: config.className || PROMPT_EDITOR_DEFAULT_CLASS_NAME,
        role: "textbox",
        "aria-label": "Prompt editor",
      },
      handleKeyDown(_view, event) {
        const latest = getConfig();
        if (latest.slashCommandActive) {
          if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter") {
            event.preventDefault();
            return true;
          }
          if (event.key === "Escape") {
            latest.clearSlashCommand?.();
            event.preventDefault();
            event.stopPropagation();
            return true;
          }
        }
        if (latest.onKeyDown && latest.onKeyDown(event as KeyboardEvent)) {
          return true;
        }
        if (event.key === "Escape" && latest.onEscape) {
          latest.onEscape();
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
        view.dispatch(view.state.tr.replaceSelection(plainTextToSlice(text, schema)));
        return true;
      },
      clipboardTextParser: (text, context, _plain, view) => {
        const schema =
          (context as any)?.doc?.type?.schema || (context as any)?.schema || view?.state?.schema;
        if (!schema) return Slice.empty;
        return plainTextToSlice(text, schema);
      },
    },
  };
}

/**
 * Applies the live options of a prompt editor without recreating it: editability, content,
 * class names and placeholder.
 *
 * Content is applied only when `config.content` changed since `previous` (pass the config of the
 * last sync, or `undefined` for the first one) and differs from the editor's text, so an echo of
 * the editor's own `onContentChange` does not reset the document or the cursor, and an
 * unrelated prop change does not overwrite text the parent has not taken up yet.
 */
export function syncPromptEditor(
  editor: Editor,
  config: PromptEditorConfig,
  previous?: PromptEditorConfig,
): void {
  if (editor.isDestroyed) return;

  const isEditing = config.isEditing ?? true;
  if (editor.isEditable !== isEditing) editor.setEditable(isEditing);

  if (
    (!previous || previous.content !== config.content) &&
    normalizeNewlines(config.content) !== getEditorText(editor)
  ) {
    const { from, to } = editor.state.selection;
    editor.commands.setContent(plainTextToTipTapHtml(config.content), false);
    const max = editor.state.doc.content.size;
    editor.commands.setTextSelection({ from: Math.min(from, max), to: Math.min(to, max) });
  }

  const nextClass = config.className || PROMPT_EDITOR_DEFAULT_CLASS_NAME;
  const attributes = (editor.options.editorProps.attributes ?? {}) as Record<string, string>;
  if (attributes.class !== nextClass) {
    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        attributes: { ...attributes, class: nextClass },
      },
    });
  }

  const placeholder = config.placeholder ?? PROMPT_EDITOR_DEFAULT_PLACEHOLDER;
  const placeholderExt = editor.extensionManager.extensions.find((ext) => ext.name === "placeholder");
  if (placeholderExt && placeholderExt.options.placeholder !== placeholder) {
    placeholderExt.options.placeholder = placeholder;
    // Re-run decorations so the new placeholder renders.
    editor.view.dispatch(editor.state.tr);
  }
}
