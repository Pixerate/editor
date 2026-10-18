import React, { useState } from 'react';
import { describeChartSelection, downloadChartPng, type ChartController, type DownloadChartPngOptions } from '@pixerate/editor/chart';
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
  /** Undo / redo, Download PNG and the selection readout (default `true`). */
  showToolbar?: boolean;
  /** Size, theme, scale and file name for the toolbar's Download PNG (default 800 × 450, light theme). */
  pngOptions?: DownloadChartPngOptions;
  /** Chart height in pixels (default 380). */
  height?: number;
  canvasProps?: Omit<ChartCanvasProps, 'controller' | 'height'>;
  className?: string;
}

/** Toolbar, chart, settings sidebar and data grid for a `ChartController`. */
export function ChartEditor({ controller, showInspector = true, showDataGrid = true, showToolbar = true, pngOptions, height = 380, canvasProps, className }: ChartEditorProps) {
  const state = useChartState(controller);
  const [pngError, setPngError] = useState<string | null>(null);
  const downloadPng = () => {
    setPngError(null);
    downloadChartPng(controller.toJSON(), pngOptions).catch((error: unknown) => setPngError(error instanceof Error ? error.message : String(error)));
  };
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
          <button type="button" className={chartButtonClass} title="Download the chart as a PNG image" data-action="download-png" onClick={downloadPng}>
            Download PNG
          </button>
          <span className="ml-2 truncate text-xs text-muted-foreground" data-chart-selection="" aria-live="polite">
            {describeChartSelection(controller, state.selection)}
          </span>
        </div>
      )}
      {pngError && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive" data-chart-png-error="">
          {pngError}
        </p>
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
        {showInspector && (
          // Side by side, the canvas sets the row's height and the inspector scrolls within it.
          <div className="relative w-full shrink-0 md:w-64">
            <ChartInspector controller={controller} className="overflow-y-auto rounded-md border border-border p-3 md:absolute md:inset-0" />
          </div>
        )}
      </div>
      {showDataGrid && <ChartDataGrid controller={controller} />}
    </div>
  );
}
