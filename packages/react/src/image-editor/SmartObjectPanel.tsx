import React, { useEffect, useRef, useState } from 'react';
import type { EffectControl, ImageEditorController } from '@pixerate/editor/image-editor';
import {
  SMART_CONTENTS_ACCEPT,
  SMART_FILTER_MENU,
  downloadSmartObjectContents,
  replaceSmartObjectContentsFromFile,
  smartFilterControls,
  smartObjectPanel,
} from '@pixerate/editor/image-editor';

export interface SmartObjectPanelProps {
  controller: ImageEditorController;
  /** The smart object to show (default: the active layer). */
  layerId?: string | null;
  className?: string;
}

const button = 'px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 hover:text-white disabled:opacity-40';

/**
 * A smart object's contents and smart filters: Edit Contents, Replace Contents…, Export Contents,
 * New Smart Object via Copy and Rasterize; the smart filter stack (add Develop or Blur, the
 * stack's switch, each filter's eye, order, remove and, when expanded, blend mode, opacity and
 * settings); and the filter mask (add, enable, link, paint it, remove). Every change is one undo
 * step (a slider drag is one step too).
 */
export const SmartObjectPanel: React.FC<SmartObjectPanelProps> = ({ controller, layerId, className }) => {
  const [, setTick] = useState(0);
  useEffect(() => controller.subscribe(() => setTick((n) => n + 1)), [controller]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** Whether the next slider change records an undo step (the first of a drag does, the rest replace it). */
  const commitNext = useRef(true);

  const model = smartObjectPanel(controller, layerId);
  const id = model.layerId;
  const attempt = (fn: () => unknown) => {
    try {
      setError(null);
      const r = fn();
      if (r instanceof Promise) r.catch((err) => setError(err instanceof Error ? err.message : String(err)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const sliderEvents = {
    onPointerDown: () => (commitNext.current = true),
    onPointerUp: () => (commitNext.current = true),
    onKeyDown: () => (commitNext.current = true),
  };

  if (!model.available || !id || !model.contents) {
    return (
      <div className={`text-xs text-slate-500 ${className ?? ''}`} data-testid="smart-object">
        {model.reason}
      </div>
    );
  }
  const readOnly = !model.editable;
  const state = controller.getState();
  const change = (filterId: string, c: EffectControl, value: unknown, drag = false) =>
    attempt(() => {
      controller.updateSmartFilter(id, filterId, { [c.key]: value }, drag ? commitNext.current : true);
      if (drag) commitNext.current = false;
    });

  const renderControl = (filterId: string, c: EffectControl) => {
    if (c.type === 'select') {
      return (
        <label key={c.key} className="flex flex-col gap-0.5">
          <span className="text-slate-400">{c.label}</span>
          <select aria-label={c.label} value={c.value} disabled={readOnly} onChange={(e) => change(filterId, c, e.target.value)} className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1">
            {c.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      );
    }
    if (c.type !== 'range') return null;
    const k = c.percent ? 100 : 1;
    const shown = Math.round(c.value * k * 100) / 100;
    return (
      <label key={c.key} className="flex flex-col gap-0.5">
        <span className="text-slate-400">
          {c.label} {shown}
          {c.unit}
        </span>
        <input
          type="range"
          aria-label={c.label}
          min={c.min * k}
          max={c.max * k}
          step={c.step * k}
          value={shown}
          disabled={readOnly}
          {...sliderEvents}
          onChange={(e) => change(filterId, c, Number(e.target.value) / k, true)}
          className="accent-indigo-500"
        />
      </label>
    );
  };

  const c = model.contents;
  return (
    <div className={`flex flex-col gap-1.5 text-xs text-slate-200 ${className ?? ''}`} data-testid="smart-object" aria-label="Smart object" role="group">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-semibold text-slate-300">Smart Object</span>
        <span className="text-slate-400" data-testid="smart-contents">
          {c.name} · {c.width} × {c.height} {c.kind === 'document' ? 'layers' : 'px'}
          {c.instances > 1 ? ` · ${c.instances} linked` : ''}
          {c.linkedPath ? ` · linked file ${c.linkedPath}` : ''}
          {c.decoded ? '' : ' · not decoded here'}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Smart object actions">
        <button type="button" className={button} disabled={!c.decoded} onClick={() => attempt(() => controller.editSmartObjectContents(id))}>
          Edit Contents
        </button>
        <button type="button" className={button} disabled={readOnly} onClick={() => fileInput.current?.click()}>
          Replace Contents…
        </button>
        <button type="button" className={button} onClick={() => attempt(() => downloadSmartObjectContents(controller, id))}>
          Export Contents
        </button>
        <button type="button" className={button} disabled={readOnly} onClick={() => attempt(() => controller.copySmartObject(id, false))}>
          New via Copy
        </button>
        <button type="button" className={button} disabled={readOnly} onClick={() => attempt(() => controller.rasterizeSmartObject(id))}>
          Rasterize
        </button>
        <input
          ref={fileInput}
          type="file"
          accept={SMART_CONTENTS_ACCEPT}
          className="hidden"
          data-testid="smart-contents-input"
          aria-label="Replace contents with a file"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (file) attempt(() => replaceSmartObjectContentsFromFile(controller, id, file));
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-1.5">
        <span className="font-semibold text-slate-300">Smart Filters</span>
        <label className="flex items-center gap-1 text-slate-300">
          <input
            type="checkbox"
            aria-label="Smart filters on"
            checked={model.filtersEnabled}
            disabled={readOnly || !model.filters.length}
            onChange={(e) => attempt(() => controller.setSmartFiltersEnabled(id, e.target.checked))}
            className="accent-indigo-500"
          />
          On
        </label>
        <select
          aria-label="Add smart filter"
          value=""
          disabled={readOnly}
          onChange={(e) => {
            const kind = e.target.value;
            if (kind) attempt(() => setOpen(controller.addSmartFilter(id, { kind }).id));
          }}
          className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1"
        >
          <option value="">Add smart filter…</option>
          {SMART_FILTER_MENU.map((m) => (
            <option key={m.kind} value={m.kind}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter mask" data-testid="smart-filter-mask">
        <span className="text-slate-400">Filter mask</span>
        {model.mask ? (
          <>
            <button
              type="button"
              className={button}
              aria-pressed={state.activeLayerId === id && state.activeTarget === 'filter-mask'}
              onClick={() => attempt(() => controller.setActiveLayer(id, 'filter-mask'))}
            >
              Paint
            </button>
            <label className="flex items-center gap-1 text-slate-300">
              <input type="checkbox" aria-label="Filter mask on" checked={model.mask.enabled} disabled={readOnly} onChange={(e) => attempt(() => controller.setSmartFilterMask(id, 'keep', { enabled: e.target.checked }))} className="accent-indigo-500" />
              On
            </label>
            <label className="flex items-center gap-1 text-slate-300">
              <input type="checkbox" aria-label="Filter mask linked" checked={model.mask.linked} disabled={readOnly} onChange={(e) => attempt(() => controller.setSmartFilterMask(id, 'keep', { linked: e.target.checked }))} className="accent-indigo-500" />
              Linked
            </label>
            <button type="button" className={button} disabled={readOnly || !controller.hasSelection} onClick={() => attempt(() => controller.setSmartFilterMask(id, 'selection'))}>
              From Selection
            </button>
            <button type="button" className={button} aria-label="Remove filter mask" disabled={readOnly} onClick={() => attempt(() => controller.setSmartFilterMask(id, 'none'))}>
              ✕
            </button>
          </>
        ) : (
          <>
            <button type="button" className={button} disabled={readOnly} onClick={() => attempt(() => controller.setSmartFilterMask(id, 'reveal-all'))}>
              Add
            </button>
            <button type="button" className={button} disabled={readOnly || !controller.hasSelection} onClick={() => attempt(() => controller.setSmartFilterMask(id, 'selection'))}>
              From Selection
            </button>
          </>
        )}
      </div>

      <ul className="flex flex-col gap-1" aria-label="Smart filters">
        {model.filters.map((row, i) => {
          const expanded = open === row.filter.id;
          const last = model.filters.length - 1;
          return (
            <li key={row.filter.id} data-filter-id={row.filter.id} className="rounded bg-slate-900/60 ring-1 ring-slate-800">
              <div className="flex items-center gap-1.5 px-1.5 py-1">
                <input
                  type="checkbox"
                  aria-label={`${row.label} on`}
                  checked={row.filter.enabled}
                  disabled={readOnly}
                  onChange={(e) => attempt(() => controller.updateSmartFilter(id, row.filter.id, { enabled: e.target.checked }))}
                  className="accent-indigo-500"
                />
                <button
                  type="button"
                  aria-expanded={expanded}
                  className={`flex-1 text-left ${row.filter.enabled && model.filtersEnabled ? '' : 'text-slate-500'}`}
                  title={row.drawn ? undefined : 'A Photoshop filter kept from the file: written back, not drawn here.'}
                  onClick={() => setOpen(expanded ? null : row.filter.id)}
                >
                  {row.label}
                  {row.drawn ? '' : ' (not drawn)'}
                </button>
                <button type="button" className={button} aria-label={`Move ${row.label} up`} disabled={readOnly || i === 0} onClick={() => attempt(() => controller.moveSmartFilter(id, row.filter.id, row.index + 1))}>
                  ↑
                </button>
                <button type="button" className={button} aria-label={`Move ${row.label} down`} disabled={readOnly || i === last} onClick={() => attempt(() => controller.moveSmartFilter(id, row.filter.id, row.index - 1))}>
                  ↓
                </button>
                <button type="button" className={button} aria-label={`Remove ${row.label}`} disabled={readOnly} onClick={() => attempt(() => controller.removeSmartFilter(id, row.filter.id))}>
                  ✕
                </button>
              </div>
              {expanded && (
                <div className="grid grid-cols-2 gap-x-2 gap-y-1 px-1.5 pb-1.5" data-testid="smart-filter-settings">
                  {smartFilterControls(row.filter).map((ctl) => renderControl(row.filter.id, ctl))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="text-rose-400">
          {error}
        </p>
      )}
    </div>
  );
};
