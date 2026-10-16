import React from 'react';
import type { VectorEditorController, VectorTool } from '@pixerate/editor/vector';
import { VectorCanvas, type VectorCanvasProps } from './VectorCanvas';
import { VectorStylePanel, VectorToolbar } from './VectorToolbar';

export interface VectorEditorProps {
  controller: VectorEditorController;
  /** Tools in the toolbar (default: all). */
  tools?: readonly VectorTool[];
  /** The style sidebar (default `true`). */
  showStylePanel?: boolean;
  /** Canvas height (default 520px). */
  height?: number | string;
  canvasProps?: Omit<VectorCanvasProps, 'controller'>;
  className?: string;
}

/** Toolbar, canvas and style panel for a `VectorEditorController`. */
export function VectorEditor({ controller, tools, showStylePanel = true, height = 520, canvasProps, className }: VectorEditorProps) {
  return (
    <div className={`flex flex-col gap-2 ${className ?? ''}`} data-vector-editor="">
      <VectorToolbar controller={controller} tools={tools} />
      <div className="flex min-h-0 flex-col gap-2 md:flex-row">
        <div className="relative min-h-[320px] flex-1 overflow-hidden rounded-md border border-border bg-muted/40" style={{ height }}>
          <VectorCanvas controller={controller} {...canvasProps} />
        </div>
        {showStylePanel && <VectorStylePanel controller={controller} className="w-full shrink-0 rounded-md border border-border p-3 md:w-56" />}
      </div>
    </div>
  );
}
