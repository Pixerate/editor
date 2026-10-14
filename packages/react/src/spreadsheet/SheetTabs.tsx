import React, { useRef, useState } from 'react';
import { getSheetTabMenuItems, sheetDropIndex, type SpreadsheetMenuItem } from '@pixerate/editor/spreadsheet';
import type { useSpreadsheetEditor } from './useSpreadsheetEditor';
import { SpreadsheetContextMenu } from './SpreadsheetContextMenu';

export interface SheetTabsProps {
  state: ReturnType<typeof useSpreadsheetEditor>;
  readOnly?: boolean;
  className?: string;
}

/**
 * The workbook's sheet tabs: click to switch, double-click to rename, drag
 * to reorder, right-click for insert / rename / duplicate / move / delete
 * (delete asks to confirm), and a `+` button to add a sheet.
 */
export const SheetTabs: React.FC<SheetTabsProps> = ({ state, readOnly = false, className = '' }) => {
  const { controller, sheets } = state;
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: SpreadsheetMenuItem[] } | null>(null);
  const dragFrom = useRef<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{ index: number; after: boolean } | null>(null);

  const commitRename = (cancelOnError: boolean) => {
    if (!renaming) return;
    const sheet = sheets.find((s) => s.id === renaming.id);
    const name = renaming.draft.trim();
    if (!sheet || !name || name === sheet.name) {
      setRenaming(null);
      setError(null);
      return;
    }
    try {
      state.renameSheet(renaming.id, name);
      setRenaming(null);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? String(err));
      if (cancelOnError) setRenaming(null);
    }
  };

  const dropAfter = (e: React.DragEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientX > rect.left + rect.width / 2;
  };

  return (
    <div className={`flex flex-col ${className}`} data-sheet-tabs="">
      <div
        role="tablist"
        aria-label="Sheets"
        className="flex items-center gap-0.5 overflow-x-auto border-t border-border bg-muted px-1 py-1 text-xs"
      >
        {sheets.map((sheet, index) =>
          renaming?.id === sheet.id ? (
            <input
              key={sheet.id}
              aria-label="Sheet name"
              autoFocus
              className="w-32 rounded border border-primary bg-background px-2 py-0.5 text-xs outline-none"
              value={renaming.draft}
              onChange={(e) => setRenaming({ id: sheet.id, draft: e.target.value })}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') commitRename(false);
                else if (e.key === 'Escape') {
                  setRenaming(null);
                  setError(null);
                }
              }}
              onBlur={() => commitRename(true)}
            />
          ) : (
            <button
              key={sheet.id}
              type="button"
              role="tab"
              aria-selected={sheet.active}
              data-sheet-id={sheet.id}
              draggable={!readOnly}
              title={readOnly ? sheet.name : `${sheet.name} — double-click to rename, drag to move`}
              className={`whitespace-nowrap rounded px-3 py-0.5 ${
                sheet.active ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:bg-background/60'
              } ${dropTarget?.index === index ? (dropTarget.after ? 'border-r-2 border-primary' : 'border-l-2 border-primary') : ''}`}
              onClick={() => state.setActiveSheet(sheet.id)}
              onDoubleClick={() => {
                if (readOnly) return;
                setError(null);
                setRenaming({ id: sheet.id, draft: sheet.name });
              }}
              onContextMenu={(e) => {
                if (readOnly) return;
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, items: getSheetTabMenuItems(controller, sheet.id, { onError: setError }) });
              }}
              onDragStart={(e) => {
                dragFrom.current = index;
                e.dataTransfer?.setData('text/plain', sheet.id);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (dragFrom.current === null) return;
                e.preventDefault();
                const after = dropAfter(e);
                setDropTarget((prev) => (prev?.index === index && prev.after === after ? prev : { index, after }));
              }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(e) => {
                e.preventDefault();
                const from = dragFrom.current;
                dragFrom.current = null;
                setDropTarget(null);
                if (from === null) return;
                state.moveSheet(sheets[from].id, sheetDropIndex(from, index, dropAfter(e)));
              }}
              onDragEnd={() => {
                dragFrom.current = null;
                setDropTarget(null);
              }}
            >
              {sheet.name}
            </button>
          ),
        )}
        {!readOnly && (
          <button
            type="button"
            aria-label="Add sheet"
            title="Add sheet"
            className="rounded px-2 py-0.5 text-muted-foreground hover:bg-background/60"
            onClick={() => {
              setError(null);
              state.addSheet();
            }}
          >
            +
          </button>
        )}
      </div>
      {error && (
        <div role="alert" className="px-2 py-1 text-xs text-destructive">
          {error}
        </div>
      )}
      {menu && (
        <SpreadsheetContextMenu
          items={menu.items}
          x={menu.x}
          y={menu.y}
          ariaLabel="Sheet actions"
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
};
