import React from 'react';
import { describeChartSelection, type ChartController } from '@pixerate/editor/chart';
import { ChartCanvas, type ChartCanvasProps } from './ChartCanvas';
import { ChartDataGrid } from './ChartDataGrid';
import { ChartInspector } from './ChartInspector';
import { useChartState } from './useChartEditor';
import { chartButtonClass } from './styles';

export interface ChartEditorProps {
  controller: ChartController;
  /** The settings sidebar (default `true`). */
  showInspector?: boolean;
  /** The data grid under the chart (default `true`). */
  showDataGrid?: boolean;
  /** Undo / redo and the selection readout (default `true`). */
  showToolbar?: boolean;
  /** Chart height in pixels (default 380). */
  height?: number;
  canvasProps?: Omit<ChartCanvasProps, 'controller' | 'height'>;
  className?: string;
}

/** Toolbar, chart, settings sidebar and data grid for a `ChartController`. */
export function ChartEditor({ controller, showInspector = true, showDataGrid = true, showToolbar = true, height = 380, canvasProps, className }: ChartEditorProps) {
  const state = useChartState(controller);
  return (
    <div className={`flex flex-col gap-2 ${className ?? ''}`} data-chart-editor="">
      {showToolbar && (
        <div className="flex items-center gap-1" data-chart-toolbar="">
          <button type="button" className={chartButtonClass} disabled={!state.canUndo} title={state.undoLabel ? `Undo ${state.undoLabel}` : 'Undo'} data-action="undo" onClick={() => controller.undo()}>
            Undo
          </button>
          <button type="button" className={chartButtonClass} disabled={!state.canRedo} title={state.redoLabel ? `Redo ${state.redoLabel}` : 'Redo'} data-action="redo" onClick={() => controller.redo()}>
            Redo
          </button>
          <span className="ml-2 truncate text-xs text-muted-foreground" data-chart-selection="" aria-live="polite">
            {describeChartSelection(controller, state.selection)}
          </span>
        </div>
      )}
      {state.issues.length > 0 && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive" data-chart-issues="">
          {state.issues.map((i) => i.message).join(' ')}
        </p>
      )}
      <div className="flex min-h-0 flex-col gap-2 md:flex-row">
        <div className="min-w-0 flex-1 rounded-md border border-border bg-background p-1">
          <ChartCanvas controller={controller} height={height} {...canvasProps} />
        </div>
        {showInspector && <ChartInspector controller={controller} className="w-full shrink-0 overflow-y-auto rounded-md border border-border p-3 md:w-64" />}
      </div>
      {showDataGrid && <ChartDataGrid controller={controller} />}
    </div>
  );
}
