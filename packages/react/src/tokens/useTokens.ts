import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  TokenStore,
  exportTokensCss,
  getTokenCssVariables,
  type TokenCssOptions,
  type TokenModeContext,
  type TokenState,
  type TokenStoreOptions,
} from '@pixerate/editor/tokens';

/** A `TokenStore` created once for the component's lifetime. */
export function useTokenStore(options?: TokenStoreOptions): TokenStore {
  const ref = useRef<TokenStore | null>(null);
  if (!ref.current) ref.current = new TokenStore(options);
  return ref.current;
}

/** The store's current state (re-renders on every change). */
export function useTokenState(store: TokenStore): TokenState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

export interface UseTokensOptions {
  /** Modes for `cssVariables` (collection id → mode id; default modes otherwise). */
  modes?: TokenModeContext;
  /** Options for `css` and `cssVariables` (prefix, attribute, …). */
  css?: TokenCssOptions;
}

export interface UseTokensResult {
  store: TokenStore;
  state: TokenState;
  /** Resolved custom properties for `modes`, e.g. `<div style={cssVariables}>`. */
  cssVariables: Record<string, string>;
  /** A stylesheet with every mode (`:root { … } :root[data-mode="dark"] { … }`). */
  css: string;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
}

/**
 * Subscribes to a token store and exposes its state plus CSS custom properties for app
 * theming: apply `cssVariables` as an inline style, or inject `css` and switch modes with the
 * `data-mode` attribute.
 */
export function useTokens(store: TokenStore, options: UseTokensOptions = {}): UseTokensResult {
  const state = useTokenState(store);
  const modesKey = JSON.stringify(options.modes ?? {});
  const cssKey = JSON.stringify(options.css ?? {}, (_k, v) => (typeof v === 'function' ? String(v) : v));
  const cssVariables = useMemo(
    () => getTokenCssVariables(state, options.modes, options.css),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, modesKey, cssKey],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const css = useMemo(() => exportTokensCss(state, options.css), [state, cssKey]);
  const undo = useCallback(() => void store.undo(), [store]);
  const redo = useCallback(() => void store.redo(), [store]);
  return { store, state, cssVariables, css, canUndo: store.canUndo(), canRedo: store.canRedo(), undo, redo };
}
