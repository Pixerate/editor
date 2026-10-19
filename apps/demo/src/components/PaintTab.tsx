import React, { useMemo, useRef } from 'react';
import { useAgentToolProvider } from '@pixerate/editor-react';
import { PaintEditor, usePaintDirector, usePaintEditor } from '@pixerate/editor-react/paint-editor';
import { createPaintEditorToolProvider } from '@pixerate/editor/paint-editor';
import { Brush } from 'lucide-react';
import { demoToolRegistry } from '../agentTools';
import { AgentScriptPanel } from './AgentScriptPanel';
import { PAINT_SCRIPTS } from '../agentScripts';
import { demoAgentSpeed } from '../agentScript';

export function PaintTab() {
  const editor = usePaintEditor({ width: 1200, height: 800, paper: 'cold-pressed' });
  const stage = useRef<HTMLDivElement>(null);
  // The agent paints on the canvas itself: its cursor draws each stroke live, rubs fills across the sheet and starts replays.
  const { presence, director } = usePaintDirector(editor.controller, { speed: demoAgentSpeed() });
  // Agents get the paint__* tools (paper, brushes, strokes, guides, colour, layers, export).
  const provider = useMemo(
    () => createPaintEditorToolProvider(editor.controller, { id: 'paint', namespace: 'paint', director, actor: { id: 'agent', name: 'Agent' } }),
    [editor.controller, director]
  );
  useAgentToolProvider(demoToolRegistry, provider);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
          <Brush className="w-5 h-5 text-indigo-400" />
          Paint
        </h2>
        <p className="text-xs text-slate-400 mt-1">
          Natural media on generated paper: pencils, pastels and charcoal catch the paper's grain (press harder to fill it), plus airbrush, marker and ink. Blend
          with a blender that mixes nearby colours like paint, a smudge (with pigment mixing) and the Mixer Brush; give any brush pick-up and mix ratios, make it
          dirty or multi-coloured, and glaze layers in watercolour, tint, highlight or shadow mode. Pens use pressure, tilt and barrel rotation. Rotate (R, Shift+wheel) and mirror (M) the view, paint
          mirrored or as a kaleidoscope, snap to perspective guides, trace an image, and mix colours on the pad. Every stroke is kept as data and can be replayed.
        </p>
      </div>
      <div ref={stage} className="relative">
        <PaintEditor controller={editor.controller} height={760} presence={presence} />
      </div>
      <AgentScriptPanel
        scripts={PAINT_SCRIPTS}
        stage={stage}
        presence={presence}
        hint="Plays a scripted agent turn with the paint__* tools. Strokes go through the paint director, so its cursor paints each one live on the canvas: paper, fills that follow the grain, pigment mixing on the pad, blending, dirty and multi-colour brushes, watercolour glazes, replayed and varied strokes, and kaleidoscope symmetry."
      />
    </div>
  );
}
