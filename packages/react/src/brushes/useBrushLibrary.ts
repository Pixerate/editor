import { useEffect, useState } from 'react';
import type { BrushFilter, BrushLibrary, BrushLibraryEntry } from '@pixerate/editor/brushes';

/**
 * The brushes of a brush library (`filter`: e.g. `{ profile: CANVAS_PROFILE }` for what a host can
 * paint), read again after every change to the library: a brush saved in another editor sharing
 * it shows up. Empty until the first read.
 */
export function useBrushLibrary(library: Pick<BrushLibrary, 'list' | 'subscribe'> | null | undefined, filter: BrushFilter = {}): BrushLibraryEntry[] {
  const [entries, setEntries] = useState<BrushLibraryEntry[]>([]);
  const { profile, ...rest } = filter;
  const key = `${profile?.id ?? ''}:${JSON.stringify(rest)}`;
  useEffect(() => {
    if (!library) return;
    let live = true;
    const read = () => void library.list(filter).then((list) => live && setEntries(list), () => undefined);
    read();
    const unsubscribe = library.subscribe(read);
    return () => {
      live = false;
      unsubscribe();
    };
    // The filter is compared by its content (`key`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library, key]);
  return entries;
}
