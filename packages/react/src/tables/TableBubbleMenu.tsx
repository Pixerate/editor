import React from "react";
import type { Editor } from "@tiptap/core";
import { shouldShowTableBubbleMenu } from "@pixerate/editor";
import { BubbleMenu, type BubbleMenuProps } from "../components/BubbleMenu";
import { TableToolbar, type TableToolbarProps } from "./TableToolbar";

export interface TableBubbleMenuProps
  extends Omit<BubbleMenuProps, "editor" | "children" | "shouldShow"> {
  editor: Editor | null;
  /** Custom content (default: a `TableToolbar`). */
  children?: React.ReactNode;
  /** Props for the default `TableToolbar`. */
  toolbarProps?: Omit<TableToolbarProps, "editor">;
}

/**
 * A bubble menu that follows the selection while it is in a table (even a
 * collapsed cursor), with the table toolbar or your own `children`. It uses
 * its own plugin key (`tableBubbleMenu`), so it can be combined with the
 * formatting `BubbleMenu`.
 */
export const TableBubbleMenu: React.FC<TableBubbleMenuProps> = ({
  editor,
  children,
  toolbarProps,
  pluginKey = "tableBubbleMenu",
  ...rest
}) => (
  <BubbleMenu editor={editor} pluginKey={pluginKey} shouldShow={shouldShowTableBubbleMenu as BubbleMenuProps["shouldShow"]} {...rest}>
    {children ?? <TableToolbar editor={editor} {...toolbarProps} />}
  </BubbleMenu>
);
