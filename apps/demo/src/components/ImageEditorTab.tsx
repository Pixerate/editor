import React, { useEffect, useMemo, useState } from 'react';
import SelectionWorker from '@pixerate/editor/image-editor/selection-worker?worker';
import { ImageEditor, ImageEditorCanvas, useAgentToolProvider, useImageEditor, type ImageEditorCanvasMode } from '@pixerate/editor-react';
import { createImageEditorToolProvider, createImageEffectsToolProvider } from '@pixerate/editor/image-editor';
import { useDemoEffects } from '../demoEffects';
import { EffectsProviderSwitch } from './EffectsProviderSwitch';
import { demoPlayback, demoToolRegistry } from '../agentTools';
import { EditorDocumentAutosave, useDemoDocumentTools } from './EditorDocumentAutosave';
import { AgentScriptPanel } from './AgentScriptPanel';
import { IMAGE_SCRIPTS } from '../agentScripts';
import { Image as ImageIcon, Download, Sparkles, Upload, Wand2 } from 'lucide-react';

/**
 * A stand-in for an AI segmentation: a blocky, slightly offset ellipse at 1/16 resolution, the
 * kind of coarse mask Refine Edge is meant to snap to the real edges of the image.
 */
function coarseMask(width: number, height: number) {
  const w = Math.max(4, Math.round(width / 16));
  const h = Math.max(4, Math.round(height / 16));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - w * 0.55) / (w * 0.28);
      const dy = (y + 0.5 - h * 0.5) / (h * 0.3);
      const v = dx * dx + dy * dy <= 1 ? 255 : 0;
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

const SAMPLE_IMAGES = [
  {
    name: 'Eltz Castle (Sample 1)',
    url: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=1200&q=80',
  },
  {
    name: 'Mountain Lake (Sample 2)',
    url: 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=1200&q=80',
  },
  {
    name: 'Abstract Gradient (Sample 3)',
    url: 'https://images.unsplash.com/photo-1579546929518-9e396f3cc809?auto=format&fit=crop&w=1200&q=80',
  },
];

export function ImageEditorTab() {
  const [selectedImage, setSelectedImage] = useState<string>(SAMPLE_IMAGES[0].url);
  const [exportedUrl, setExportedUrl] = useState<string | null>(null);
  const editor = useImageEditor();
  // The long selections (Select Subject, Sky, Focus Area, Object and Quick Selection, the Select
  // and Mask preview) run in a worker, so the page stays responsive.
  useEffect(() => {
    editor.controller.setSelectionWorker(() => new SelectionWorker());
    return () => editor.controller.setSelectionWorker(null);
  }, [editor.controller]);
  // Select and Mask's New Document outputs: the demo has one image editor here, so the new
  // document is downloaded as a document file instead of opened.
  useEffect(() => {
    editor.controller.setDocumentOpener((document, { name }) => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(document)], { type: 'application/json' }));
      const link = Object.assign(window.document.createElement('a'), { href: url, download: `${name}.pixerate-image.json` });
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    return () => editor.controller.setDocumentOpener(null);
  }, [editor.controller]);
  // A second editor for the standalone canvas below, with its own small toolbar.
  const canvasOnly = useImageEditor();
  const [canvasMode, setCanvasMode] = useState<ImageEditorCanvasMode>('paint');
  const [canvasError, setCanvasError] = useState<string | null>(null);
  const [maskNote, setMaskNote] = useState<string | null>(null);
  // Agents get the image__* tools (adjustments, layers, selections, previews).
  const provider = useMemo(() => createImageEditorToolProvider(editor.controller, { id: 'image', namespace: 'image' }), [editor.controller]);
  useAgentToolProvider(demoToolRegistry, provider);
  // Save / load (the editor's own tools have undo), with layer pixels kept as assets; and autosave.
  useDemoDocumentTools(editor.editorDocument, { namespace: 'image', skill: 'pixerate-image-editor', history: false });
  // The demo-wide effects provider (the built-in test effects, or Flair once it is published).
  const { provider: effects, source: effectsSource } = useDemoEffects();
  // The effects turn names effect ids, so play the one written for the selected provider.
  const scripts = useMemo(() => IMAGE_SCRIPTS.filter((s) => s.id !== (effectsSource === "flair" ? "image-effects" : "image-effects-flair")), [effectsSource]);
  const effectTools = useMemo(() => createImageEffectsToolProvider(editor.controller, { id: 'image-effects', namespace: 'imagefx' }), [editor.controller]);
  useAgentToolProvider(demoToolRegistry, effectTools);

  useEffect(() => {
    void editor.controller.loadImage(selectedImage);
  }, [editor.controller, selectedImage]);
  useEffect(() => {
    void canvasOnly.controller.loadImage(selectedImage).then(() => canvasOnly.controller.addPixelLayer({ name: 'Paint' }));
  }, [canvasOnly.controller, selectedImage]);
  const pickCanvasMode = (mode: ImageEditorCanvasMode) => {
    setCanvasMode(mode);
    setCanvasError(null);
    canvasOnly.setTool(mode === 'paint' ? 'brush' : mode === 'annotate' ? 'pen' : mode === 'crop' ? 'crop' : 'select');
  };

  const loadCoarseMask = async () => {
    const { width, height } = editor.controller.getState().imageDimensions;
    await editor.controller.loadSelectionFromImage(coarseMask(width, height));
    setMaskNote('Coarse mask loaded. Open "Select & Mask" and press Refine Edge (or use Refine below).');
  };

  const refineToEdges = async () => {
    try {
      await editor.controller.refineSelection({ radius: 16, smartRadius: true, contrast: 20 });
      setMaskNote('Selection refined to the image edges.');
    } catch (err) {
      setMaskNote(err instanceof Error ? err.message : String(err));
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          setSelectedImage(event.target.result as string);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <ImageIcon className="w-5 h-5 text-indigo-400" />
            Media & Image Editor Studio
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            UI-agnostic Canvas 2D engine with freeform/aspect crop, color adjustments, annotations, depth alpha masking,
            Select &amp; Mask: magic wand, marquees, lasso, Refine Edge and adjustment layer masks, and Free Transform
            (Ctrl/Cmd+T or the Free Transform button: drag handles to scale, outside to rotate, Ctrl/Cmd to distort).
          </p>
        </div>

        {/* Preset Selectors & Custom Upload */}
        <div className="flex flex-wrap items-center gap-2">
          {SAMPLE_IMAGES.map((img) => (
            <button
              key={img.name}
              type="button"
              onClick={() => setSelectedImage(img.url)}
              className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                selectedImage === img.url
                  ? 'bg-indigo-600 border-indigo-500 text-white shadow'
                  : 'bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800'
              }`}
            >
              {img.name.split(' (')[0]}
            </button>
          ))}

          <label className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 cursor-pointer transition-colors">
            <Upload className="w-3.5 h-3.5" />
            <span>Upload Image</span>
            <input type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
          </label>
        </div>
      </div>
      <EditorDocumentAutosave doc={editor.editorDocument} name="Image" />

      {/* Selection demo: simulate an AI segmentation and refine it to the image edges */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          onClick={loadCoarseMask}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700"
        >
          <Wand2 className="w-3.5 h-3.5" />
          Load coarse “AI” mask
        </button>
        <button
          type="button"
          onClick={refineToEdges}
          disabled={!editor.state.selection}
          className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-40"
        >
          Refine Edge
        </button>
        {maskNote && <span className="text-slate-400">{maskNote}</span>}
      </div>


      {/* Editor Component */}
      <EffectsProviderSwitch />
      <div className="relative w-full">
        {/* The editor acts out every image__* / imagefx__* call (agent playback), opening each tool's panel itself. */}
        <ImageEditor
          editor={editor}
          effects={effects}
          playback={demoPlayback}
          onSave={(dataUrl) => {
            setExportedUrl(dataUrl);
          }}
        />
      </div>
      {/* The canvas alone (ImageEditorCanvas): your own chrome around it, sized by its box. */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold uppercase tracking-wider text-slate-300">Canvas only</span>
          {(['paint', 'crop', 'select', 'annotate', 'none'] as ImageEditorCanvasMode[]).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={canvasMode === m}
              onClick={() => pickCanvasMode(m)}
              className={`px-2.5 py-1 rounded-md border capitalize ${canvasMode === m ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800'}`}
            >
              {m}
            </button>
          ))}
          {canvasError && <span role="alert" className="text-rose-400">{canvasError}</span>}
        </div>
        <div className="resize overflow-hidden rounded-lg border border-slate-800" style={{ width: 480, height: 280, minWidth: 200, minHeight: 120 }}>
          <ImageEditorCanvas
            editor={canvasOnly}
            mode={canvasMode}
            playback={null}
            onError={(_source, message) => setCanvasError(message)}
            className="h-full w-full bg-slate-950"
          />
        </div>
      </div>
      <AgentScriptPanel scripts={scripts} hint="Plays a scripted agent turn with the image__* tools: adjustments and layers as single undo steps, selections, masks, Free Transform, and a rendered preview. The editor acts each call out with the agent's cursor and opens the panel it works in." />

      {/* Export Preview */}
      {exportedUrl && (
        <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/60 backdrop-blur space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
              Latest Export Output
            </span>
            <a
              href={exportedUrl}
              download="pixerate-edited-image.png"
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
            >
              <Download className="w-3.5 h-3.5" />
              Download PNG
            </a>
          </div>
          <div className="flex justify-center p-2 bg-slate-950 rounded-lg border border-slate-800/80">
            <img
              src={exportedUrl}
              alt="Exported output"
              className="max-h-64 rounded object-contain shadow-lg"
            />
          </div>
        </div>
      )}
    </div>
  );
}
