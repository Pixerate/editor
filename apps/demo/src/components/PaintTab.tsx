import React, { useEffect, useMemo, useState } from 'react';
import { useAgentToolProvider } from '@pixerate/editor-react';
import { PaintEditor, useMutationRequests, usePaintDirector, usePaintEditor, usePaintEffectsTools, usePaintProposals } from '@pixerate/editor-react/paint-editor';
import { createPaintBrushLibraryToolProvider, createPaintEditorToolProvider, createPaintProposalToolProvider, createPaintStyleToolProvider } from '@pixerate/editor/paint-editor';
import { demoStyles } from '../houseStyles';
import { createOriginMiddleware } from '@pixerate/editor/tools';
import { demoBrushLibrary } from '../demoBrushes';
import { demoStickers } from '../demoStickers';
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
  // Brushes come from the demo's shared brush library: saved here, they show in every tab that paints.
  // The demo lets agents write effects (pixel expressions) and paint with them.
  const editor = usePaintEditor({ width: 1200, height: 800, paper: 'cold-pressed', stickers: demoStickers, brushLibrary: demoBrushLibrary, authoredEffects: 'author' });
  // The agent paints on the canvas itself: its cursor draws each stroke live, rubs fills across the sheet and starts replays.
  const { presence, director } = usePaintDirector(editor.controller, { speed: demoAgentSpeed() });
  // Agents get the paint__* tools (paper, brushes, strokes, guides, colour, layers, export).
  const provider = useMemo(
    () => createPaintEditorToolProvider(editor.controller, { id: 'paint', namespace: 'paint', director, actor: { id: 'agent', name: 'Agent' } }),
    [editor.controller, director]
  );
  useAgentToolProvider(demoToolRegistry, provider);
  // House style: check_paint_style / fix_paint_style join the paint toolset.
  const styleProvider = useMemo(() => createPaintStyleToolProvider(editor.controller, demoStyles, { namespace: 'paint' }), [editor.controller]);
  useAgentToolProvider(demoToolRegistry, styleProvider);
  // The brush library the editor paints from (brushes__* tools): find, create, check and share
  // facet brushes, then paint__set_brush picks one; previews are test strokes on the current paper.
  const brushTools = useMemo(() => createPaintBrushLibraryToolProvider(editor.controller), [editor.controller]);
  useAgentToolProvider(demoToolRegistry, brushTools);
  // Agent suggestions: paint__propose_paint shows paint as a ghost over the canvas that the user
  // accepts (painted on its own layer, one undo step recorded as the agent's) or dismisses below.
  const proposals = usePaintProposals(editor.controller);
  const proposalTools = useMemo(() => createPaintProposalToolProvider(proposals.store, { id: 'paint-proposals', namespace: 'paint' }), [proposals.store]);
  useAgentToolProvider(demoToolRegistry, proposalTools);
  // Mutation paint: when a stroke settles, the demo's built-in responder claims it and paints an answer back.
  useMutationRequests(editor.controller, (req) => {
    void (async () => {
      try {
        const read = editor.controller.readMutation(req.id);
        const b = read.bounds ?? { x: 200, y: 200, width: 200, height: 200 };
        const cx = b.x + b.width * 0.5;
        const cy = b.y + b.height * 0.5;
        const r = Math.max(28, Math.min(b.width, b.height) * 0.55);
        await editor.controller.answerMutation(
          req.id,
          {
            note: 'Echoed in answer to your mark.',
            strokes: [
              {
                brushId: read.medium === 'wet' ? 'watercolor-round' : 'ink-pen',
                brush: { tip: { size: Math.max(6, Math.round((read.strokes[0]?.size ?? 16) * 0.85)) } },
                color: read.strokes[0]?.color === '#1f3a5f' ? '#b85d19' : '#1f3a5f',
                points: Array.from({ length: 12 }, (_, i) => {
                  const a = (i / 11) * Math.PI * 1.4 - Math.PI * 0.2;
                  return { x: Math.round(cx + Math.cos(a) * r), y: Math.round(cy + Math.sin(a) * r), pressure: 0.4 + 0.4 * Math.sin((i / 11) * Math.PI) };
                }),
              },
            ],
          },
          { director, actor: { id: 'agent', name: 'Agent' } }
        );
      } catch {
        // Ignore if already claimed by an external agent or undone.
      }
    })();
  });
  // Steps the paint tools make are recorded as the calling agent's (agent:<id>), not the user's.
  useEffect(
    () => demoToolRegistry.use(createOriginMiddleware({ histories: (call) => (call.provider.id.startsWith('paint') ? editor.controller : undefined) })),
    [editor.controller]
  );
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
  // Brush colours that come as light / dark pairs (the chalk) resolve for this scheme: it starts
  // from the system setting, and the toggle above the editor switches it.
  const [scheme, setScheme] = useState<'light' | 'dark'>(() => (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  useEffect(() => editor.controller.setColorScheme(scheme), [editor.controller, scheme]);
  // Stop the wet-media worker threads when the tab goes away.
  useEffect(() => () => editor.controller.dispose(), [editor.controller]);

  return (
    <div className="space-y-4">
      <EditorDocumentAutosave doc={editor.editorDocument} name="Painting" />
      <div className="flex items-center gap-2 text-xs text-slate-400" role="group" aria-label="Colour scheme">
        <span>Brush colours for</span>
        {(['light', 'dark'] as const).map((s) => (
          <button key={s} type="button" aria-pressed={scheme === s} onClick={() => setScheme(s)} className={`rounded px-2 py-0.5 ${scheme === s ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:text-white'}`}>
            {s === 'light' ? 'Light mode' : 'Dark mode'}
          </button>
        ))}
      </div>
      <div className="relative">
        {/* The director's presence is the editor's playback cursor too: strokes and panel edits share it. */}
        <PaintEditor controller={editor.controller} height={760} presence={presence} proposals={proposals.store} playback={demoPlayback} />
      </div>
      {proposals.proposals.length > 0 && (
        <div className="bg-violet-950/40 border border-violet-800/60 rounded-xl p-3 flex flex-col gap-2" aria-label="Paint suggestions">
          <span className="text-xs font-semibold uppercase tracking-wider text-violet-300">Suggestions</span>
          {proposals.proposals.map((p) => (
            <div key={p.id} className="flex items-center gap-2 text-xs text-slate-200" data-paint-suggestion={p.id}>
              <span className="font-medium">{p.title}</span>
              {p.rationale && <span className="text-slate-400 truncate">{p.rationale}</span>}
              <span className="text-slate-500">({p.origin})</span>
              <span className="ml-auto flex gap-1.5">
                <button type="button" className="px-2 py-0.5 rounded border border-violet-600 bg-violet-600/30 hover:bg-violet-600/50" onClick={() => proposals.accept(p.id)}>
                  Accept
                </button>
                <button type="button" className="px-2 py-0.5 rounded border border-slate-700 bg-slate-800 hover:bg-slate-700" onClick={() => proposals.reject(p.id)}>
                  Dismiss
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
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
