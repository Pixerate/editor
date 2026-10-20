import React from 'react';
import {
  VECTOR_CONNECTOR_ROUTES,
  VECTOR_CONNECTOR_ROUTE_LABELS,
  VECTOR_CONNECTOR_SIDES,
  VECTOR_CONNECTOR_SIDE_LABELS,
  getVectorConnectorPanel,
  type VectorConnectorEnd,
  type VectorConnectorRoute,
  type VectorConnectorSide,
  type VectorEditorController
} from '@pixerate/editor/vector';
import { useVectorEditorState } from './useVectorEditor';

const buttonClass =
  'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40';
const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
const numberClass = 'h-7 w-16 rounded border border-border bg-background px-1.5 text-xs';

export interface VectorConnectorPanelProps {
  controller: VectorEditorController;
  className?: string;
}

/**
 * The selected connector: its route (straight, elbow, curved), the elbow corner radius, and for
 * each glued end the side it meets (Auto: the side facing the other end) and Unglue. Each change is
 * one undo step.
 */
export function VectorConnectorPanel({ controller, className }: VectorConnectorPanelProps) {
  const state = useVectorEditorState(controller);
  const panel = getVectorConnectorPanel(state);
  if (!panel) return null;
  const ids = [panel.id];
  const end = (key: 'start' | 'end', label: string, e: VectorConnectorEnd | null) => (
    <div className="flex items-center gap-1" data-vector-connector-end={key}>
      <span className="w-16 text-xs text-foreground">{label}</span>
      {e ? (
        <>
          <select
            aria-label={`${label} side`}
            className={selectClass}
            value={e.side ?? 'auto'}
            onChange={(ev) => controller.setConnector({ [key]: { nodeId: e.nodeId, side: ev.target.value as VectorConnectorSide } }, { ids })}
          >
            {VECTOR_CONNECTOR_SIDES.map((s) => (
              <option key={s} value={s}>
                {VECTOR_CONNECTOR_SIDE_LABELS[s]}
              </option>
            ))}
          </select>
          <button type="button" className={buttonClass} title="Unglue: the end stays where it is" aria-label={`Unglue ${label.toLowerCase()}`} onClick={() => controller.setConnector({ [key]: null }, { ids })}>
            Unglue
          </button>
        </>
      ) : (
        <span className="text-[11px] text-muted-foreground">Free</span>
      )}
    </div>
  );
  return (
    <div className={`space-y-2 ${className ?? ''}`} data-vector-connector-panel={panel.id} aria-label="Connector">
      <div className="flex items-center gap-1">
        <span className="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Connector</span>
        <select aria-label="Connector route" className={selectClass} value={panel.route} onChange={(e) => controller.setConnector({ route: e.target.value as VectorConnectorRoute }, { ids })}>
          {VECTOR_CONNECTOR_ROUTES.map((r) => (
            <option key={r} value={r}>
              {VECTOR_CONNECTOR_ROUTE_LABELS[r]}
            </option>
          ))}
        </select>
        {panel.route === 'elbow' && (
          <input
            type="number"
            min="0"
            step="1"
            aria-label="Elbow radius"
            title="Corner radius of the bends"
            className={numberClass}
            value={panel.radius}
            onChange={(e) => {
              const n = parseFloat(e.target.value);
              if (Number.isFinite(n) && n >= 0) controller.setConnector({ radius: n }, { ids });
            }}
          />
        )}
      </div>
      {end('start', 'Start', panel.start)}
      {end('end', 'End', panel.end)}
    </div>
  );
}
