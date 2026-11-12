import React, { useEffect, useMemo, useState } from 'react';
import SelectionWorker from '@pixerate/editor/image-editor/selection-worker?worker';
import { ImageEditor, ImageEditorCanvas, useAgentToolProvider, useImageEditor, type ImageEditorCanvasMode } from '@pixerate/editor-react';
import { createImageEditorToolProvider, createImageEffectsToolProvider, createImageStickerHost, createImageStyleToolProvider } from '@pixerate/editor/image-editor';
import { demoStyles } from '../houseStyles';
import { createStickerToolProvider } from '@pixerate/editor/stickers';
import { StickerInsertPanel } from '@pixerate/editor-react/stickers';
import { demoStickers } from '../demoStickers';
import { demoBrushLibrary } from '../demoBrushes';
import { paintBrushPreviewRenderer } from '@pixerate/editor/paint-editor';

/** The brush editor's preview ("Edit brush…"): the paint engine paints a test stroke, as the image brush does. */
const IMAGE_BRUSH_PREVIEW = paintBrushPreviewRenderer();
import { createBrushLibraryToolProvider, IMAGE_PROFILE } from '@pixerate/editor/brushes';
import { useDemoEffects } from '../demoEffects';
import { EffectsProviderSwitch } from './EffectsProviderSwitch';
import { demoPlayback, demoToolRegistry } from '../agentTools';
import { EditorDocumentAutosave, useDemoDocumentTools } from './EditorDocumentAutosave';
import { AgentScriptPanel } from './AgentScriptPanel';
import { EditorPage, EditorPanel, useOpenPanel } from './EditorPage';
import { IMAGE_SCRIPTS } from '../agentScripts';
import { Image as ImageIcon, Download, Sparkles, Sticker as StickerIcon, Upload, Wand2 } from 'lucide-react';

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

/** Picks the image both views edit: a sample, or one uploaded from disk. */
function ImagePicker({ image, onPick }: { image: string; onPick: (url: string) => void }) {
  const sample = SAMPLE_IMAGES.some((img) => img.url === image);
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          onPick(event.target.result as string);
        }
      };
      reader.readAsDataURL(file);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label className="flex items-center gap-1.5 text-slate-400">
        <ImageIcon className="w-3.5 h-3.5" />
        <span className="sr-only">Image</span>
        <select
          value={sample ? image : ''}
          onChange={(e) => e.target.value && onPick(e.target.value)}
          className="rounded-lg border border-slate-800 bg-slate-900 px-2 py-1.5 text-slate-200"
          aria-label="Sample image"
        >
          {!sample && <option value="">Uploaded image</option>}
          {SAMPLE_IMAGES.map((img) => (
            <option key={img.url} value={img.url}>
              {img.name.split(' (')[0]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800 cursor-pointer transition-colors">
        <Upload className="w-3.5 h-3.5" />
        <span>Upload</span>
        <input type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
      </label>
    </div>
  );
}

function ImageEditorView({ image, onPickImage }: { image: string; onPickImage: (url: string) => void }) {
  const [exportedUrl, setExportedUrl] = useState<string | null>(null);
  const openPanel = useOpenPanel();
  // Brush presets come from the demo's shared brush library: a brush saved in the Paint tab shows here.
  const editor = useImageEditor({ brushLibrary: demoBrushLibrary, brushPreview: IMAGE_BRUSH_PREVIEW });
  // The library's tools for the image profile (imagebrushes__*): list_brush_presets lists what set_brush_preset takes.
  const imageBrushTools = useMemo(() => createBrushLibraryToolProvider(demoBrushLibrary, { profile: IMAGE_PROFILE, id: 'image-brushes', namespace: 'imagebrushes' }), []);
  useAgentToolProvider(demoToolRegistry, imageBrushTools);
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
  const [maskNote, setMaskNote] = useState<string | null>(null);
  // Agents get the image__* tools (adjustments, layers, selections, previews).
  const provider = useMemo(() => createImageEditorToolProvider(editor.controller, { id: 'image', namespace: 'image' }), [editor.controller]);
  useAgentToolProvider(demoToolRegistry, provider);
  // House style: check_image_style / fix_image_style join the image toolset.
  const styleProvider = useMemo(() => createImageStyleToolProvider(editor.controller, demoStyles, { namespace: 'image' }), [editor.controller]);
  useAgentToolProvider(demoToolRegistry, styleProvider);
  // Save / load (the editor's own tools have undo), with layer pixels kept as assets; and autosave.
  useDemoDocumentTools(editor.editorDocument, { namespace: 'image', skill: 'pixerate-image-editor', history: false });
  // The demo-wide effects provider (the built-in test effects, or Flair once it is published).
  const { provider: effects, source: effectsSource } = useDemoEffects();
  // The effects turn names effect ids, so play the one written for the selected provider.
  // The sticker script uses the built-in test effects, so it is left out with Flair.
  const scripts = useMemo(() => IMAGE_SCRIPTS.filter((s) => s.id !== (effectsSource === "flair" ? "image-effects" : "image-effects-flair") && !(effectsSource === "flair" && s.id === "image-sticker-effects")), [effectsSource]);
  const effectTools = useMemo(() => createImageEffectsToolProvider(editor.controller, { id: 'image-effects', namespace: 'imagefx' }), [editor.controller]);
  useAgentToolProvider(demoToolRegistry, effectTools);
  // Stickers go in as pixel layers (imagestickers__insert_sticker); any effect that takes a picture
  // can then treat one (imagefx__apply_effect: the layer is its input).
  const stickerHost = useMemo(() => createImageStickerHost(editor.controller), [editor.controller]);
  const stickerTools = useMemo(() => createStickerToolProvider({ provider: () => demoStickers, insert: stickerHost, id: 'image-stickers', namespace: 'imagestickers' }), [stickerHost]);
  useAgentToolProvider(demoToolRegistry, stickerTools);

  useEffect(() => {
    void editor.controller.loadImage(image);
  }, [editor.controller, image]);

  const loadCoarseMask = async () => {
    const { width, height } = editor.controller.getState().imageDimensions;
    await editor.controller.loadSelectionFromImage(coarseMask(width, height));
    setMaskNote('Coarse mask loaded. Open "Select & Mask" and press Refine Edge (or use Refine Edge here).');
  };

  const refineToEdges = async () => {
    try {
      await editor.controller.refineSelection({ radius: 16, smartRadius: true, contrast: 20 });
      setMaskNote('Selection refined to the image edges.');
    } catch (err) {
      setMaskNote(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="space-y-3">
      <ImagePicker image={image} onPick={onPickImage} />
      <EditorDocumentAutosave doc={editor.editorDocument} name="Image" />
      <EffectsProviderSwitch />
      <div className="relative w-full">
        {/* The editor acts out every image__* / imagefx__* call (agent playback), opening each tool's panel itself. */}
        <ImageEditor
          editor={editor}
          effects={effects}
          playback={demoPlayback}
          onSave={(dataUrl) => {
            setExportedUrl(dataUrl);
            openPanel('export');
          }}
        />
      </div>
      <AgentScriptPanel scripts={scripts} hint="Plays a scripted agent turn with the image__* tools: adjustments and layers as single undo steps, selections, masks, Free Transform, and a rendered preview. The editor acts each call out with the agent's cursor and opens the panel it works in." />

      <EditorPanel id="stickers" label="Stickers" icon={StickerIcon}>
        <StickerInsertPanel provider={demoStickers} host={stickerHost} />
      </EditorPanel>

      {/* Selection demo: simulate an AI segmentation and refine it to the image edges */}
      <EditorPanel id="mask" label="AI mask" icon={Wand2}>
        <p className="text-xs leading-relaxed text-slate-400">
          Stands in for an AI segmentation: loads a coarse, blocky mask as the selection, then Refine Edge snaps it to the real edges of the image.
        </p>
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
        </div>
        {maskNote && <p className="text-xs text-slate-400">{maskNote}</p>}
      </EditorPanel>

      {/* Export Preview */}
      <EditorPanel id="export" label="Export" icon={Sparkles}>
        {exportedUrl ? (
          <div className="space-y-3">
            <div className="flex justify-end">
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
              <img src={exportedUrl} alt="Exported output" className="max-h-64 rounded object-contain shadow-lg" />
            </div>
          </div>
        ) : (
          <p className="text-xs text-slate-500">Save from the editor's toolbar and the exported PNG shows here, ready to download.</p>
        )}
      </EditorPanel>

      <EditorPanel id="tips" label="Tips">
        <p className="text-xs leading-relaxed text-slate-400">
          UI-agnostic Canvas 2D engine with freeform/aspect crop, color adjustments, annotations, depth alpha masking,
          Select &amp; Mask: magic wand, marquees, lasso, Refine Edge and adjustment layer masks, and Free Transform
          (Ctrl/Cmd+T or the Free Transform button: drag handles to scale, outside to rotate, Ctrl/Cmd to distort).
        </p>
      </EditorPanel>
    </div>
  );
}

/** The canvas alone (ImageEditorCanvas): your own chrome around it, sized by its box. */
function CanvasOnlyView({ image, onPickImage }: { image: string; onPickImage: (url: string) => void }) {
  // A second editor with its own small toolbar.
  const canvasOnly = useImageEditor();
  const [canvasMode, setCanvasMode] = useState<ImageEditorCanvasMode>('paint');
  const [canvasError, setCanvasError] = useState<string | null>(null);
  useEffect(() => {
    void canvasOnly.controller.loadImage(image).then(() => canvasOnly.controller.addPixelLayer({ name: 'Paint' }));
  }, [canvasOnly.controller, image]);
  const pickCanvasMode = (mode: ImageEditorCanvasMode) => {
    setCanvasMode(mode);
    setCanvasError(null);
    canvasOnly.setTool(mode === 'paint' ? 'brush' : mode === 'annotate' ? 'pen' : mode === 'crop' ? 'crop' : 'select');
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <ImagePicker image={image} onPick={onPickImage} />
        <span className="mx-1 h-4 border-l border-slate-800" aria-hidden />
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
      <EditorPanel id="tips" label="Tips">
        <p className="text-xs leading-relaxed text-slate-400">
          ImageEditorCanvas without the editor's chrome: pick a mode (paint, crop, select, annotate, or none) from your own toolbar.
          The canvas sizes itself to its box; drag the corner to resize it.
        </p>
      </EditorPanel>
    </div>
  );
}

export function ImageEditorTab() {
  // Both views edit the same picked image.
  const [image, setImage] = useState<string>(SAMPLE_IMAGES[0].url);
  return (
    <EditorPage
      tab="image"
      title="Image"
      icon={ImageIcon}
      description="A layered photo editor: adjustments, selections and masks, crop, transform and annotations on a Canvas 2D engine."
      views={[
        { id: 'editor', label: 'Editor', render: () => <ImageEditorView image={image} onPickImage={setImage} /> },
        { id: 'canvas-only', label: 'Canvas only', render: () => <CanvasOnlyView image={image} onPickImage={setImage} /> },
      ]}
    />
  );
}
