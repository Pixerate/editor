import { styleSwatches } from "@pixerate/editor/tools";
import type { ResolvedStyle, StyleCheckReport, StyleChoiceGroup, StyleChoiceResult, StyleResolver, StyleSwatch } from "@pixerate/editor/tools";

type MaybeGetter<T> = T | (() => T);
const read = <T>(value: MaybeGetter<T>): T => (typeof value === "function" ? (value as () => T)() : value);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface SvelteStyle {
  /** The resolved house style for the domain, or `null` before the first resolve (or without a resolver) (reactive). */
  readonly style: ResolvedStyle | null;
  /** Why the last resolve failed (e.g. an unknown domain), or `null` (reactive). */
  readonly error: string | null;
}

export interface SvelteStyleFindings extends SvelteStyle {
  /** The last check report for `state`, or `null` before the first check (or without a resolver) (reactive). */
  readonly report: StyleCheckReport | null;
}

/**
 * Runs `run` in an effect (re-run when anything `inputs` reads changes) and whenever the
 * resolver notifies, delivering only the newest result.
 */
function resolverTask<I, T>(
  inputs: () => { styles: StyleResolver | null | undefined; input: I },
  run: (styles: StyleResolver, input: I) => Promise<T>,
  deliver: (result: { value: T; error: null } | { value: null; error: string | null }) => void,
): void {
  $effect(() => {
    const { styles, input } = inputs();
    if (!styles) {
      deliver({ value: null, error: null });
      return;
    }
    let latest = 0;
    let active = true;
    const go = () => {
      const call = ++latest;
      run(styles, input).then(
        (value) => {
          if (active && call === latest) deliver({ value, error: null });
        },
        (error) => {
          if (active && call === latest) deliver({ value: null, error: message(error) });
        },
      );
    };
    go();
    const unsubscribe = styles.subscribe(go);
    return () => {
      active = false;
      unsubscribe();
    };
  });
}

/**
 * Svelte 5 rune: the house style for one domain (`chart`, `tokens`, ...), merged across the
 * resolver's layers; re-resolves when a style store or the token source changes. Call it during
 * component initialisation; pass getters to react to changes. Parity with React's `useStyle`.
 */
export function useStyle(styles: MaybeGetter<StyleResolver | null | undefined>, domain: MaybeGetter<string>): SvelteStyle {
  let style = $state.raw<ResolvedStyle | null>(null);
  let error = $state.raw<string | null>(null);
  resolverTask(
    () => ({ styles: read(styles), input: read(domain) }),
    (s, d) => s.resolve(d),
    (result) => {
      style = result.value;
      error = result.error;
    },
  );
  return {
    get style() {
      return style;
    },
    get error() {
      return error;
    },
  };
}

/**
 * Svelte 5 rune: runs the domain's house-style checks against `subject`, the domain's state (e.g. a chart spec),
 * whenever the value a getter returns changes by reference, the domain or resolver changes, or
 * the resolver notifies. Results of older runs that settle late are ignored. Feed `report` to
 * `<StyleFindings>`. Call it during component initialisation. Parity with React's `useStyleFindings`.
 */
export function useStyleFindings(
  styles: MaybeGetter<StyleResolver | null | undefined>,
  domain: MaybeGetter<string>,
  subject: MaybeGetter<unknown>,
): SvelteStyleFindings {
  let report = $state.raw<StyleCheckReport | null>(null);
  let style = $state.raw<ResolvedStyle | null>(null);
  let error = $state.raw<string | null>(null);
  resolverTask(
    () => ({ styles: read(styles), input: { domain: read(domain), value: read(subject) } }),
    (s, { domain: d, value }) => s.check(d, value),
    (result) => {
      if (!result.value) {
        report = null;
        style = null;
        error = result.error;
      } else {
        const { style: resolved, ...rest } = result.value;
        report = rest;
        style = resolved;
        error = null;
      }
    },
  );
  return {
    get report() {
      return report;
    },
    get style() {
      return style;
    },
    get error() {
      return error;
    },
  };
}

export interface SvelteStyleChoices {
  /** The one-of-a-kind groups (a look, a theme) with the chosen skill and every option, or `null` before the first read (reactive). */
  readonly groups: StyleChoiceGroup[] | null;
  /** Why the last read or choice failed, or `null` (reactive). */
  readonly error: string | null;
  /** Chooses a skill of its group (see `StyleResolver.choose`); resolves to what changed, or rejects with the reason. */
  choose(name: string, options?: { layer?: string }): Promise<StyleChoiceResult>;
}

/**
 * Svelte 5 rune: the house-style choices for a picker, each one-of-a-kind group with the skill
 * that applies and its options, in `scope` when given. Re-reads when the resolver notifies.
 * Call it during component initialisation. Parity with React's `useStyleChoices`.
 */
export function useStyleChoices(styles: MaybeGetter<StyleResolver | null | undefined>, scope?: MaybeGetter<string | undefined>): SvelteStyleChoices {
  let groups = $state.raw<StyleChoiceGroup[] | null>(null);
  let error = $state.raw<string | null>(null);
  resolverTask(
    () => ({ styles: read(styles), input: scope === undefined ? undefined : read(scope) }),
    (s, sc) => s.choices(sc !== undefined ? { scope: sc } : {}),
    (result) => {
      groups = result.value;
      error = result.error;
    },
  );
  return {
    get groups() {
      return groups;
    },
    get error() {
      return error;
    },
    async choose(name, options = {}) {
      const s = read(styles);
      if (!s) throw new Error("There is no style resolver to choose with.");
      const sc = scope === undefined ? undefined : read(scope);
      try {
        return await s.choose(name, { ...options, ...(sc !== undefined ? { scope: sc } : {}) });
      } catch (e) {
        error = message(e);
        throw e;
      }
    },
  };
}

export interface SvelteStyleSwatches {
  /** The house colours, in picker order (feed `ColorPicker`'s `swatches` or `ChartEditor`'s) (reactive). */
  readonly colors: string[];
  /** The same colours with what each is for (`primary`, `palette 2`, ...) (reactive). */
  readonly swatches: StyleSwatch[];
  /** The house fonts (reactive). */
  readonly fonts: string[];
  /** Why the last resolve failed, or `null` (reactive). */
  readonly error: string | null;
}

/**
 * Svelte 5 rune: the colours and fonts the house style offers for one domain, for pickers. The
 * agent's `get_style` returns the same list. Parity with React's `useStyleSwatches`.
 */
export function useStyleSwatches(
  styles: MaybeGetter<StyleResolver | null | undefined>,
  domain: MaybeGetter<string>,
  scope?: MaybeGetter<string | undefined>,
): SvelteStyleSwatches {
  let style = $state.raw<ResolvedStyle | null>(null);
  let error = $state.raw<string | null>(null);
  resolverTask(
    () => ({ styles: read(styles), input: { domain: read(domain), scope: scope === undefined ? undefined : read(scope) } }),
    (s, { domain: d, scope: sc }) => s.resolve(d, sc !== undefined ? { scope: sc } : {}),
    (result) => {
      style = result.value;
      error = result.error;
    },
  );
  const swatches = $derived(style ? styleSwatches(style) : { colors: [] as StyleSwatch[], fonts: [] as string[] });
  return {
    get colors() {
      return swatches.colors.map((c) => c.color);
    },
    get swatches() {
      return swatches.colors;
    },
    get fonts() {
      return swatches.fonts;
    },
    get error() {
      return error;
    },
  };
}
