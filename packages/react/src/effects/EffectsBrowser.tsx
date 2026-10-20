import React, { useEffect, useMemo, useState } from 'react';
import { EFFECT_USE_LABELS, type EffectKind, type EffectProvider, type EffectSummary, type EffectUse } from '@pixerate/editor/effects';
import { EffectThumbnail } from './EffectThumbnail';

export interface EffectsBrowserProps {
  /** The editor's provider; without one the browser says effects are unavailable. */
  provider: EffectProvider | null | undefined;
  /** Only effects with one of these uses (default: all but motion). */
  uses?: readonly EffectUse[];
  /** Only effects of these kinds (default: any). */
  kinds?: readonly EffectKind[];
  /** Called with the effect the user picks. */
  onPick: (effect: EffectSummary) => void;
  /** Draw previews with the provider's renderer (default true). */
  thumbnails?: boolean;
  /** Heading (default "Effects"). */
  title?: React.ReactNode;
  className?: string;
}

/**
 * Browses a provider's effects: a search box, a category filter (and a use filter when more than
 * one use is allowed), and a grid of effects with previews. Picking one calls `onPick`.
 */
export function EffectsBrowser({ provider, uses, kinds, onPick, thumbnails = true, title = 'Effects', className = '' }: EffectsBrowserProps) {
  const [all, setAll] = useState<readonly EffectSummary[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [use, setUse] = useState<EffectUse | ''>('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!provider) return setAll([]);
    let live = true;
    Promise.resolve()
      .then(() => provider.list())
      .then(
        (list) => live && (setAll(list), setError(null)),
        (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      live = false;
    };
  }, [provider]);
  const [found, setFound] = useState<readonly EffectSummary[]>([]);
  useEffect(() => {
    if (!provider) return setFound([]);
    let live = true;
    Promise.resolve()
      .then(() => provider.search(query, { ...(category ? { category } : {}), ...(use ? { use } : {}) }))
      .then((list) => live && setFound(list), () => live && setFound([]));
    return () => {
      live = false;
    };
  }, [provider, query, category, use]);
  const allowed = (e: EffectSummary) => (!kinds || kinds.includes(e.kind)) && (uses ? e.kind !== 'motion' || uses.includes('motion') : e.kind !== 'motion') && (!uses || e.uses.some((u) => uses.includes(u)));
  const categories = useMemo(() => [...new Set(all.filter(allowed).map((e) => e.category))], [all, uses, kinds]);
  const shown = found.filter(allowed);
  if (!provider)
    return (
      <div className={`rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground ${className}`} data-effects-browser="" data-effects-unavailable="">
        No effects provider is registered, so effects cannot be added. Effects already in the document are kept.
      </div>
    );
  return (
    <section className={`flex flex-col gap-2 ${className}`} data-effects-browser="" aria-label="Effects browser">
      {title && <h3 className="text-xs font-semibold">{title}</h3>}
      <div className="flex flex-wrap gap-1">
        <input
          type="search"
          className="min-w-0 flex-1 rounded border border-border bg-transparent px-1.5 py-0.5 text-xs"
          placeholder="Search effects"
          aria-label="Search effects"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <select className="rounded border border-border bg-transparent px-1 py-0.5 text-xs" aria-label="Category" value={category} onChange={(e) => setCategory(e.currentTarget.value)}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        {uses && uses.length > 1 && (
          <select className="rounded border border-border bg-transparent px-1 py-0.5 text-xs" aria-label="Use" value={use} onChange={(e) => setUse(e.currentTarget.value as EffectUse | '')}>
            <option value="">Any use</option>
            {uses.map((u) => (
              <option key={u} value={u}>
                {EFFECT_USE_LABELS[u]}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
      <ul className="grid max-h-96 grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-1.5 overflow-y-auto" role="list">
        {shown.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              className="flex w-full flex-col gap-1 rounded border border-transparent p-1 text-left hover:border-border focus-visible:border-border"
              title={e.description ?? e.name}
              data-effect-id={e.id}
              onClick={() => onPick(e)}
            >
              {thumbnails && <EffectThumbnail provider={provider} effect={e} />}
              <span className="truncate text-[11px] font-medium">{e.name}</span>
              <span className="truncate text-[10px] text-muted-foreground">{e.uses.map((u) => EFFECT_USE_LABELS[u]).join(' · ')}</span>
            </button>
          </li>
        ))}
      </ul>
      {!shown.length && !error && <p className="text-[11px] text-muted-foreground">No effects match.</p>}
    </section>
  );
}
