import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { clampMenuPosition, runSpreadsheetMenuItem, type SpreadsheetMenuItem } from '@pixerate/editor/spreadsheet';

// Gap kept between the menu and the viewport edges.
const VIEWPORT_MARGIN = 4;

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
  const [position, setPosition] = useState({ x, y });

  // Keep the (fixed) menu inside the viewport: near the right or bottom edge
  // it opens to the left of / above the pointer instead of being cut off.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || typeof window === 'undefined') return;
    const { width, height } = menu.getBoundingClientRect();
    const next = clampMenuPosition(
      { x, y },
      { width, height },
      { width: window.innerWidth, height: window.innerHeight },
      VIEWPORT_MARGIN
    );
    setPosition((prev) => (prev.x === next.x && prev.y === next.y ? prev : next));
  }, [x, y, items]);

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
      style={{
        left: position.x,
        top: position.y,
        maxHeight: `calc(100vh - ${VIEWPORT_MARGIN * 2}px)`,
        overflowY: 'auto',
        background: 'var(--popover, var(--background, #fff))'
      }}
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
            data-checked={item.checked ? '' : undefined}
            disabled={item.disabled}
            className={`block w-full px-3 py-1 text-left hover:bg-muted disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent ${
              item.checked ? 'font-semibold' : ''
            }`}
            onClick={() => {
              onClose();
              runSpreadsheetMenuItem(item);
            }}
          >
            {item.label}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
};
