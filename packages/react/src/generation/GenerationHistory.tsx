import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DRIFT_TYPE_LABELS,
  recreateRequest,
  referenceRoleLabel,
  stableStringify,
  variationRequest,
  type AssetLookup,
  type GenerationRecord,
  type GenerationRecordFilter,
  type GenerationRecordStore,
  type ModelCapabilities,
  type RecreateMode,
  type RecreateOptions,
  type RecreateResult,
} from '@pixerate/editor/generation';

type Template = NonNullable<RecreateOptions['templates']>[number];

export interface UseGenerationRecordsResult {
  records: GenerationRecord[];
  loading: boolean;
  error: unknown;
  refresh: () => Promise<void>;
}

/**
 * Loads records from a `GenerationRecordStore` (newest first) and reloads
 * whenever the store changes. `filter` is compared by value.
 */
export function useGenerationRecords(
  store: GenerationRecordStore | null | undefined,
  filter?: GenerationRecordFilter,
): UseGenerationRecordsResult {
  const [records, setRecords] = useState<GenerationRecord[]>([]);
  const [loading, setLoading] = useState(!!store);
  const [error, setError] = useState<unknown>(null);
  const filterKey = stableStringify(filter ?? {});

  const refresh = useCallback(async () => {
    if (!store) {
      setRecords([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await store.list(filter);
      setRecords(next);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, filterKey]);

  useEffect(() => {
    void refresh();
    if (!store) return;
    return store.subscribe(() => void refresh());
  }, [store, refresh]);

  return { records, loading, error, refresh };
}

export interface GenerationHistoryProps {
  records: readonly GenerationRecord[];
  /** Current templates (drift detection, and resolution in `latest` mode). */
  templates?: readonly Template[];
  /** Current models (capability drift and re-planning). */
  capabilities?: ModelCapabilities | readonly ModelCapabilities[];
  /** Current assets (missing / changed asset drift). */
  assets?: AssetLookup;
  /** Recreate mode (controlled); otherwise a toggle starting at `exact`. */
  mode?: RecreateMode;
  onModeChange?: (mode: RecreateMode) => void;
  /** "Recreate": receives the rebuilt request and drift report. */
  onRecreate?: (result: RecreateResult, record: GenerationRecord) => void;
  /** "Variation": same request with a new seed. */
  onVariation?: (result: RecreateResult, record: GenerationRecord) => void;
  onRemove?: (record: GenerationRecord) => void;
  /** Extra content per record (e.g. output thumbnails). */
  renderPreview?: (record: GenerationRecord) => React.ReactNode;
  emptyText?: string;
  className?: string;
}

const severityClass = {
  info: 'text-sky-600 dark:text-sky-300',
  warning: 'text-amber-600 dark:text-amber-300',
  error: 'text-red-600 dark:text-red-400',
} as const;

/**
 * Generation history: one entry per record with its model, prompt, asset
 * role badges and the drift since it was made (templates edited, model
 * capabilities changed, settings no longer supported, assets missing), plus
 * Recreate and Variation buttons. Recreate is disabled when drift blocks it.
 */
export const GenerationHistory: React.FC<GenerationHistoryProps> = ({
  records,
  templates,
  capabilities,
  assets,
  mode: modeProp,
  onModeChange,
  onRecreate,
  onVariation,
  onRemove,
  renderPreview,
  emptyText = 'No generations yet.',
  className = '',
}) => {
  const [innerMode, setInnerMode] = useState<RecreateMode>('exact');
  const mode = modeProp ?? innerMode;
  const setMode = (next: RecreateMode) => {
    if (modeProp === undefined) setInnerMode(next);
    onModeChange?.(next);
  };
  const options = useMemo(() => ({ templates, capabilities, assets, mode }), [templates, capabilities, assets, mode]);
  const results = useMemo(() => records.map((record) => recreateRequest(record, options)), [records, options]);
  const models = useMemo(
    () => (capabilities ? (Array.isArray(capabilities) ? capabilities : [capabilities as ModelCapabilities]) : []),
    [capabilities],
  );

  return (
    <div className={`flex flex-col gap-2 text-sm ${className}`} data-generation-history="">
      <div className="flex items-center gap-2 text-xs" role="radiogroup" aria-label="Recreate mode">
        {(['exact', 'latest'] as const).map((value) => (
          <label key={value} className="inline-flex items-center gap-1">
            <input
              type="radio"
              name="generation-history-mode"
              value={value}
              checked={mode === value}
              onChange={() => setMode(value)}
              data-mode={value}
            />
            {value === 'exact' ? 'Exact (recorded versions)' : 'Latest templates & settings'}
          </label>
        ))}
      </div>
      {records.length === 0 && <p className="text-xs text-muted-foreground">{emptyText}</p>}
      <ul className="flex flex-col gap-2">
        {records.map((record, i) => {
          const result = results[i];
          const model = models.find((m) => m.id === record.provenance.modelId);
          const blocked = !result.ok;
          return (
            <li
              key={record.id}
              className="rounded-md border border-border p-2"
              data-record={record.id}
              data-drift={result.drift.length}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-medium">{model?.name ?? record.provenance.modelId}</span>
                <span className="text-muted-foreground">
                  {record.kind !== 'generate' && <span data-kind="">{record.kind} · </span>}
                  <time dateTime={record.createdAt}>{record.createdAt.replace('T', ' ').slice(0, 16)}</time>
                  {record.seed !== undefined && <> · seed {record.seed}</>}
                </span>
              </div>
              <p className="mt-1 line-clamp-3 break-words text-xs" data-record-prompt="">
                {record.provenance.resolvedPrompt}
              </p>
              {record.assets.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {record.assets.map((asset) => (
                    <span
                      key={`${asset.role}:${asset.id}`}
                      className="rounded-full bg-muted px-2 py-0.5 text-[10px]"
                      data-asset-role={asset.role}
                    >
                      {asset.id} · {referenceRoleLabel(asset.role, model)}
                    </span>
                  ))}
                </div>
              )}
              {renderPreview?.(record)}
              {result.drift.length > 0 && (
                <ul className="mt-1 flex flex-col gap-0.5 text-[11px]" data-drift-report="">
                  {result.drift.map((item, j) => (
                    <li key={j} className={severityClass[item.severity]} data-drift-type={item.type}>
                      <strong>{DRIFT_TYPE_LABELS[item.type]}:</strong> {item.message}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2 flex gap-2">
                {onRecreate && (
                  <button
                    type="button"
                    disabled={blocked}
                    title={blocked ? 'This generation cannot be recreated as recorded.' : undefined}
                    onClick={() => onRecreate(result, record)}
                    className="rounded border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
                    data-action="recreate"
                  >
                    Recreate
                  </button>
                )}
                {onVariation && (
                  <button
                    type="button"
                    onClick={() => onVariation(variationRequest(record, {}, options), record)}
                    className="rounded border border-border px-2 py-0.5 text-xs hover:bg-muted"
                    data-action="variation"
                  >
                    Variation
                  </button>
                )}
                {onRemove && (
                  <button
                    type="button"
                    onClick={() => onRemove(record)}
                    className="ml-auto rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
                    data-action="remove"
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
