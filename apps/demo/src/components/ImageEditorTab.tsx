import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ImageEditor, useAgentToolProvider, useImageEditor } from '@pixerate/editor-react';
import { createImageEditorToolProvider, createImageEffectsToolProvider } from '@pixerate/editor/image-editor';
import { useDemoEffects } from '../demoEffects';
import { EffectsProviderSwitch } from './EffectsProviderSwitch';
import { demoToolRegistry } from '../agentTools';
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
  const [maskNote, setMaskNote] = useState<string | null>(null);
  const agentStage = useRef<HTMLDivElement>(null);
  // Agents get the image__* tools (adjustments, layers, selections, previews).
  const provider = useMemo(() => createImageEditorToolProvider(editor.controller, { id: 'image', namespace: 'image' }), [editor.controller]);
  useAgentToolProvider(demoToolRegistry, provider);
  // The demo-wide effects provider (the built-in test effects, or Flair once it is published).
  const { provider: effects, source: effectsSource } = useDemoEffects();
  // The effects turn names effect ids, so play the one written for the selected provider.
  const scripts = useMemo(() => IMAGE_SCRIPTS.filter((s) => s.id !== (effectsSource === "flair" ? "image-effects" : "image-effects-flair")), [effectsSource]);
  const effectTools = useMemo(() => createImageEffectsToolProvider(editor.controller, { id: 'image-effects', namespace: 'imagefx' }), [editor.controller]);
  useAgentToolProvider(demoToolRegistry, effectTools);

  useEffect(() => {
    void editor.controller.loadImage(selectedImage);
  }, [editor.controller, selectedImage]);

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
      <div className="relative w-full" ref={agentStage}>
        <ImageEditor
          editor={editor}
          effects={effects}
          onSave={(dataUrl) => {
            setExportedUrl(dataUrl);
          }}
        />
      </div>
      <AgentScriptPanel scripts={scripts} stage={agentStage} hint="Plays a scripted agent turn with the image__* tools: adjustments and layers as single undo steps, selections, masks, Free Transform, and a rendered preview." />

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
