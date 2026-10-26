import { useEffect, useState } from 'react';
import type { ResolvedStyle, StyleCheckReport, StyleResolver } from '@pixerate/editor/tools';

export interface UseStyleResult {
  /** The resolved house style for the domain, or `null` before the first resolve (or without a resolver). */
  style: ResolvedStyle | null;
  /** Why the last resolve failed (e.g. an unknown domain), or `null`. */
  error: string | null;
}

export interface UseStyleFindingsResult extends UseStyleResult {
  /** The last check report for `state`, or `null` before the first check (or without a resolver). */
  report: StyleCheckReport | null;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Runs `run` now and whenever the resolver notifies, delivering only the newest result:
 * an older call that settles late is dropped, and nothing is delivered after cleanup.
 */
function useResolverTask<T>(
  styles: StyleResolver | null | undefined,
  run: ((styles: StyleResolver) => Promise<T>) | null,
  deliver: (result: { value: T; error: null } | { value: null; error: string | null }) => void,
  deps: readonly unknown[],
): void {
  useEffect(() => {
    if (!styles || !run) {
      deliver({ value: null, error: null });
      return;
    }
    let latest = 0;
    let active = true;
    const go = () => {
      const call = ++latest;
      run(styles).then(
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styles, ...deps]);
}

/**
 * The house style for one domain (`chart`, `tokens`, ...), merged across the resolver's layers.
 * Re-resolves when a style store or the token source changes (`styles.subscribe`).
 */
export function useStyle(styles: StyleResolver | null | undefined, domain: string): UseStyleResult {
  const [result, setResult] = useState<UseStyleResult>({ style: null, error: null });
  useResolverTask(
    styles,
    (s) => s.resolve(domain),
    ({ value, error }) => setResult({ style: value, error }),
    [domain],
  );
  return result;
}

/**
 * Runs the domain's house-style checks against `state` (e.g. a chart spec) whenever `state`
 * changes by reference, the domain or resolver changes, or the resolver notifies. Results of
 * older runs that settle late are ignored. Feed `report` to `<StyleFindings>`.
 */
export function useStyleFindings(styles: StyleResolver | null | undefined, domain: string, state: unknown): UseStyleFindingsResult {
  const [result, setResult] = useState<UseStyleFindingsResult>({ report: null, style: null, error: null });
  useResolverTask(
    styles,
    (s) => s.check(domain, state),
    ({ value, error }) => {
      if (!value) setResult({ report: null, style: null, error });
      else {
        const { style, ...report } = value;
        setResult({ report, style, error: null });
      }
    },
    [domain, state],
  );
  return result;
}
