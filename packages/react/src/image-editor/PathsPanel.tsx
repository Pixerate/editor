import React, { useEffect, useState } from 'react';
import type { ImageEditorController } from '@pixerate/editor/image-editor';
import { pathSvgData, selectionModeFromModifiers } from '@pixerate/editor/image-editor';
import { imageSectionTitleClass } from './styles';

export interface PathsPanelProps {
  controller: ImageEditorController;
  /** Thumbnail size in CSS pixels (default 32). */
  thumbnailSize?: number;
  className?: string;
}

const btn = (on = false) =>
  `px-2 py-1 rounded-md border text-[11px] transition-colors disabled:opacity-40 ${
    on ? 'bg-primary border-primary text-primary-foreground' : 'bg-background border-border text-foreground hover:bg-accent hover:text-accent-foreground'
  }`;

/**
 * The Paths panel: the document's saved paths and its Work Path (in italics) with outline
 * thumbnails. Click selects a path, double-click renames it (renaming the Work Path saves it).
 * Load as Selection (Shift adds, Alt subtracts), Make Work Path from the selection, Fill and
 * Stroke on the active layer with a colour and width, Add Vector Mask to the active layer,
 * Duplicate and Delete. Every change is one undo step on the controller.
 */
export const PathsPanel: React.FC<PathsPanelProps> = ({ controller, thumbnailSize = 32, className = '' }) => {
  const [, setTick] = useState(0);
  useEffect(() => controller.subscribe(() => setTick((n) => n + 1)), [controller]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [color, setColor] = useState('#000000');
  const [width, setWidth] = useState(2);
  const [error, setError] = useState<string | null>(null);
  const paths = controller.getPaths();
  const activeId = controller.getState().activePathId ?? null;
  const active = paths.find((p) => p.id === activeId) ?? null;
  const hasSelection = Boolean(controller.getSelection());
  const { width: w, height: h } = controller.getState().imageDimensions;
  const attempt = (fn: () => unknown) => {
    setError(null);
    try {
      fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div data-testid="paths-panel" className={`flex flex-col gap-2 text-xs ${className}`}>
      <span className={imageSectionTitleClass}>Paths</span>
      {paths.length === 0 && <p className="text-muted-foreground">No paths. Make a work path from a selection.</p>}
      <ul role="list" className="flex flex-col gap-0.5">
        {paths.map((p) => (
          <li
            key={p.id}
            data-testid="path-row"
            aria-current={p.id === activeId ? 'true' : undefined}
            className={`flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer select-none ${p.id === activeId ? 'bg-primary/30 ring-1 ring-primary' : 'hover:bg-muted'}`}
            onClick={() => attempt(() => controller.setActivePath(p.id))}
            onDoubleClick={() => setRenaming(p.id)}
          >
            <svg aria-hidden="true" viewBox={`0 0 ${w || 1} ${h || 1}`} style={{ width: thumbnailSize, height: thumbnailSize }} className="shrink-0 rounded ring-1 ring-border bg-background">
              <path d={pathSvgData(p)} fill="currentColor" fillOpacity={0.25} stroke="currentColor" strokeWidth={Math.max(w, h) / 64} fillRule={p.fillRule ?? 'nonzero'} />
            </svg>
            {renaming === p.id ? (
              <input
                autoFocus
                aria-label="Path name"
                defaultValue={p.work ? '' : p.name}
                placeholder="Path name"
                className="min-w-0 flex-1 bg-background border border-border rounded px-1 py-0.5 text-foreground"
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  setRenaming(null);
                  const name = e.currentTarget.value.trim();
                  if (name && name !== p.name) attempt(() => controller.renamePath(p.id, name));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') setRenaming(null);
                }}
              />
            ) : (
              <span className={`min-w-0 flex-1 truncate ${p.work ? 'italic' : ''}`}>{p.name}</span>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          className={btn()}
          disabled={!active}
          title="Load the path as the selection (Shift adds, Alt subtracts)"
          onClick={(e) => attempt(() => controller.loadPathAsSelection(active!.id, { mode: selectionModeFromModifiers(e, 'replace') }))}
        >
          Load as Selection
        </button>
        <button type="button" className={btn()} disabled={!hasSelection} onClick={() => attempt(() => controller.makeWorkPath())}>
          Make Work Path
        </button>
        {active?.work && (
          <button type="button" className={btn()} onClick={() => setRenaming(active.id)}>
            Save Path
          </button>
        )}
        <button type="button" className={btn()} disabled={!active} onClick={() => attempt(() => controller.addVectorMaskFromPath(active!.id))}>
          Add Vector Mask
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <input type="color" aria-label="Path paint colour" value={color} onChange={(e) => setColor(e.target.value)} className="h-6 w-8 bg-background border border-border rounded" />
        <button type="button" className={btn()} disabled={!active} onClick={() => attempt(() => controller.fillPath(active!.id, { color }))}>
          Fill Path
        </button>
        <label className="flex items-center gap-1 text-muted-foreground">
          <input
            type="number"
            min={0.5}
            max={250}
            step={0.5}
            aria-label="Stroke width"
            value={width}
            onChange={(e) => setWidth(Math.min(250, Math.max(0.5, Number(e.target.value) || 1)))}
            className="w-12 bg-background border border-border rounded px-1 py-0.5 text-foreground"
          />
          px
        </label>
        <button type="button" className={btn()} disabled={!active} onClick={() => attempt(() => controller.strokePath(active!.id, { width, color }))}>
          Stroke Path
        </button>
      </div>
      <div className="flex flex-wrap gap-1">
        <button type="button" className={btn()} disabled={!active} onClick={() => attempt(() => controller.duplicatePath(active!.id))}>
          Duplicate
        </button>
        <button type="button" className={btn()} disabled={!active} onClick={() => attempt(() => controller.deletePath(active!.id))}>
          Delete
        </button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
};
