import { useMemo, useEffect, useRef } from "react";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Slice, Fragment, Node as ProsemirrorNode } from "@tiptap/pm/model";
import {
  Template,
  ColorGradient,
  GradientText,
  TemplateSuggestions,
  LoadingNode,
  plainTextToTipTapHtml,
  getEditorText,
} from "@pixerate/editor";

export interface UsePromptEditorProps {
  /** The initial or controlled content of the editor as plain text */
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
  /** Callback fired when certain milestones are reached (e.g., used_variable, used_magic) */
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

  const resolvedColorMap = useMemo(() => {
    if (userColorMap) return userColorMap;
    const map = new Map<string, ColorGradient>();
    templates.forEach((t) => {
      map.set(t.name, { from: "#f43f5e", to: "#8b5cf6" });
    });
    return map.size > 0 ? map : DEFAULT_COLOR_MAP;
  }, [userColorMap, templates]);

  const editor = useEditor(
    {
      immediatelyRender: false,
      enablePasteRules: false,
      enableInputRules: false,
      editable: isEditing,
      extensions: [
        StarterKit.configure({
          heading: false,
          codeBlock: false,
        }),
        Placeholder.configure({ placeholder }),
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
          if (plainText.match(/(?<!\{)\{([^{}]+)\}(?!\})/g)) {
            onMilestoneRef.current("used_variable");
          }
          if (plainText.match(/__([^_]+)__/g)) {
            onMilestoneRef.current("used_magic");
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
          class:
            className ||
            "w-full border border-input rounded-md p-3 font-mono text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary whitespace-pre-wrap break-words",
        },
        handleKeyDown: (view, event) => {
          if (event.key === "Escape" && onEscapeRef.current) {
            onEscapeRef.current();
            return true;
          }
          if (onKeyDownRef.current) {
            return onKeyDownRef.current(event);
          }
          return false;
        },
        clipboardTextParser: (text, context, _plain, view) => {
          const schema =
            (context as any)?.doc?.type?.schema ||
            (context as any)?.schema ||
            view?.state?.schema;

          if (!schema) return Slice.empty;

          const blocks = text.replace(/\r\n?/g, "\n").split("\n");
          const nodes: ProsemirrorNode[] = [];

          blocks.forEach((line) => {
            const nodeJson: any = { type: "paragraph" };
            if (line.length > 0) {
              nodeJson.content = [{ type: "text", text: line }];
            }
            try {
              const node = ProsemirrorNode.fromJSON(schema, nodeJson);
              nodes.push(node);
            } catch {
              // Ignore
            }
          });

          return Slice.maxOpen(Fragment.fromArray(nodes));
        },
      },
    },
    [templates, resolvedColorMap, isEditing, placeholder, speed],
  );

  return editor;
}
