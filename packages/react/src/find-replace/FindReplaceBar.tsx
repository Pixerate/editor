import React, { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { FIND_OPTION_TOGGLES, formatFindStatus } from "@pixerate/editor";
import { useFindReplace } from "./useFindReplace";

export interface FindReplaceBarProps {
  editor: Editor | null;
  className?: string;
  /** Render even while the find state is closed (default: only after Mod+F / Mod+H / `openFindReplace`). */
  alwaysOpen?: boolean;
  /** Show the "More options" toggle (prefix, suffix, ignore punctuation/white space, literal). Default `true`. */
  showMoreOptions?: boolean;
  /** Called after the bar closes (Escape or the close button). */
  onClose?: () => void;
}

const inputClass =
  "min-w-0 flex-1 rounded border border-input bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring";
const buttonClass =
  "rounded px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent";
const toggleClass = (on: boolean) =>
  `${buttonClass} font-mono ${on ? "bg-primary/10 text-primary" : "text-muted-foreground"}`;

const isMod = (e: React.KeyboardEvent) => e.metaKey || e.ctrlKey;

/**
 * Word-style find bar for an editor using the `FindReplace` extension: find
 * and replace fields, option toggles, "3 of 12" counter, previous/next,
 * Replace and Replace All. Enter / Shift+Enter step through matches, Enter in
 * the replace field replaces, Mod+Enter replaces all, Escape closes.
 */
export const FindReplaceBar: React.FC<FindReplaceBarProps> = ({
  editor,
  className = "flex flex-col gap-1 rounded-md border border-border bg-background p-1 text-sm shadow-sm",
  alwaysOpen = false,
  showMoreOptions = true,
  onClose,
}) => {
  const find = useFindReplace(editor);
  const findInput = useRef<HTMLInputElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const visible = find.available && (alwaysOpen || find.open);

  // Mod+F / Mod+H (in the editor or the bar) focus and select the find field.
  useEffect(() => {
    if (!visible || find.focusRequest === 0) return;
    findInput.current?.focus();
    findInput.current?.select();
  }, [visible, find.focusRequest]);

  if (!visible) return null;

  const showReplace = find.mode === "replace";
  const status = formatFindStatus(find);
  const hasMatches = find.matchCount > 0;

  const close = () => {
    find.close();
    editor?.commands.focus();
    onClose?.();
  };

  const onBarKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (isMod(e) && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      find.show("find");
    } else if (isMod(e) && (e.key === "h" || e.key === "H")) {
      e.preventDefault();
      find.show("replace");
    }
  };

  const onFindKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (e.shiftKey) find.previous();
    else find.next();
  };

  const onReplaceKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (isMod(e)) find.replaceAll();
    else find.replace();
  };

  return (
    <div className={className} role="search" aria-label="Find and replace" onKeyDown={onBarKeyDown}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={buttonClass}
          aria-label="Toggle replace"
          aria-expanded={showReplace}
          onClick={() => find.show(showReplace ? "find" : "replace")}
        >
          {showReplace ? "▾" : "▸"}
        </button>
        <input
          ref={findInput}
          type="text"
          className={inputClass}
          placeholder="Find"
          aria-label="Find"
          aria-invalid={!!find.error}
          value={find.query}
          onChange={(e) => find.setQuery(e.target.value)}
          onKeyDown={onFindKeyDown}
        />
        {FIND_OPTION_TOGGLES.filter((t) => !t.advanced).map((t) => (
          <button
            key={t.key}
            type="button"
            className={toggleClass(!!find.options[t.key])}
            aria-label={t.label}
            title={t.label}
            aria-pressed={!!find.options[t.key]}
            onClick={() => find.toggleOption(t.key)}
          >
            {t.short}
          </button>
        ))}
        <span
          className={`min-w-[5rem] px-1 text-center text-xs ${find.error ? "text-destructive" : "text-muted-foreground"}`}
          aria-live="polite"
          role={find.error ? "alert" : "status"}
          data-testid="find-status"
        >
          {status}
        </span>
        <button type="button" className={buttonClass} aria-label="Previous match" disabled={!hasMatches} onClick={find.previous}>
          ↑
        </button>
        <button type="button" className={buttonClass} aria-label="Next match" disabled={!hasMatches} onClick={find.next}>
          ↓
        </button>
        {showMoreOptions && (
          <button
            type="button"
            className={buttonClass}
            aria-label="More options"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
          >
            …
          </button>
        )}
        <button type="button" className={buttonClass} aria-label="Close find" onClick={close}>
          ×
        </button>
      </div>
      {showReplace && (
        <div className="flex items-center gap-1 pl-7">
          <input
            type="text"
            className={inputClass}
            placeholder="Replace"
            aria-label="Replace"
            value={find.replacement}
            onChange={(e) => find.setReplacement(e.target.value)}
            onKeyDown={onReplaceKeyDown}
          />
          <button
            type="button"
            className={buttonClass}
            disabled={!hasMatches || find.currentIndex < 0}
            onClick={find.replace}
          >
            Replace
          </button>
          <button type="button" className={buttonClass} disabled={!hasMatches} onClick={find.replaceAll}>
            Replace all
          </button>
          {find.lastReplaceCount !== null && (
            <span className="px-1 text-xs text-muted-foreground" aria-live="polite">
              {find.lastReplaceCount === 1 ? "1 replaced" : `${find.lastReplaceCount} replaced`}
            </span>
          )}
        </div>
      )}
      {showMoreOptions && moreOpen && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-7 text-xs text-muted-foreground">
          {FIND_OPTION_TOGGLES.filter((t) => t.advanced).map((t) => (
            <label key={t.key} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={!!find.options[t.key]}
                onChange={() => find.toggleOption(t.key)}
              />
              {t.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
};
