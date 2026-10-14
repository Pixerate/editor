import {
  exportTokensCss,
  getTokenCssVariables,
  type TokenCssOptions,
  type TokenModeContext,
  type TokenState,
  type TokenStore,
} from "@pixerate/editor/tokens";

export interface CreateTokensOptions {
  /** Modes for `cssVariables` (collection id → mode id), or a getter for reactive modes. */
  modes?: TokenModeContext | (() => TokenModeContext | undefined);
  /** Options for `css` and `cssVariables` (prefix, attribute, …). */
  css?: TokenCssOptions;
}

export interface SvelteTokens {
  readonly store: TokenStore;
  /** The store's state (reactive). */
  readonly state: TokenState;
  /** Resolved custom properties for `modes` (reactive), e.g. for `style:` directives. */
  readonly cssVariables: Record<string, string>;
  /** `cssVariables` as a `style` attribute string (reactive). */
  readonly style: string;
  /** A stylesheet with every mode (reactive). */
  readonly css: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  undo(): void;
  redo(): void;
  /** Stops listening to the store. */
  destroy(): void;
}

/**
 * Svelte 5 rune: subscribes to a `TokenStore` and exposes its state plus CSS custom properties
 * for app theming (`<div style={tokens.style}>`, or inject `tokens.css` and switch the
 * `data-mode` attribute).
 */
export function createTokens(store: TokenStore, options: CreateTokensOptions = {}): SvelteTokens {
  let state = $state.raw(store.getState());
  const unsubscribe = store.subscribe((event) => {
    state = event.state;
  });
  const modes = () => (typeof options.modes === "function" ? options.modes() : options.modes);
  const cssVariables = $derived(getTokenCssVariables(state, modes(), options.css));
  const css = $derived(exportTokensCss(state, options.css));
  return {
    store,
    get state() {
      return state;
    },
    get cssVariables() {
      return cssVariables;
    },
    get style() {
      return Object.entries(cssVariables)
        .map(([name, value]) => `${name}: ${value}`)
        .join("; ");
    },
    get css() {
      return css;
    },
    get canUndo() {
      void state;
      return store.canUndo();
    },
    get canRedo() {
      void state;
      return store.canRedo();
    },
    undo: () => void store.undo(),
    redo: () => void store.redo(),
    destroy: unsubscribe,
  };
}
