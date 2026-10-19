import React, { useEffect, useRef, useState } from 'react';
import type { ImageEditorController, ImageLayer, LayerMenuAction, LayerPanelRow, PixelBuffer } from '@pixerate/editor/image-editor';
import {
  BLEND_MODES,
  dropPlacement,
  dropZone,
  layerBadge,
  layerMenu,
  layerPanelRows,
  runLayerMenuAction,
} from '@pixerate/editor/image-editor';

export interface LayersPanelProps {
  controller: ImageEditorController;
  /** Thumbnail size in px (default 32). */
  thumbnailSize?: number;
  className?: string;
}

const iconButton = 'px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 hover:text-white disabled:opacity-40';
const rowClass = (active: boolean) =>
  `flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer select-none ${active ? 'bg-indigo-600/30 ring-1 ring-indigo-500' : 'hover:bg-slate-800'}`;

/** Draws a thumbnail (RGBA pixels) into a small canvas; nothing without a 2D context. */
const Thumbnail: React.FC<{ pixels: PixelBuffer | null; size: number; label: string; onClick?: (e: React.MouseEvent) => void; selected?: boolean; testId?: string }> = ({
  pixels,
  size,
  label,
  onClick,
  selected,
  testId,
}) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !pixels || typeof ctx.createImageData !== 'function') return;
    canvas.width = pixels.width;
    canvas.height = pixels.height;
    const img = ctx.createImageData(pixels.width, pixels.height);
    img.data.set(pixels.data as ArrayLike<number>);
    ctx.putImageData(img, 0, 0);
  }, [pixels]);
  return (
    <canvas
      ref={ref}
      role={onClick ? 'button' : 'img'}
      aria-label={label}
      data-testid={testId}
      onClick={onClick}
      style={{ width: size, height: size }}
      className={`shrink-0 rounded bg-[repeating-conic-gradient(#334155_0%_25%,#1e293b_0%_50%)] [background-size:8px_8px] object-contain ${selected ? 'ring-2 ring-white' : 'ring-1 ring-slate-700'}`}
    />
  );
};

/**
 * The layer stack, top first: visibility, thumbnails, names (double-click to rename), locks,
 * mask thumbnails (click to paint the mask, Shift-click to disable it), drag to reorder or drop
 * into a group, opacity / fill / blend / clipping for the active layer, and the layer menu
 * (right-click a row, or the ⋯ button). Every action is one undo step on the controller.
 */
export const LayersPanel: React.FC<LayersPanelProps> = ({ controller, thumbnailSize = 32, className }) => {
  const [, setTick] = useState(0);
  useEffect(() => controller.subscribe(() => setTick((n) => n + 1)), [controller]);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  /** Whether the next slider change records an undo step (the first of a drag does, the rest replace it). */
  const commitNext = useRef(true);

  const state = controller.getState();
  const rows = layerPanelRows(state.layers, state.activeLayerId);
  const active = controller.getActiveLayer();

  const attempt = (fn: () => unknown) => {
    try {
      setError(null);
      fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const run = async (action: LayerMenuAction) => {
    setMenu(null);
    setError(await runLayerMenuAction(controller, action));
  };
  const prop = (key: 'opacity' | 'fillOpacity', value: number) =>
    attempt(() => {
      controller.setLayerProperties(active!.id, { [key]: value }, commitNext.current);
      commitNext.current = false;
    });
  const sliderEvents = {
    onPointerDown: () => (commitNext.current = true),
    onPointerUp: () => (commitNext.current = true),
    onKeyDown: () => (commitNext.current = true),
  };

  const onDrop = (e: React.DragEvent, row: LayerPanelRow) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/x-pixerate-layer') || drag;
    setDrag(null);
    if (!id) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const fraction = rect.height ? (e.clientY - rect.top) / rect.height : 0.5;
    const placement = dropPlacement(state.layers, id, row.layer.id, dropZone(fraction, row.layer.type === 'group'));
    if (placement) attempt(() => controller.moveLayer(id, placement));
  };

  const thumb = (layer: ImageLayer) => (layer.type === 'pixel' ? controller.getLayerThumbnail(layer.id, { maxSide: 64 }) : null);
  const maskThumb = (layer: ImageLayer) => (layer.mask && !layer.mask.source ? controller.getLayerThumbnail(layer.id, { maxSide: 64, mask: true }) : null);

  const locked = (layer: ImageLayer) => Boolean(layer.locks?.all || layer.locks?.pixels || layer.locks?.position || layer.locks?.transparency);

  return (
    <div className={`flex flex-col gap-2 text-xs text-slate-200 ${className ?? ''}`} data-testid="layers-panel" onClick={() => menu && setMenu(null)}>
      <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Layer actions">
        <button type="button" className={iconButton} onClick={() => run('new-layer')}>New Layer</button>
        <button type="button" className={iconButton} onClick={() => run('new-group')}>New Group</button>
        <button type="button" className={iconButton} disabled={!active} onClick={() => run('duplicate')}>Duplicate</button>
        <button type="button" className={iconButton} disabled={!active} onClick={() => run('add-mask')}>Add Mask</button>
        <button type="button" className={iconButton} disabled={!active} onClick={() => run('delete')}>Delete</button>
        <button
          type="button"
          className={iconButton}
          aria-label="Layer menu"
          aria-haspopup="menu"
          onClick={(e) => {
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setMenu(menu ? null : { x: r.left, y: r.bottom });
          }}
        >
          ⋯
        </button>
      </div>

      {active && (
        <div className="grid grid-cols-2 gap-x-2 gap-y-1 items-center" data-testid="layer-properties">
          <label className="flex flex-col gap-0.5">
            <span className="text-slate-400">Opacity {Math.round(active.opacity * 100)}%</span>
            <input
              type="range"
              min={0}
              max={100}
              aria-label="Layer opacity"
              value={Math.round(active.opacity * 100)}
              {...sliderEvents}
              onChange={(e) => prop('opacity', Number(e.target.value) / 100)}
              className="accent-indigo-500"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-slate-400">Fill {Math.round(((active.type === 'pixel' ? active.fillOpacity : undefined) ?? 1) * 100)}%</span>
            <input
              type="range"
              min={0}
              max={100}
              aria-label="Layer fill"
              disabled={active.type !== 'pixel'}
              value={Math.round(((active.type === 'pixel' ? active.fillOpacity : undefined) ?? 1) * 100)}
              {...sliderEvents}
              onChange={(e) => prop('fillOpacity', Number(e.target.value) / 100)}
              className="accent-indigo-500 disabled:opacity-40"
            />
          </label>
          <select
            aria-label="Layer blend mode"
            className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1"
            value={active.blend}
            onChange={(e) => attempt(() => controller.setLayerProperties(active.id, { blend: e.target.value as never }))}
          >
            {active.type === 'group' && <option value="pass-through">Pass Through</option>}
            {BLEND_MODES.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-slate-300">
            <input
              type="checkbox"
              aria-label="Clip to layer below"
              checked={Boolean(active.clipped)}
              onChange={(e) => attempt(() => controller.setLayerProperties(active.id, { clipped: e.target.checked }))}
              className="accent-indigo-500"
            />
            Clip to below
          </label>
          <div className="col-span-2 flex flex-wrap gap-2 text-slate-400" role="group" aria-label="Layer locks">
            {(['pixels', 'transparency', 'position', 'all'] as const).map((k) => (
              <label key={k} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  aria-label={`Lock ${k}`}
                  checked={Boolean(active.locks?.[k])}
                  onChange={(e) => attempt(() => controller.setLayerProperties(active.id, { locks: { ...active.locks, [k]: e.target.checked } }))}
                  className="accent-indigo-500"
                />
                {k}
              </label>
            ))}
          </div>
        </div>
      )}

      <ul className="flex flex-col gap-0.5" role="tree" aria-label="Layers">
        {rows.map((row) => {
          const { layer } = row;
          return (
            <li
              key={layer.id}
              role="treeitem"
              aria-selected={row.active}
              aria-level={row.depth + 1}
              data-layer-id={layer.id}
              draggable={!layer.locks?.all}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/x-pixerate-layer', layer.id);
                setDrag(layer.id);
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => onDrop(e, row)}
              tabIndex={0}
              onClick={() => attempt(() => controller.setActiveLayer(layer.id, 'pixels'))}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  attempt(() => controller.setActiveLayer(layer.id, 'pixels'));
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                controller.setActiveLayer(layer.id, state.activeLayerId === layer.id ? state.activeTarget : 'pixels');
                setMenu({ x: e.clientX, y: e.clientY });
              }}
              className={rowClass(row.active)}
              style={{ paddingLeft: 6 + row.depth * 14 }}
            >
              <button
                type="button"
                aria-label={layer.visible ? `Hide ${row.label}` : `Show ${row.label}`}
                aria-pressed={layer.visible}
                className="w-4 text-center text-slate-300"
                onClick={(e) => {
                  e.stopPropagation();
                  attempt(() => controller.setLayerProperties(layer.id, { visible: !layer.visible }));
                }}
              >
                {layer.visible ? '●' : '○'}
              </button>
              {layer.type === 'group' && (
                <button
                  type="button"
                  aria-label={layer.collapsed ? `Expand ${row.label}` : `Collapse ${row.label}`}
                  className="w-3 text-slate-400"
                  onClick={(e) => {
                    e.stopPropagation();
                    attempt(() => controller.setLayerProperties(layer.id, { collapsed: !layer.collapsed }));
                  }}
                >
                  {layer.collapsed ? '▸' : '▾'}
                </button>
              )}
              {row.clipped && <span className="text-slate-500" aria-label="Clipped">↳</span>}
              {layer.type === 'pixel' ? (
                <Thumbnail
                  pixels={thumb(layer)}
                  size={thumbnailSize}
                  label={`${row.label} pixels`}
                  selected={row.active && state.activeTarget === 'pixels' && Boolean(layer.mask)}
                />
              ) : (
                <span
                  className="shrink-0 grid place-items-center rounded bg-slate-800 text-[9px] text-slate-400 ring-1 ring-slate-700"
                  style={{ width: thumbnailSize, height: thumbnailSize }}
                >
                  {layerBadge(layer)}
                </span>
              )}
              {layer.mask && (
                <Thumbnail
                  pixels={maskThumb(layer)}
                  size={thumbnailSize}
                  label={`${row.label} mask${layer.mask.enabled === false ? ' (disabled)' : ''}`}
                  testId="layer-mask-thumbnail"
                  selected={row.active && state.activeTarget === 'mask'}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (e.shiftKey) attempt(() => controller.setLayerMaskProps(layer.id, { enabled: layer.mask!.enabled === false }));
                    else attempt(() => controller.setActiveLayer(layer.id, 'mask'));
                  }}
                />
              )}
              {renaming === layer.id ? (
                <input
                  autoFocus
                  aria-label="Layer name"
                  defaultValue={layer.name || row.label}
                  className="flex-1 min-w-0 bg-slate-900 border border-slate-600 rounded px-1"
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    setRenaming(null);
                    if (e.target.value.trim() && e.target.value !== layer.name) attempt(() => controller.setLayerProperties(layer.id, { name: e.target.value }));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <span
                  className={`flex-1 min-w-0 truncate ${layer.visible ? '' : 'text-slate-500'}`}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setRenaming(layer.id);
                  }}
                >
                  {row.label}
                </span>
              )}
              {locked(layer) && <span aria-label="Locked" className="text-slate-400">🔒</span>}
              {layer.blend !== 'normal' && layer.blend !== 'pass-through' && <span className="text-[9px] text-slate-500">{layer.blend}</span>}
            </li>
          );
        })}
      </ul>

      {error && (
        <p role="alert" className="text-rose-400">
          {error}
        </p>
      )}

      {menu && (
        <div
          role="menu"
          aria-label="Layer menu"
          className="fixed z-50 min-w-44 rounded border border-slate-700 bg-slate-900 py-1 shadow-xl"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.key === 'Escape' && setMenu(null)}
        >
          {layerMenu(controller).map((item) => (
            <button
              key={item.action}
              type="button"
              role="menuitem"
              disabled={!item.enabled}
              className="block w-full px-3 py-1 text-left hover:bg-slate-800 disabled:opacity-40"
              onClick={() => run(item.action)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
