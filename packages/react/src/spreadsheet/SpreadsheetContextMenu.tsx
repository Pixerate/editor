import React, { useEffect, useRef } from 'react';
import type { SpreadsheetMenuItem } from '@pixerate/editor/spreadsheet';

export interface SpreadsheetContextMenuProps {
  items: SpreadsheetMenuItem[];
  x: number;
  y: number;
  onClose: () => void;
}

/** The table context menu (sort, filter, freeze, hide, merge, categories, transpose). */
export const SpreadsheetContextMenu: React.FC<SpreadsheetContextMenuProps> = ({ items, x, y, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const handlePointer = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onCloseRef.current();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('mousedown', handlePointer);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handlePointer);
      window.removeEventListener('keydown', handleKey);
    };
  }, []);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Table actions"
      className="fixed z-50 min-w-[14rem] rounded-md border border-border bg-popover py-1 text-xs text-popover-foreground shadow-lg"
      style={{ left: x, top: y, background: 'var(--popover, var(--background, #fff))' }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <React.Fragment key={item.id}>
          {item.separatorBefore && <div role="separator" className="my-1 h-px bg-border" />}
          <button
            type="button"
            role="menuitem"
            data-action={item.id}
            disabled={item.disabled}
            className="block w-full px-3 py-1 text-left hover:bg-muted disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            {item.label}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
};
