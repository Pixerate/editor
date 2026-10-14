import type {
  GenerationRecord,
  GenerationRecordFilter,
  GenerationRecordStore,
} from "@pixerate/editor/generation";

export interface SvelteGenerationRecords {
  readonly records: GenerationRecord[];
  readonly loading: boolean;
  readonly error: unknown;
  refresh(): Promise<void>;
  /** Stops following the store. */
  destroy(): void;
}

/**
 * Reactive records of a `GenerationRecordStore` (Svelte 5 runes), newest
 * first, reloaded whenever the store changes. Pass a getter for a reactive
 * filter: `createGenerationRecords(store, () => ({ model }))`. Call
 * `destroy()` (or create it inside a component, where it is cleaned up with
 * the component's effects) to stop listening.
 */
export function createGenerationRecords(
  store: GenerationRecordStore,
  filter: () => GenerationRecordFilter | undefined = () => undefined,
): SvelteGenerationRecords {
  let records = $state<GenerationRecord[]>([]);
  let loading = $state(true);
  let error = $state<unknown>(null);
  let currentFilter: GenerationRecordFilter | undefined = undefined;
  let generation = 0;

  const refresh = async () => {
    const ticket = ++generation;
    loading = true;
    try {
      const next = await store.list(currentFilter);
      if (ticket !== generation) return;
      records = next;
      error = null;
    } catch (err) {
      if (ticket === generation) error = err;
    } finally {
      if (ticket === generation) loading = false;
    }
  };

  const unsubscribe = store.subscribe(() => void refresh());
  let stopEffect: (() => void) | null = null;
  if ($effect.tracking()) {
    $effect(() => {
      currentFilter = filter();
      void refresh();
    });
    $effect(() => unsubscribe);
  } else {
    stopEffect = $effect.root(() => {
      $effect(() => {
        currentFilter = filter();
        void refresh();
      });
    });
  }

  return {
    get records() {
      return records;
    },
    get loading() {
      return loading;
    },
    get error() {
      return error;
    },
    refresh,
    destroy() {
      unsubscribe();
      stopEffect?.();
    },
  };
}
