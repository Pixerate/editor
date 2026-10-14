import React, { useState } from "react";
import type { Editor } from "@tiptap/core";
import { useTableMenu } from "./useTableMenu";

export interface InsertTableGridProps {
  editor: Editor | null;
  /** Grid size offered (default 8 × 8). */
  rows?: number;
  cols?: number;
  /** Insert with a header row (default `true`). */
  withHeaderRow?: boolean;
  className?: string;
  cellClassName?: string;
  activeCellClassName?: string;
  /** Called after a table was inserted. */
  onInsert?: (size: { rows: number; cols: number }) => void;
}

const keepSelection = (event: React.MouseEvent) => event.preventDefault();

/**
 * Word-style insert-table picker: hover (or focus) a cell of the grid to
 * choose the size, click to insert a table of that size at the cursor. The
 * grid is disabled (with the reason as its title) where a table cannot be
 * inserted, e.g. inside another table.
 */
export const InsertTableGrid: React.FC<InsertTableGridProps> = ({
  editor,
  rows = 8,
  cols = 8,
  withHeaderRow = true,
  className = "inline-flex flex-col gap-1 rounded-md border border-border bg-background p-2 text-xs shadow-md",
  cellClassName = "h-4 w-4 rounded-sm border border-border bg-background disabled:opacity-40",
  activeCellClassName = "border-primary bg-primary/20",
  onInsert,
}) => {
  const table = useTableMenu(editor);
  const [hover, setHover] = useState<{ rows: number; cols: number } | null>(null);
  const status = table.actions.insertTable;
  const disabled = !editor || !status.enabled;

  const insert = (size: { rows: number; cols: number }) => {
    if (table.run("insertTable", { ...size, withHeaderRow })) onInsert?.(size);
    setHover(null);
  };

  return (
    <div
      className={className}
      role="group"
      aria-label="Insert table"
      title={disabled ? status.reason : undefined}
      data-insert-table-grid=""
      onMouseLeave={() => setHover(null)}
    >
      <div
        role="grid"
        aria-label="Table size"
        style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, max-content)`, gap: 2 }}
      >
        {Array.from({ length: rows * cols }, (_, i) => {
          const size = { rows: Math.floor(i / cols) + 1, cols: (i % cols) + 1 };
          const active = !!hover && size.rows <= hover.rows && size.cols <= hover.cols;
          return (
            <button
              key={i}
              type="button"
              data-rows={size.rows}
              data-cols={size.cols}
              data-active={active}
              aria-label={`${size.rows} × ${size.cols} table`}
              disabled={disabled}
              className={active ? `${cellClassName} ${activeCellClassName}` : cellClassName}
              onMouseDown={keepSelection}
              onMouseEnter={() => setHover(size)}
              onFocus={() => setHover(size)}
              onClick={() => insert(size)}
            />
          );
        })}
      </div>
      <div aria-live="polite" data-testid="insert-table-size">
        {disabled ? status.reason : hover ? `${hover.rows} × ${hover.cols}` : "Insert table"}
      </div>
    </div>
  );
};
