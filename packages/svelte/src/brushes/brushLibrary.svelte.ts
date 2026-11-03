import type { BrushFilter, BrushLibrary, BrushLibraryEntry } from '@pixerate/editor/brushes';

/**
 * The brushes of a brush library as a rune (`filter`: e.g. `{ profile: CANVAS_PROFILE }` for what
 * a host can paint), read again after every change to the library: a brush saved in another
 * editor sharing it shows up. Empty until the first read. Call it during component setup.
 */
export function brushLibraryState(library: () => Pick<BrushLibrary, 'list' | 'subscribe'> | null | undefined, filter: () => BrushFilter = () => ({})): { readonly entries: BrushLibraryEntry[] } {
  let entries = $state<BrushLibraryEntry[]>([]);
  $effect(() => {
    const lib = library();
    const f = filter();
    if (!lib) return;
    let live = true;
    const read = () => void lib.list(f).then((list) => live && (entries = list), () => undefined);
    read();
    const unsubscribe = lib.subscribe(read);
    return () => {
      live = false;
      unsubscribe();
    };
  });
  return {
    get entries() {
      return entries;
    },
  };
}
