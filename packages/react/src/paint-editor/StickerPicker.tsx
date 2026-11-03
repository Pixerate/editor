import React, { useEffect, useState } from 'react';
import type { PaintEditorController } from '@pixerate/editor/paint-editor';
import { StickerLibraryPicker } from '../stickers/StickerLibraryPicker';

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
 * Stickers from the paint editor's sticker library (`controller.stickersProvider`, followed when
 * it changes), through `StickerLibraryPicker`; clicking one calls `onPick` with its ref. Chosen
 * stickers whose art failed to load say why.
 */
export const StickerPicker: React.FC<StickerPickerProps> = ({ controller, selected, onPick, label = 'Stickers' }) => {
  const [provider, setProvider] = useState(() => controller.stickersProvider);
  useEffect(() => controller.stickers.subscribe(setProvider), [controller]);
  const failed = selected.map((ref) => ({ ref, ...controller.stickerArtStatus(ref) })).filter((x) => x.status === 'failed');
  return (
    <StickerLibraryPicker
      provider={provider}
      selected={selected}
      label={label}
      onPick={(it) => onPick(it.ref)}
      footer={failed.map((f) => (
        <p key={f.ref} role="alert" className="text-[11px] text-rose-400">
          {f.ref}: {f.error}
        </p>
      ))}
    />
  );
};
