import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BubbleMenuPlugin,
  type BubbleMenuPluginProps,
} from "@tiptap/extension-bubble-menu";
import type { Editor } from "@tiptap/core";

export interface BubbleMenuProps {
  editor: Editor | null;
  className?: string;
  children: React.ReactNode;
  /**
   * Floating UI options: placement, offset, flip, shift and the rest (TipTap v3;
   * replaces v2's `tippyOptions`). Default `{}`.
   */
  options?: BubbleMenuPluginProps["options"];
  /** Where to append the menu (default: the editor's parent element). */
  appendTo?: BubbleMenuPluginProps["appendTo"];
  shouldShow?: BubbleMenuPluginProps["shouldShow"];
  pluginKey?: BubbleMenuPluginProps["pluginKey"];
  updateDelay?: BubbleMenuPluginProps["updateDelay"];
}

export const BubbleMenu: React.FC<BubbleMenuProps> = ({
  editor,
  className = "flex items-center gap-1 bg-popover text-popover-foreground border shadow-md rounded-md p-1",
  children,
  options,
  appendTo,
  shouldShow = null,
  pluginKey = "bubbleMenu",
  updateDelay,
}) => {
  const menuEl = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);

  if (!menuEl.current && typeof document !== "undefined") {
    menuEl.current = document.createElement("div");
  }

  useEffect(() => {
    if (!editor || !menuEl.current || editor.isDestroyed) {
      return;
    }

    const element = menuEl.current;
    element.className = className;

    const plugin = BubbleMenuPlugin({
      editor,
      element,
      pluginKey,
      options,
      appendTo,
      shouldShow,
      updateDelay,
    });

    editor.registerPlugin(plugin);
    setMounted(true);

    return () => {
      setMounted(false);
      editor.unregisterPlugin(pluginKey);
      if (element.parentNode) {
        element.parentNode.removeChild(element);
      }
    };
  }, [editor, className, pluginKey]);

  if (!editor || !menuEl.current || !mounted) {
    return null;
  }

  return createPortal(children, menuEl.current);
};
