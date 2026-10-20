import { untrack } from "svelte";
import type { EffectDescription, EffectProvider } from "@pixerate/editor/effects";

/** Anything that takes an effects provider: every editor controller with effects support. */
export interface EffectsHost {
  useEffects(provider: EffectProvider): () => void;
}

/**
 * Registers a provider with an editor for the lifetime of the calling component (call it during
 * initialisation), following the getters: a new provider replaces the old one, `null` or
 * `undefined` removes it. Without a provider the editor behaves as without effects support.
 */
export function useEffects(host: EffectsHost | null | undefined | (() => EffectsHost | null | undefined), provider: EffectProvider | null | undefined | (() => EffectProvider | null | undefined)): void {
  $effect(() => {
    const h = typeof host === "function" ? host() : host;
    const p = typeof provider === "function" ? provider() : provider;
    if (!h || !p) return;
    return untrack(() => h.useEffects(p));
  });
}

/** An effect's description from the provider, reloaded when the getters change (`null` while loading or on error). */
export function effectDescriptionOf(provider: () => EffectProvider | null | undefined, effect: () => string | null | undefined): { readonly description: EffectDescription | null; readonly error: string | null } {
  let description = $state.raw<EffectDescription | null>(null);
  let error = $state<string | null>(null);
  $effect(() => {
    const p = provider();
    const id = effect();
    description = null;
    error = null;
    if (!p || !id) return;
    let live = true;
    Promise.resolve()
      .then(() => p.describe(id))
      .then(
        (d) => {
          if (live) description = d;
        },
        (e: unknown) => {
          if (live) error = e instanceof Error ? e.message : String(e);
        },
      );
    return () => {
      live = false;
    };
  });
  return {
    get description() {
      return description;
    },
    get error() {
      return error;
    },
  };
}
