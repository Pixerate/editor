import React, { useEffect, useMemo, useState } from 'react';
import { StickerBrowser, type StickerBrowserItem, type StickerProvider } from '@pixerate/editor/stickers';

export interface StickerLibraryPickerProps {
  /** The sticker library (e.g. `editorStickers()`, a host's, or `combineStickerProviders([...])`). */
  provider: StickerProvider;
  /** Refs shown as chosen. */
  selected?: readonly string[];
  /** Called with a sticker when it is clicked. */
  onPick: (sticker: StickerBrowserItem) => void;
  /** Accessible name of the sticker list (default "Stickers"). */
  label?: string;
  /** Shown under the list (e.g. load errors). */
  footer?: React.ReactNode;
  className?: string;
}

/** A sticker's tooltip: name, ref, licence and credit, AI-generated, dark variant. */
const tooltip = (it: StickerBrowserItem) => `${it.name} (${it.ref}) · ${it.licence.name}${it.licence.attribution ? ` · ${it.licence.attribution}` : ''}${it.aiGenerated ? ' · AI-generated' : ''}${it.variants?.includes('dark') ? ' · light and dark' : ''}`;

/**
 * Stickers from a sticker library: searchable, by category or collection and a page at a time,
 * with each sticker's licence in its tooltip and an AI label on AI-generated art. Clicking one calls `onPick`. The same picker serves the paint
 * editor's sticker brush and inserting stickers into the vector, image and canvas editors.
 */
export const StickerLibraryPicker: React.FC<StickerLibraryPickerProps> = ({ provider, selected = [], onPick, label = 'Stickers', footer, className }) => {
  const browser = useMemo(() => new StickerBrowser(() => provider), [provider]);
  const [, setTick] = useState(0);
  useEffect(() => {
    const off = browser.subscribe(() => setTick((n) => n + 1));
    void browser.refresh();
    return off;
  }, [browser]);
  const s = browser.state;
  return (
    <div className={`flex flex-col gap-1 ${className ?? ''}`} data-testid="sticker-picker">
      <div className="flex items-center gap-1">
        <input type="search" aria-label={`Search ${label.toLowerCase()}`} placeholder={`Search ${s.provider}`} value={s.query} onChange={(e) => void browser.setQuery(e.target.value)} className="min-w-0 flex-1 rounded bg-slate-800 px-1 py-0.5" />
        {s.categories.length > 1 && (
          <select aria-label="Sticker category" value={s.category} onChange={(e) => void browser.setCategory(e.target.value)} className="rounded bg-slate-800 px-1 py-0.5">
            <option value="">All</option>
            {s.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        {s.collections.length > 0 && (
          <select aria-label="Sticker collection" value={s.collection} onChange={(e) => void browser.setCollection(e.target.value)} className="rounded bg-slate-800 px-1 py-0.5">
            <option value="">All collections</option>
            {s.collections.map((c) => (
              <option key={c.id} value={c.id} title={c.description}>
                {c.name} ({c.count})
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto" role="group" aria-label={label}>
        {s.items.map((it) => {
          const on = selected.includes(it.ref);
          return (
            <button
              key={it.ref}
              type="button"
              aria-pressed={on}
              title={tooltip(it)}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${on ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300'}`}
              onClick={() => onPick(it)}
            >
              {it.thumbnail && <img src={it.thumbnail} alt="" className="h-4 w-4" />}
              {it.name}
              {it.aiGenerated && (
                <span className="rounded bg-slate-700 px-0.5 text-[8px] text-slate-200" aria-label="AI-generated">
                  AI
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between text-[10px] text-slate-500">
        <span>{s.loading ? 'Loading…' : `${s.items.length} of ${s.total}`}</span>
        {s.hasMore && (
          <button type="button" className="text-indigo-300" onClick={() => void browser.more()}>
            More
          </button>
        )}
      </div>
      {s.error && (
        <p role="alert" className="text-[11px] text-rose-400">
          {s.error}
        </p>
      )}
      {footer}
    </div>
  );
};
