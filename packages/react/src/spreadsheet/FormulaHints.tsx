import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { applyFormulaSuggestion, getFormulaHints } from '@pixerate/editor';

export interface FormulaHintsProps {
  /** The input being edited (a cell editor or the formula bar). */
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** The input's current value. */
  value: string;
  /** Called with the new value when a suggestion is accepted. */
  onAccept: (value: string) => void;
  /** Maximum number of function suggestions (default 8). */
  limit?: number;
}

/**
 * Formula autocomplete for an input: while the value starts with `=`, lists
 * functions matching the name at the caret (name, signature, description) and,
 * inside a call, shows the signature with the current argument highlighted.
 *
 * Keys are handled on the input itself, before the grid sees them: ArrowUp /
 * ArrowDown move the selection, Tab accepts it, Escape closes the list.
 * Enter is left alone so it still commits the cell.
 */
export const FormulaHints: React.FC<FormulaHintsProps> = ({ inputRef, value, onAccept, limit = 8 }) => {
  const [caret, setCaret] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const pendingCaret = useRef<number | null>(null);

  const hints = useMemo(
    () => getFormulaHints(value, caret ?? value.length, { limit }),
    [value, caret, limit],
  );
  const suggestions = dismissed ? [] : hints.suggestions;
  const selectedIndex = Math.max(0, Math.min(selected, suggestions.length - 1));
  const visible = focused && value.trimStart().startsWith('=') && (suggestions.length > 0 || !!hints.activeCall);

  // The key listener reads the latest state through a ref.
  const latest = useRef({ suggestions, selected: selectedIndex, value, caret, onAccept });
  latest.current = { suggestions, selected: selectedIndex, value, caret, onAccept };

  const accept = (index: number) => {
    const { suggestions: list, value: current, caret: at, onAccept: commit } = latest.current;
    const suggestion = list[index];
    if (!suggestion) return;
    const next = applyFormulaSuggestion(current, at ?? current.length, suggestion.name);
    pendingCaret.current = next.caret;
    commit(next.value);
  };

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const syncCaret = () => setCaret(input.selectionStart ?? input.value.length);
    const onInput = () => {
      setDismissed(false);
      setSelected(0);
      syncCaret();
    };
    const onFocus = () => {
      setFocused(true);
      syncCaret();
    };
    const onBlur = () => setFocused(false);
    // A native listener on the input runs before React's delegated handlers,
    // so stopping propagation keeps these keys away from the grid.
    const onKeyDown = (e: KeyboardEvent) => {
      const { suggestions: list } = latest.current;
      if (list.length === 0) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setSelected((i) => (i + step + list.length) % list.length);
      } else if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        accept(latest.current.selected);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(true);
      }
    };

    input.addEventListener('input', onInput);
    input.addEventListener('keyup', syncCaret);
    input.addEventListener('click', syncCaret);
    input.addEventListener('select', syncCaret);
    input.addEventListener('focus', onFocus);
    input.addEventListener('blur', onBlur);
    input.addEventListener('keydown', onKeyDown);
    // Inputs focused on mount (autoFocus) fired `focus` before this effect ran.
    if (typeof document !== 'undefined' && document.activeElement === input) onFocus();
    return () => {
      input.removeEventListener('input', onInput);
      input.removeEventListener('keyup', syncCaret);
      input.removeEventListener('click', syncCaret);
      input.removeEventListener('select', syncCaret);
      input.removeEventListener('focus', onFocus);
      input.removeEventListener('blur', onBlur);
      input.removeEventListener('keydown', onKeyDown);
    };
  }, [inputRef]);

  // After accepting, put the caret inside the inserted parenthesis.
  useLayoutEffect(() => {
    const input = inputRef.current;
    const at = pendingCaret.current;
    if (!input || at === null || input.value !== value) return;
    pendingCaret.current = null;
    input.setSelectionRange(at, at);
    setCaret(at);
    setSelected(0);
  }, [value, inputRef]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!visible || !input) return;
    const rect = input.getBoundingClientRect();
    setPosition({ top: rect.bottom + 2, left: rect.left, width: rect.width });
  }, [visible, value, inputRef]);

  if (!visible) return null;

  const { activeCall } = hints;
  return (
    <div
      data-formula-hints=""
      className="rounded-md border border-border bg-popover text-popover-foreground shadow-md text-xs font-sans overflow-hidden"
      style={{
        position: 'fixed',
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        minWidth: Math.max(260, position?.width ?? 0),
        maxWidth: 440,
        zIndex: 50,
        visibility: position ? 'visible' : 'hidden'
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {activeCall && (
        <div data-formula-signature="" className="px-2 py-1.5 border-b border-border bg-muted/30">
          <div className="font-mono">
            {activeCall.parts.map((part, i) => (
              <span
                key={i}
                data-active={part.active ? '' : undefined}
                className={part.active ? 'font-bold text-primary underline' : ''}
              >
                {part.text}
              </span>
            ))}
          </div>
          <div className="mt-0.5 text-muted-foreground">
            {activeCall.argument ? (
              <>
                <span className="font-semibold">{activeCall.argument.name}</span>: {activeCall.argument.description}
              </>
            ) : (
              activeCall.description
            )}
          </div>
        </div>
      )}
      {suggestions.length > 0 && (
        <ul role="listbox" aria-label="Formula suggestions" className="max-h-64 overflow-auto py-1 m-0 list-none p-0">
          {suggestions.map((s, i) => (
            <li
              key={s.name}
              role="option"
              aria-selected={i === selectedIndex}
              className={`cursor-pointer px-2 py-1 ${i === selectedIndex ? 'bg-primary/10' : 'hover:bg-muted/50'}`}
              onMouseEnter={() => setSelected(i)}
              onMouseDown={(e) => {
                // Keep focus in the input so the edit isn't committed by blur.
                e.preventDefault();
                accept(i);
              }}
            >
              <div className="font-mono font-semibold text-foreground">{s.signature}</div>
              <div className="text-muted-foreground truncate">{s.description}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
