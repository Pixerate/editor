import { useEffect, useState } from 'react';
import type { EffectDescription, EffectProvider } from '@pixerate/editor/effects';

/** Anything that takes an effects provider: every editor controller with effects support. */
export interface EffectsHost {
  useEffects(provider: EffectProvider): () => void;
}

/**
 * Registers `provider` with an editor while mounted (or while it is the one passed), and removes it
 * again on unmount. Pass `null` or `undefined` for no provider: the editor then behaves as without
 * effects support.
 */
export function useEffects(host: EffectsHost | null | undefined, provider: EffectProvider | null | undefined): void {
  useEffect(() => {
    if (!host || !provider) return;
    return host.useEffects(provider);
  }, [host, provider]);
}

/** An effect's description from the provider, loaded when `effect` changes (`null` while loading or on error). */
export function useEffectDescription(provider: EffectProvider | null | undefined, effect: string | null | undefined): { description: EffectDescription | null; error: string | null } {
  const [state, setState] = useState<{ key: string; description: EffectDescription | null; error: string | null }>({ key: '', description: null, error: null });
  const key = provider && effect ? `${provider.id}:${effect}` : '';
  useEffect(() => {
    if (!provider || !effect) return;
    let live = true;
    Promise.resolve()
      .then(() => provider.describe(effect))
      .then(
        (description) => live && setState({ key, description, error: null }),
        (e: unknown) => live && setState({ key, description: null, error: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      live = false;
    };
  }, [provider, effect, key]);
  return state.key === key ? { description: state.description, error: state.error } : { description: null, error: null };
}
