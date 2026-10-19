import React, { useState } from 'react';
import { BLEND_MENU_GROUPS, type BlendMode, type PaintEditorController, type PaintLayerInfo } from '@pixerate/editor/paint-editor';
import { usePaintEditorState } from './usePaintEditor';
import { ErrorLine, button, chip, panel, useAttempt } from './shared';

export interface PaintLayersPanelProps {
  controller: PaintEditorController;
  className?: string;
}

/** Siblings of a layer, bottom first, and its index among them. */
function siblingIndex(layers: PaintLayerInfo[], l: PaintLayerInfo): { index: number; count: number } {
  const sibs = layers.filter((x) => x.parentId === l.parentId).reverse();
  return { index: sibs.findIndex((x) => x.id === l.id), count: sibs.length };
}

/**
 * The layer stack, top first: visibility, names (double-click to rename), the active layer's
 * opacity, blend mode and locks, and new layer / group, duplicate, move up / down, merge down and
 * delete. Every change is one undo step.
 */
export const PaintLayersPanel: React.FC<PaintLayersPanelProps> = ({ controller, className }) => {
  usePaintEditorState(controller);
  const [error, attempt] = useAttempt();
  const [renaming, setRenaming] = useState<string | null>(null);
  const layers = controller.listLayers();
  const active = layers.find((l) => l.active) ?? null;
  const move = (delta: number) => {
    if (!active) return;
    const { index, count } = siblingIndex(layers, active);
    const to = Math.min(count - 1, Math.max(0, index + delta));
    if (to !== index) attempt(() => controller.moveLayer(active.id, to));
  };

  return (
    <div className={`${panel} ${className ?? ''}`} data-testid="paint-layers-panel">
      <div className="flex flex-wrap gap-1">
        <button type="button" className={button} onClick={() => attempt(() => controller.addLayer())}>
          New layer
        </button>
        <button type="button" className={button} onClick={() => attempt(() => controller.addLayer({ type: 'group' }))}>
          New group
        </button>
        <button type="button" className={button} disabled={!active} onClick={() => active && attempt(() => controller.duplicateLayer(active.id))}>
          Duplicate
        </button>
        <button type="button" className={button} disabled={!active} aria-label="Move layer up" onClick={() => move(1)}>
          ↑
        </button>
        <button type="button" className={button} disabled={!active} aria-label="Move layer down" onClick={() => move(-1)}>
          ↓
        </button>
        <button type="button" className={button} disabled={!active} onClick={() => active && attempt(() => controller.mergeDown(active.id))}>
          Merge down
        </button>
        <button type="button" className={button} disabled={!active || layers.length < 2} onClick={() => active && attempt(() => controller.removeLayer(active.id))}>
          Delete
        </button>
      </div>
      <ul role="tree" aria-label="Layers" className="flex flex-col gap-0.5">
        {layers.map((l) => (
          <li
            key={l.id}
            role="treeitem"
            aria-selected={l.active}
            className={`flex items-center gap-1.5 rounded px-1.5 py-1 cursor-pointer ${l.active ? 'bg-indigo-600/30 ring-1 ring-indigo-500' : 'hover:bg-slate-800'}`}
            style={{ paddingLeft: 6 + l.depth * 12 }}
            onClick={() => controller.setActiveLayer(l.id)}
          >
            <button
              type="button"
              aria-label={l.visible ? `Hide ${l.name}` : `Show ${l.name}`}
              className={`w-5 text-[11px] ${l.visible ? 'text-slate-200' : 'text-slate-600'}`}
              onClick={(e) => {
                e.stopPropagation();
                attempt(() => controller.updateLayer(l.id, { visible: !l.visible }));
              }}
            >
              {l.visible ? '●' : '○'}
            </button>
            {renaming === l.id ? (
              <input
                autoFocus
                aria-label="Layer name"
                defaultValue={l.name}
                className="flex-1 rounded bg-slate-800 px-1"
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  setRenaming(null);
                  if (e.target.value.trim() && e.target.value !== l.name) attempt(() => controller.updateLayer(l.id, { name: e.target.value }));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setRenaming(null);
                }}
              />
            ) : (
              <span className="flex-1 truncate" onDoubleClick={() => setRenaming(l.id)}>
                {l.type === 'group' ? '▸ ' : ''}
                {l.name}
              </span>
            )}
            {l.locks.pixels || l.locks.all ? <span title="Locked">🔒</span> : null}
          </li>
        ))}
      </ul>
      {active && (
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2">
            <span className="w-14 text-slate-400">Opacity</span>
            <input
              type="range"
              aria-label="Layer opacity"
              min={0}
              max={1}
              step={0.01}
              value={active.opacity}
              onChange={(e) => attempt(() => controller.updateLayer(active.id, { opacity: Number(e.target.value) }))}
              className="flex-1 accent-indigo-500"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="w-14 text-slate-400">Blend</span>
            <select aria-label="Layer blend" value={active.blend} onChange={(e) => attempt(() => controller.updateLayer(active.id, { blend: e.target.value as BlendMode }))} className="flex-1 rounded bg-slate-800 px-1 py-0.5">
              {active.type === 'group' && <option value="pass-through">Pass through</option>}
              {BLEND_MENU_GROUPS.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.modes.map((m) => (
                    <option key={m.id} value={m.id} title={m.description}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <div className="flex gap-1">
            {(['pixels', 'transparency'] as const).map((k) => (
              <button key={k} type="button" aria-pressed={Boolean(active.locks[k])} className={chip(Boolean(active.locks[k]))} onClick={() => attempt(() => controller.updateLayer(active.id, { locks: { [k]: !active.locks[k] } }))}>
                {k === 'pixels' ? 'Lock pixels' : 'Lock transparency'}
              </button>
            ))}
            <button type="button" aria-pressed={active.clipped} className={chip(active.clipped)} onClick={() => attempt(() => controller.updateLayer(active.id, { clipped: !active.clipped }))}>
              Clip
            </button>
          </div>
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
};
