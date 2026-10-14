import React, { useEffect, useId, useRef } from 'react';
import type { CommandPaletteItem } from '@pixerate/editor/commands';
import type { UseCommandPaletteResult } from './useCommandPalette';

export interface CommandPaletteProps {
  /** State from `useCommandPalette`. */
  palette: UseCommandPaletteResult;
  placeholder?: string;
  emptyMessage?: string;
  /** Extra classes for the dialog panel. */
  className?: string;
}

/** Label with the fuzzy-matched characters emphasised. */
function HighlightedLabel({ item }: { item: CommandPaletteItem }) {
  if (item.labelIndices.length === 0) return <>{item.label}</>;
  const marked = new Set(item.labelIndices);
  return (
    <>
      {Array.from(item.label).map((ch, i) =>
        marked.has(i) ? (
          <span key={i} className="font-semibold text-foreground" data-match="">
            {ch}
          </span>
        ) : (
          <React.Fragment key={i}>{ch}</React.Fragment>
        ),
      )}
    </>
  );
}

/**
 * Headless-styled command palette (Tailwind + theme tokens): a search box over the
 * registry's commands showing each command's group, shortcut and, for disabled
 * commands, the reason. Arrow keys move, Enter runs, Escape or a backdrop click closes.
 */
export const CommandPalette: React.FC<CommandPaletteProps> = ({
  palette,
  placeholder = 'Type a command…',
  emptyMessage = 'No matching commands',
  className = '',
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const { open, query, items, activeIndex } = palette;

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const active = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    active?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-[15vh]"
      data-command-palette-backdrop=""
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) palette.setOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className={`w-full max-w-lg overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl ${className}`}
        style={{ background: 'var(--popover, var(--background, #fff))' }}
      >
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={items.length ? optionId(activeIndex) : undefined}
          aria-label="Search commands"
          placeholder={placeholder}
          value={query}
          onChange={(e) => palette.setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (palette.handleKeyDown(e.nativeEvent)) e.stopPropagation();
          }}
          className="w-full border-b border-border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
        />
        {items.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyMessage}</div>
        ) : (
          <ul ref={listRef} id={listId} role="listbox" aria-label="Commands" className="max-h-80 overflow-y-auto py-1">
            {items.map((item, index) => (
              <li
                key={item.id}
                id={optionId(index)}
                role="option"
                aria-selected={index === activeIndex}
                aria-disabled={!item.enabled || undefined}
                data-command-id={item.id}
                data-recent={item.recent ? '' : undefined}
                title={item.disabledReason}
                onMouseMove={() => index !== activeIndex && palette.setActiveIndex(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => palette.run(item.id)}
                className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm ${
                  index === activeIndex ? 'bg-muted' : ''
                } ${item.enabled ? '' : 'cursor-default opacity-50'}`}
              >
                <span className="min-w-0 flex-1 truncate">
                  <HighlightedLabel item={item} />
                  {item.disabledReason && (
                    <span className="ml-2 text-xs text-muted-foreground" data-disabled-reason="">
                      {item.disabledReason}
                    </span>
                  )}
                </span>
                {item.group && <span className="shrink-0 text-xs text-muted-foreground">{item.group}</span>}
                {item.shortcut && (
                  <kbd className="shrink-0 rounded border border-border px-1.5 font-mono text-[10px] text-muted-foreground">
                    {item.shortcut}
                  </kbd>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
