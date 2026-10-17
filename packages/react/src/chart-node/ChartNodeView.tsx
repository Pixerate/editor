import React from 'react';
import { createRoot } from 'react-dom/client';
import type { ChartNodeViewMount, ChartNodeViewState } from '@pixerate/editor';
import type { ChartTheme } from '@pixerate/editor/chart';
import { ChartCanvas } from '../chart/ChartCanvas';
import { ChartDataGrid } from '../chart/ChartDataGrid';
import { ChartInspector } from '../chart/ChartInspector';
import { chartButtonClass } from '../chart/styles';

export interface ChartNodeViewProps {
  /** What the editor's `chart` node passes (see `ChartNodeViewState`). */
  state: ChartNodeViewState;
  /** Chart colours (default: the CSS-variable theme). */
  theme?: Partial<ChartTheme>;
  /** Show the data grid under the chart while editing (default `true`). */
  showDataGrid?: boolean;
}

/**
 * A chart inside a rich-text document: read-only until clicked, then editable on the canvas
 * with the data grid and the inspector in a panel below (side by side when there is room). "Done", Escape or moving the
 * selection away closes it. Edits are written back to the document as undo steps.
 */
export function ChartNodeView({ state, theme, showDataGrid = true }: ChartNodeViewProps) {
  const { controller, editing, editable, selected, width, height, setEditing } = state;
  const open = () => {
    if (editable && !editing) setEditing(true);
  };
  return (
    <div
      className={`not-prose my-2 rounded-md border bg-background p-1 ${selected ? 'border-primary ring-1 ring-primary' : 'border-border'}`}
      data-chart-node-view=""
      data-editing={editing ? '' : undefined}
      onKeyDown={(e) => {
        if (editing && e.key === 'Escape') {
          e.stopPropagation();
          setEditing(false);
        }
      }}
    >
      {editing && (
        <div className="mb-1 flex items-center justify-between gap-2 px-1" data-chart-node-toolbar="">
          <span className="text-xs text-muted-foreground">Editing chart</span>
          <button type="button" className={chartButtonClass} data-action="done" onClick={() => setEditing(false)}>
            Done
          </button>
        </div>
      )}
      <div
        className={editable && !editing ? 'cursor-pointer' : undefined}
        onClick={open}
        title={editable && !editing ? 'Click to edit the chart' : undefined}
        data-chart-node-canvas=""
      >
        <ChartCanvas controller={controller} width={width ?? 640} height={height} responsive={width === null} editable={editing} theme={theme} />
      </div>
      {editing && (
        // Wraps by the document's width, not the viewport's: side by side when there is room.
        <div className="mt-2 flex flex-wrap items-start gap-2" data-chart-node-panel="">
          {showDataGrid && (
            <div className="min-w-0 flex-[1_1_20rem] overflow-x-auto">
              <ChartDataGrid controller={controller} />
            </div>
          )}
          <ChartInspector controller={controller} className="max-h-96 min-w-0 flex-[1_1_16rem] overflow-y-auto rounded-md border border-border p-3" />
        </div>
      )}
    </div>
  );
}

export interface ReactChartNodeViewOptions extends Omit<ChartNodeViewProps, 'state'> {
  /** Draw something else for each chart (default `ChartNodeView`). */
  component?: React.ComponentType<ChartNodeViewProps>;
}

/**
 * The `nodeView` for the core `chart` node, drawing `ChartNodeView` in its own React root:
 * `createRichTextPreset({ chart: { nodeView: createReactChartNodeView() } })`. Works with any
 * TipTap editor (it does not need `EditorContent`); app context does not reach the chart.
 */
export function createReactChartNodeView(options: ReactChartNodeViewOptions = {}): ChartNodeViewMount {
  const { component: Component = ChartNodeView, ...props } = options;
  return (dom, state) => {
    const root = createRoot(dom);
    let latest = state;
    let scheduled = false;
    let destroyed = false;
    // ProseMirror creates and updates node views inside other renders (e.g. while
    // `EditorContent` mounts), where rendering another root is an error: render in a microtask.
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!destroyed) root.render(<Component {...props} state={latest} />);
      });
    };
    schedule();
    return {
      update: (next) => {
        latest = next;
        schedule();
      },
      destroy: () => {
        destroyed = true;
        queueMicrotask(() => root.unmount());
      },
    };
  };
}
