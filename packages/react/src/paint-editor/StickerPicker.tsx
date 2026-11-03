import React, { useEffect, useMemo, useState } from 'react';
import { StickerBrowser, type PaintEditorController } from '@pixerate/editor/paint-editor';

export interface StickerPickerProps {
  controller: PaintEditorController;
  /** Refs shown as chosen. */
  selected: readonly string[];
  /** Called with a sticker's ref when it is clicked. */
  onPick: (ref: string) => void;
  /** Accessible name of the sticker list (default "Stickers"). */
  label?: string;
}

/**
 * Stickers from the paint editor's sticker library (`controller.stickersProvider`), searchable,
 * by category and a page at a time; clicking one calls `onPick` with its ref. Chosen stickers
 * whose art failed to load say why.
 */
export const StickerPicker: React.FC<StickerPickerProps> = ({ controller, selected, onPick, label = 'Stickers' }) => {
  const browser = useMemo(() => new StickerBrowser(() => controller.stickersProvider), [controller]);
  const [, setTick] = useState(0);
  useEffect(() => browser.subscribe(() => setTick((n) => n + 1)), [browser]);
  useEffect(() => {
    void browser.refresh();
    return controller.stickers.subscribe(() => void browser.refresh());
  }, [browser, controller]);
  const s = browser.state;
  const failed = selected.map((ref) => ({ ref, ...controller.stickerArtStatus(ref) })).filter((x) => x.status === 'failed');
  return (
    <div className="flex flex-col gap-1" data-testid="sticker-picker">
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
      </div>
      <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto" role="group" aria-label={label}>
        {s.items.map((it) => {
          const on = selected.includes(it.ref);
          return (
            <button
              key={it.ref}
              type="button"
              aria-pressed={on}
              title={`${it.name} (${it.ref}) · ${it.licence.name}`}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${on ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300'}`}
              onClick={() => onPick(it.ref)}
            >
              {it.thumbnail && <img src={it.thumbnail} alt="" className="h-4 w-4" />}
              {it.name}
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
      {s.error && <p role="alert" className="text-[11px] text-rose-400">{s.error}</p>}
      {failed.map((f) => (
        <p key={f.ref} role="alert" className="text-[11px] text-rose-400">
          {f.ref}: {f.error}
        </p>
      ))}
    </div>
  );
};
