import React from 'react';
import { VECTOR_ENVELOPE_STYLE_OPTIONS, getVectorEnvelopePanel, type VectorEditorController, type VectorEnvelopeParams } from '@pixerate/editor/vector';
import { useVectorEditorState } from './useVectorEditor';

const buttonClass =
  'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40';
const numberClass = 'h-7 w-14 rounded border border-border bg-background px-1.5 text-xs';
const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
const labelClass = 'w-full truncate text-[11px] text-muted-foreground';

const SLIDERS: { key: 'bend' | 'horizontal' | 'vertical'; label: string }[] = [
  { key: 'bend', label: 'Bend %' },
  { key: 'horizontal', label: 'Horizontal distortion %' },
  { key: 'vertical', label: 'Vertical distortion %' },
];

export interface VectorEnvelopePanelProps {
  controller: VectorEditorController;
  className?: string;
}

/**
 * Envelope distortion of the selection: Make with Warp, Mesh or Top Object, and for one selected
 * object with an envelope its warp preset, bend, horizontal and vertical distortion, orientation and
 * mesh rows and columns, plus Release and Expand. Edit the mesh on the canvas with the Envelope
 * tool. Slider drags are one undo step each.
 */
export function VectorEnvelopePanel({ controller, className }: VectorEnvelopePanelProps) {
  const state = useVectorEditorState(controller);
  const panel = getVectorEnvelopePanel(state);
  // The mesh size Make with Mesh uses (an envelope's own size once it has one).
  const [size, setSize] = React.useState({ rows: 2, columns: 2 });
  if (!panel) return null;
  const env = panel.envelope;
  const ids = panel.nodeId ? [panel.nodeId] : undefined;
  const end = () => controller.endMergedEdit();
  const set = (patch: Partial<VectorEnvelopeParams>, merge = false) => controller.envelope(patch, { ids, merge });
  const rows = env?.params.rows ?? size.rows;
  const columns = env?.params.columns ?? size.columns;
  const setCount = (key: 'rows' | 'columns', raw: string) => {
    const n = Math.round(parseFloat(raw));
    if (!Number.isFinite(n) || n < 1 || n > 16) return;
    if (env) set({ [key]: n });
    else setSize({ ...size, [key]: n });
  };
  return (
    <div className={`space-y-2 ${className ?? ''}`} data-vector-envelope="" aria-label="Envelope">
      <div className="flex flex-wrap items-center gap-1">
        <span className="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Envelope</span>
        <button type="button" data-vector-envelope-action="warp" className={buttonClass} title="Make with Warp" aria-label="Make with Warp" disabled={!panel.canMake || !!env} onClick={() => set({ style: 'arc', bend: 50 })}>
          Warp
        </button>
        <button
          type="button"
          data-vector-envelope-action="mesh"
          className={buttonClass}
          title="Make with Mesh"
          aria-label="Make with Mesh"
          disabled={!panel.canMake || !!env}
          onClick={() => set({ style: 'mesh', rows: size.rows, columns: size.columns })}
        >
          Mesh
        </button>
        <button
          type="button"
          data-vector-envelope-action="top"
          className={buttonClass}
          title="Make with Top Object"
          aria-label="Make with Top Object"
          disabled={!panel.canMakeWithTopObject}
          onClick={() => controller.makeEnvelopeWithTopObject({ rows: size.rows, columns: size.columns })}
        >
          Top
        </button>
        <button type="button" data-vector-envelope-action="release" className={buttonClass} title="Release Envelope" aria-label="Release Envelope" disabled={!panel.canRelease} onClick={() => controller.releaseEnvelope()}>
          Release
        </button>
        <button type="button" data-vector-envelope-action="expand" className={buttonClass} title="Expand Envelope" aria-label="Expand Envelope" disabled={!panel.canRelease} onClick={() => controller.expandAppearance()}>
          Expand
        </button>
      </div>
      {env && (
        <label className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-foreground" data-vector-envelope-param="style">
          <span className={labelClass}>Warp</span>
          <select aria-label="Envelope warp" className={selectClass} value={env.params.style} onChange={(e) => set({ style: e.target.value as VectorEnvelopeParams['style'] })}>
            {VECTOR_ENVELOPE_STYLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {env &&
        env.params.style !== 'mesh' &&
        SLIDERS.map((s) => {
          const value = env.params[s.key];
          const onChange = (ev: React.ChangeEvent<HTMLInputElement>) => {
            const n = parseFloat(ev.target.value);
            if (Number.isFinite(n)) set({ [s.key]: n }, true);
          };
          return (
            <label key={s.key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-foreground" data-vector-envelope-param={s.key}>
              <span className={labelClass}>{s.label}</span>
              <input
                type="range"
                min={-100}
                max={100}
                step={1}
                aria-label={`Envelope ${s.label} slider`}
                className="h-4 min-w-0 flex-1 accent-primary"
                value={value}
                onChange={onChange}
                onPointerUp={end}
                onKeyUp={end}
                onBlur={end}
              />
              <input type="number" min={-100} max={100} step={1} aria-label={`Envelope ${s.label}`} className={numberClass} value={value} onChange={onChange} onBlur={end} />
            </label>
          );
        })}
      {env && env.params.style !== 'mesh' && (
        <label className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-foreground" data-vector-envelope-param="orientation">
          <span className={labelClass}>Orientation</span>
          <select aria-label="Envelope orientation" className={selectClass} value={env.params.orientation} onChange={(e) => set({ orientation: e.target.value as 'horizontal' | 'vertical' })}>
            <option value="horizontal">Horizontal</option>
            <option value="vertical">Vertical</option>
          </select>
        </label>
      )}
      <div className="flex items-center gap-2 text-xs text-foreground" data-vector-envelope-param="mesh">
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">Mesh rows × columns</span>
        <input type="number" min={1} max={16} step={1} aria-label="Envelope mesh rows" className={numberClass} value={rows} onChange={(e) => setCount('rows', e.target.value)} />
        <input type="number" min={1} max={16} step={1} aria-label="Envelope mesh columns" className={numberClass} value={columns} onChange={(e) => setCount('columns', e.target.value)} />
      </div>
      {panel.count > 1 && !panel.canMakeWithTopObject && <p className="text-[11px] text-muted-foreground">Select one object to edit its envelope.</p>}
      {env && <p className="text-[11px] text-muted-foreground">Edit the mesh with the Envelope tool (U).</p>}
    </div>
  );
}
