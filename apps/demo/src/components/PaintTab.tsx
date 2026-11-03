import React, { useEffect, useMemo } from 'react';
import { useAgentToolProvider } from '@pixerate/editor-react';
import { PaintEditor, usePaintDirector, usePaintEditor, usePaintEffectsTools } from '@pixerate/editor-react/paint-editor';
import { createPaintEditorToolProvider } from '@pixerate/editor/paint-editor';
import { combineStickerProviders, createFakeStickerProvider, editorStickers } from '@pixerate/editor/stickers';
import { Brush } from 'lucide-react';
import { demoPlayback, demoToolRegistry } from '../agentTools';
import { EditorDocumentAutosave, useDemoDocumentTools } from './EditorDocumentAutosave';
import { AgentScriptPanel } from './AgentScriptPanel';
import { PAINT_SCRIPTS } from '../agentScripts';
import { demoAgentSpeed } from '../agentScript';
import { useDemoEffects } from '../demoEffects';
import { EffectsProviderSwitch } from './EffectsProviderSwitch';
import { EditorPage, EditorPanel } from './EditorPage';

function PaintView() {
  // The sticker library: the editor's own stamps plus a stand-in host library (the fake provider),
  // so the sticker brush, the sticker panel and find_stickers show both.
  const editor = usePaintEditor({ width: 1200, height: 800, paper: 'cold-pressed', stickers: combineStickerProviders([editorStickers(), createFakeStickerProvider()], { name: 'Demo stickers' }) });
  // The agent paints on the canvas itself: its cursor draws each stroke live, rubs fills across the sheet and starts replays.
  const { presence, director } = usePaintDirector(editor.controller, { speed: demoAgentSpeed() });
  // Agents get the paint__* tools (paper, brushes, strokes, guides, colour, layers, export).
  const provider = useMemo(
    () => createPaintEditorToolProvider(editor.controller, { id: 'paint', namespace: 'paint', director, actor: { id: 'agent', name: 'Agent' } }),
    [editor.controller, director]
  );
  useAgentToolProvider(demoToolRegistry, provider);
  // Save / load (the editor's own tools have undo), with layer pixels kept as assets; and autosave.
  useDemoDocumentTools(editor.editorDocument, { namespace: 'paint', skill: 'pixerate-paint-editor', history: false });
  // The demo-wide effects provider (built-in test effects, or Flair): effect paper, effect layers,
  // fills and light on dried paint (Effects tab), and the paintfx__* tools.
  const { provider: effects, source: effectsSource } = useDemoEffects();
  useEffect(() => (effects ? editor.controller.useEffects(effects) : undefined), [editor.controller, effects]);
  usePaintEffectsTools(demoToolRegistry, editor.controller, { id: 'paint-effects', namespace: 'paintfx' });
  // The effects turn names effect ids, so play the one written for the selected provider.
  // A script with a "-flair" twin runs the twin when Flair is the provider; the twins need Flair.
  const scripts = useMemo(() => {
    const ids = new Set(PAINT_SCRIPTS.map((s) => s.id));
    return PAINT_SCRIPTS.filter((s) => (effectsSource === 'flair' ? !ids.has(`${s.id}-flair`) : !s.id.endsWith('-flair')));
  }, [effectsSource]);
  // Stop the wet-media worker threads when the tab goes away.
  useEffect(() => () => editor.controller.dispose(), [editor.controller]);

  return (
    <div className="space-y-4">
      <EditorDocumentAutosave doc={editor.editorDocument} name="Painting" />
      <div className="relative">
        {/* The director's presence is the editor's playback cursor too: strokes and panel edits share it. */}
        <PaintEditor controller={editor.controller} height={760} presence={presence} playback={demoPlayback} />
      </div>
      <EffectsProviderSwitch />
      <AgentScriptPanel
        scripts={scripts}
        hint="Plays a scripted agent turn with the paint__* tools. Strokes go through the paint director, so its cursor paints each one live on the canvas: paper, fills that follow the grain, pigment mixing on the pad, blending, dirty and multi-colour brushes, watercolour glazes, wet-in-wet watercolour that flows and dries, replayed and varied strokes, and kaleidoscope symmetry."
      />
      <EditorPanel id="tips" label="Tips">
        <p className="text-xs leading-relaxed text-slate-400">
          Natural media on generated paper: pencils, pastels and charcoal catch the paper's grain (press harder to fill it), plus airbrush, marker and ink. Blend
          with a blender that mixes nearby colours like paint, a smudge (with pigment mixing) and the Mixer Brush; give any brush pick-up and mix ratios, make it
          dirty or multi-coloured, and glaze layers in watercolour, tint, highlight or shadow mode. Watercolour and gouache are wet: a fluid simulation spreads the water, darkens drying edges, granulates, blooms and runs downhill on a tilted board until the paint dries (Wet panel: dry now, pause, water overlay, tilt, flow maps). Pens use pressure, tilt and barrel rotation. Rotate (R, Shift+wheel) and mirror (M) the view, paint
          mirrored or as a kaleidoscope, snap to perspective guides, trace an image, and mix colours on the pad. Every stroke is kept as data and can be replayed. With an effects provider, the Effects tab adds effect paper, effect layers, effect fills and light baked onto dried paint.
        </p>
      </EditorPanel>
    </div>
  );
}

const PAINT_VIEWS = [{ id: 'paint', label: 'Paint', render: () => <PaintView /> }];

export function PaintTab() {
  return (
    <EditorPage
      tab="paint"
      title="Paint"
      icon={Brush}
      description="Natural-media painting on generated paper: dry and wet brushes, pigment mixing and watercolour that flows and dries."
      views={PAINT_VIEWS}
    />
  );
}
