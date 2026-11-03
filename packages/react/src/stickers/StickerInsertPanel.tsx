import React, { useState } from 'react';
import { insertSticker, type StickerInsertHost, type StickerProvider } from '@pixerate/editor/stickers';
import { StickerLibraryPicker } from './StickerLibraryPicker';

export interface StickerInsertPanelProps {
  provider: StickerProvider;
  /** Where stickers go: `createVectorStickerHost`, `createImageStickerHost`, `createCanvasStickerHost` or your own. */
  host: StickerInsertHost;
  /** Called with what was inserted (its id, ref, size and licence). */
  onInserted?: (result: Awaited<ReturnType<typeof insertSticker>>) => void;
  className?: string;
}

/**
 * Pick a sticker to insert it into an editor (one undo step), centred in the document at its
 * natural size, with an optional tint for tintable stickers: the panel counterpart of
 * `insert_sticker`.
 */
export const StickerInsertPanel: React.FC<StickerInsertPanelProps> = ({ provider, host, onInserted, className }) => {
  const [tint, setTint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className={`flex flex-col gap-1.5 text-xs ${className ?? ''}`} data-testid="sticker-insert">
      <StickerLibraryPicker
        provider={provider}
        label="Insert sticker"
        onPick={(it) => {
          setBusy(true);
          setError(null);
          insertSticker(provider, host, { ref: it.ref, ...(tint && it.tintable ? { color: tint } : {}) })
            .then((r) => onInserted?.(r))
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
        }}
      />
      <label className="flex items-center gap-2">
        <input type="checkbox" aria-label="Tint stickers" checked={tint !== null} onChange={(e) => setTint(e.target.checked ? '#2563eb' : null)} /> Tint
        {tint !== null && <input type="color" aria-label="Sticker tint" value={tint} onChange={(e) => setTint(e.target.value)} />}
        {busy && <span className="text-slate-500">Inserting…</span>}
      </label>
      {error && (
        <p role="alert" className="text-[11px] text-rose-400">
          {error}
        </p>
      )}
    </div>
  );
};
