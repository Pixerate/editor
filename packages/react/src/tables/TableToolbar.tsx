import React from "react";
import type { Editor } from "@tiptap/core";
import { DEFAULT_TABLE_TOOLBAR, type TableToolbarItem } from "@pixerate/editor";
import { useTableMenu } from "./useTableMenu";

export interface TableToolbarProps {
  editor: Editor | null;
  /** Buttons to show (default `DEFAULT_TABLE_TOOLBAR`). */
  items?: readonly TableToolbarItem[];
  /** Render (with disabled buttons) when the selection is not in a table. Default `false`. */
  showWhenOutside?: boolean;
  className?: string;
  buttonClassName?: string;
  activeButtonClassName?: string;
  separatorClassName?: string;
  /** Called after a button ran its action. */
  onAction?: (item: TableToolbarItem) => void;
}

const keepSelection = (event: React.MouseEvent) => event.preventDefault();

/**
 * Table toolbar: insert/delete rows and columns, merge/split cells, header
 * toggles, cell alignment and delete table. Rendered only while the
 * selection is in a table (unless `showWhenOutside`); disabled buttons say
 * why in their tooltip. Use it inline, or inside `TableBubbleMenu`.
 */
export const TableToolbar: React.FC<TableToolbarProps> = ({
  editor,
  items = DEFAULT_TABLE_TOOLBAR,
  showWhenOutside = false,
  className = "flex flex-wrap items-center gap-1 text-xs",
  buttonClassName = "rounded px-2 py-1 text-foreground hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent",
  activeButtonClassName = "bg-primary/10 text-primary",
  separatorClassName = "mx-1 h-4 w-px bg-border",
  onAction,
}) => {
  const table = useTableMenu(editor);
  if (!editor || (!table.inTable && !showWhenOutside)) return null;

  return (
    <div className={className} role="toolbar" aria-label="Table" data-table-toolbar="">
      {items.map((item, index) => {
        const status = table.check(item.action, item.params);
        const enabled = status === true;
        const active = item.active?.(table);
        const separator = index > 0 && items[index - 1].group !== item.group;
        return (
          <React.Fragment key={item.id}>
            {separator && <span className={separatorClassName} aria-hidden="true" />}
            <button
              type="button"
              data-action={item.id}
              aria-label={item.title}
              title={enabled ? item.title : `${item.title}: ${status}`}
              {...(item.active ? { "aria-pressed": !!active } : {})}
              disabled={!enabled}
              className={active ? `${buttonClassName} ${activeButtonClassName}` : buttonClassName}
              onMouseDown={keepSelection}
              onClick={() => {
                if (table.run(item.action, item.params)) onAction?.(item);
              }}
            >
              {item.label}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
};
