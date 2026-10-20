import React from 'react';
import type { VectorEditorController, VectorTool } from '@pixerate/editor/vector';
import { VectorCanvas, type VectorCanvasProps } from './VectorCanvas';
import { VectorStylePanel, VectorToolbar } from './VectorToolbar';
import type { EffectProvider } from '@pixerate/editor/effects';
import { useEffects } from '../effects';
import { VectorProviderEffectsPanel } from './VectorProviderEffectsPanel';

export interface VectorEditorProps {
  controller: VectorEditorController;
  /** Tools in the toolbar (default: all). */
  tools?: readonly VectorTool[];
  /** The style sidebar (default `true`). */
  showStylePanel?: boolean;
  /** Canvas height (default 520px). */
  height?: number | string;
  canvasProps?: Omit<VectorCanvasProps, 'controller'>;
  /**
   * An effects provider (see `@pixerate/editor/effects`), registered with the controller while
   * mounted: provider vector effects as groups, with an Effects section under the style panel.
   * Optional: without one the editor is as before.
   */
  effects?: EffectProvider | null;
  className?: string;
}

/** Toolbar, canvas and style panel for a `VectorEditorController`. */
export function VectorEditor({ controller, tools, showStylePanel = true, height = 520, canvasProps, effects, className }: VectorEditorProps) {
  useEffects(controller, effects);
  const effectsShown = !!effects || controller.vectorEffectGroups().length > 0;
  return (
    <div className={`flex flex-col gap-2 ${className ?? ''}`} data-vector-editor="">
      <VectorToolbar controller={controller} tools={tools} />
      <div className="flex min-h-0 flex-col gap-2 md:flex-row">
        <div className="relative min-h-[320px] flex-1 overflow-hidden rounded-md border border-border bg-muted/40" style={{ height }}>
          <VectorCanvas controller={controller} {...canvasProps} />
        </div>
        {showStylePanel && (
          <div className="flex w-full shrink-0 flex-col gap-2 md:w-56">
            <VectorStylePanel controller={controller} className="rounded-md border border-border p-3" />
            {effectsShown && <VectorProviderEffectsPanel controller={controller} className="rounded-md border border-border p-3" />}
          </div>
        )}
      </div>
    </div>
  );
}
