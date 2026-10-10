import { useMemo, useEffect, useRef } from "react";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Slice } from "@tiptap/pm/model";
import {
  Template,
  ColorGradient,
  GradientText,
  TemplateSuggestions,
  LoadingNode,
  plainTextToTipTapHtml,
  plainTextToSlice,
  getEditorText,
  tokenizePrompt,
} from "@pixerate/editor";

export interface UsePromptEditorProps {
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
}

const DEFAULT_TEMPLATES: Template[] = [];
const DEFAULT_COLOR_MAP = new Map<string, ColorGradient>([
  ["default", { from: "#f43f5e", to: "#8b5cf6" }],
]);
const DEFAULT_CLASS_NAME =
  "w-full border border-input rounded-md p-3 font-mono text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary whitespace-pre-wrap break-words";

const normalizeNewlines = (text: string) => text.replace(/\r\n?/g, "\n");

export function usePromptEditor({
  content,
  onContentChange,
  templates = DEFAULT_TEMPLATES,
  templateColorMap: userColorMap,
  isEditing = true,
  placeholder = "Write a prompt, use {{template}}, {variable}, or /command...",
  className,
  onEscape,
  onKeyDown,
  onSelectionChange,
  onSlashCommandMatch,
  clearSlashCommand,
  slashCommandActive = false,
  onMilestone,
  containerId = "editor-container",
  jsonVariables,
  speed = 2,
}: UsePromptEditorProps) {
  const slashCommandActiveRef = useRef(slashCommandActive);
  slashCommandActiveRef.current = slashCommandActive;

  const clearSlashCommandRef = useRef(clearSlashCommand);
  clearSlashCommandRef.current = clearSlashCommand;

  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  const onKeyDownRef = useRef(onKeyDown);
  onKeyDownRef.current = onKeyDown;

  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;

  const onSlashCommandMatchRef = useRef(onSlashCommandMatch);
  onSlashCommandMatchRef.current = onSlashCommandMatch;

  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;

  const onMilestoneRef = useRef(onMilestone);
  onMilestoneRef.current = onMilestone;

  const containerIdRef = useRef(containerId);
  containerIdRef.current = containerId;

  const templateKey = useMemo(() => {
    return (templates || [])
      .map((t) => `${t.id || t.name}:${(t as any).latestVersion || ""}`)
      .sort()
      .join(",");
  }, [templates]);

  // Key the color map by value so an inline `new Map(...)` does not recreate
  // the editor on every render.
  const colorMapKey = userColorMap
    ? JSON.stringify(Array.from(userColorMap.entries()))
    : "";
  const resolvedColorMap = useMemo(() => {
    if (userColorMap) return userColorMap;
    const map = new Map<string, ColorGradient>();
    templates.forEach((t) => {
      map.set(t.name, { from: "#f43f5e", to: "#8b5cf6" });
    });
    return map.size > 0 ? map : DEFAULT_COLOR_MAP;
  }, [colorMapKey, templateKey]);

  const jsonVariablesKey = (jsonVariables || []).join("\u0000");

  const reachedMilestonesRef = useRef(new Set<string>());

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

  const editor = useEditor(
    {
      immediatelyRender: false,
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
          jsonVariables,
        }),
        TemplateSuggestions.configure({
          templates,
        }),
        LoadingNode,
      ],
      content: plainTextToTipTapHtml(content),
      onUpdate: ({ editor: ed }) => {
        const plainText = getEditorText(ed);
        onContentChangeRef.current?.(plainText);

        if (onMilestoneRef.current) {
          const reached = reachedMilestonesRef.current;
          for (const token of tokenizePrompt(plainText)) {
            const milestone =
              token.type === "variable"
                ? "used_variable"
                : token.type === "instruction"
                  ? "used_magic"
                  : null;
            if (milestone && !reached.has(milestone)) {
              reached.add(milestone);
              onMilestoneRef.current(milestone);
            }
          }
        }

        const { state, view } = ed;
        const { selection } = state;
        const { $from, from, to } = selection;

        onSelectionChangeRef.current?.({ from, to });

        if (onSlashCommandMatchRef.current && clearSlashCommandRef.current) {
          const textBeforeCursor = $from?.parent?.textBetween
            ? $from.parent.textBetween(0, $from.parentOffset)
            : "";
          const slashMatch = textBeforeCursor.match(
            /(?:^|\s)\/([a-zA-Z0-9_-]*)$/,
          );

          if (slashMatch) {
            const coords = view.coordsAtPos($from.pos);
            const containerEl =
              document.getElementById(containerIdRef.current) ||
              document.getElementById("editor-container") ||
              (view.dom.closest?.(".relative") as HTMLElement | null);
            const containerCoords = containerEl?.getBoundingClientRect();

            if (containerCoords) {
              onSlashCommandMatchRef.current(
                slashMatch,
                $from.pos -
                  slashMatch[0].length +
                  (slashMatch[0].startsWith(" ") ? 1 : 0),
                $from.pos,
                {
                  top: coords.bottom - containerCoords.top + 5,
                  left: coords.left - containerCoords.left,
                },
              );
            }
          } else {
            clearSlashCommandRef.current();
          }
        }
      },
      onSelectionUpdate: ({ editor: ed }) => {
        const { from, to } = ed.state.selection;
        onSelectionChangeRef.current?.({ from, to });
      },
      editorProps: {
        attributes: {
          class: className || DEFAULT_CLASS_NAME,
          role: "textbox",
          "aria-label": "Prompt editor",
        },
        handleKeyDown(view, event) {
          if (slashCommandActiveRef.current) {
            if (
              event.key === "ArrowUp" ||
              event.key === "ArrowDown" ||
              event.key === "Enter"
            ) {
              event.preventDefault();
              return true;
            }
            if (event.key === "Escape") {
              clearSlashCommandRef.current?.();
              event.preventDefault();
              event.stopPropagation();
              return true;
            }
          }
          if (onKeyDownRef.current && onKeyDownRef.current(event as KeyboardEvent)) {
            return true;
          }
          if (event.key === "Escape" && onEscapeRef.current) {
            onEscapeRef.current();
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
    },
    // Only options baked into extensions recreate the editor; editable state,
    // placeholder, class names and content are applied to the live instance.
    [resolvedColorMap, templateKey, speed, jsonVariablesKey],
  );

  useEffect(() => {
    if (editor && !editor.isDestroyed) {
      editor.setEditable(isEditing);
    }
  }, [editor, isEditing]);

  // Apply content changes made by the parent (e.g. clearing after submit).
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (normalizeNewlines(content) === getEditorText(editor)) return;
    const { from, to } = editor.state.selection;
    editor.commands.setContent(plainTextToTipTapHtml(content), false);
    const max = editor.state.doc.content.size;
    editor.commands.setTextSelection({
      from: Math.min(from, max),
      to: Math.min(to, max),
    });
  }, [editor, content]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        attributes: {
          ...(editor.options.editorProps.attributes as Record<string, string>),
          class: className || DEFAULT_CLASS_NAME,
        },
      },
    });
  }, [editor, className]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const placeholderExt = editor.extensionManager.extensions.find(
      (ext) => ext.name === "placeholder",
    );
    if (!placeholderExt || placeholderExt.options.placeholder === placeholder) {
      return;
    }
    placeholderExt.options.placeholder = placeholder;
    // Re-run decorations so the new placeholder renders.
    editor.view.dispatch(editor.state.tr);
  }, [editor, placeholder]);

  return editor;
}
