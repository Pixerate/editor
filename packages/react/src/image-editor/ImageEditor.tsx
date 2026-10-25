import React, { useRef, useEffect, useState } from 'react';
import type { AgentPlayback, PlaybackRef } from '@pixerate/editor/tools';
import type {
  ExportOptions,
  ImageEditorFit,
  ImageEditorTool,
  InpaintHook,
  RemoveBackgroundHook,
  ImageEditorAIHooks,
  TextEditSession,
} from '@pixerate/editor/image-editor';
import {
  normalizeProcessVersion,
  LATEST_PROCESS_VERSION,
  IMAGE_ADJUSTMENT_CONTROLS,
  readAdjustmentControls,
  DEFAULT_SELECTION_TOOL_OPTIONS,
  FreeTransformTool,
  DEFAULT_SHAPE_TOOL_OPTIONS,
  DEFAULT_TYPE_TOOL_OPTIONS,
  type SelectionToolOptions,
  type ShapeToolOptions,
  type TypeToolOptions,
} from '@pixerate/editor/image-editor';
import { ImageEditorCanvas, type ImageEditorCanvasErrorSource, type ImageEditorCanvasMode } from './ImageEditorCanvas';
import { useImageEditor, type UseImageEditorReturn } from './useImageEditor';
import { ControlSlider } from './ControlSlider';
import { Histogram } from './Histogram';
import { AdjustmentLayersPanel } from './AdjustmentLayersPanel';
import { LayersPanel } from './LayersPanel';
import { ImageProviderEffectsPanel } from './ImageProviderEffectsPanel';
import type { EffectProvider } from '@pixerate/editor/effects';
import { useEffects } from '../effects';
import { BrushOptionsBar } from './BrushOptionsBar';
import { ColorProfilePanel } from './ColorProfilePanel';
import { SelectionOptionsBar } from './SelectionOptionsBar';
import { RefineEdgePanel } from './RefineEdgePanel';
import { FreeTransformOptionsBar } from './FreeTransformOptionsBar';
import { ShapeOptionsBar } from './ShapeOptionsBar';
import { TypeOptionsBar } from './TypeOptionsBar';

export interface ImageEditorProps {
  editor?: UseImageEditorReturn;
  src?: string;
  className?: string;
  style?: React.CSSProperties;
  onSave?: (dataUrl: string) => void;
  exportOptions?: ExportOptions;
  onInpaint?: InpaintHook;
  onRemoveBackground?: RemoveBackgroundHook;
  aiHooks?: ImageEditorAIHooks;
  /** How the image fits the canvas (default: the renderer's). */
  fit?: ImageEditorFit;
  /**
   * An effects provider (see `@pixerate/editor/effects`), registered with the controller while
   * mounted: filter effects as smart filters and generator or overlay effects as effect layers,
   * with an Effects section in the Layers tab. Optional: without one the editor is as before.
   */
  effects?: EffectProvider | null;
  /**
   * Agent playback: act out the image tools' calls here with the agent's cursor, opening the panel
   * each tool belongs to (default: the nearest `AgentPlaybackProvider`; `null` turns it off).
   */
  playback?: AgentPlayback | null;
  /** The playback surface id (default `image`, where the image tool providers play). */
  playbackId?: string;
  /** Bring the editor on screen (switch to its tab) before the agent acts. */
  onPlaybackReveal?: () => void | Promise<void>;
}

type TabType = 'crop' | 'adjust' | 'layers' | 'paint' | 'select' | 'annotate' | 'depth' | 'ai';

export const ImageEditor: React.FC<ImageEditorProps> = ({
  editor: externalEditor,
  src,
  className = '',
  style,
  onSave,
  exportOptions,
  onInpaint,
  onRemoveBackground,
  aiHooks,
  fit,
  effects,
  playback,
  playbackId = 'image',
  onPlaybackReveal,
}) => {
  const internalEditor = useImageEditor({ image: src });
  const editor = externalEditor || internalEditor;
  const { state, controller } = editor;
  useEffects(controller, effects);
  const effectsShown = !!controller.effectsProvider || state.layers.some(function has(l): boolean {
    return (l.type === 'pixel' && !!l.generator) || (l.type === 'smart' && !!l.smartFilters?.filters.some((f) => f.kind === 'effect')) || (l.type === 'group' && l.children.some(has));
  });
  const legacyProcess = normalizeProcessVersion(state.adjustments.process) < LATEST_PROCESS_VERSION;

  const [activeTab, setActiveTab] = useState<TabType>('crop');
  const rootRef = useRef<HTMLDivElement>(null);
  /** The tabs with canvas gestures drive the canvas mode; the others only view. */
  const canvasMode: ImageEditorCanvasMode =
    activeTab === 'crop' || activeTab === 'select' || activeTab === 'paint' || activeTab === 'annotate' ? activeTab : 'none';
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  /** Agent playback opens a panel by clicking its tab, unless it is already open. */
  const openPanel = async (ref: PlaybackRef) => {
    if (ref.kind !== 'panel' || activeTabRef.current === ref.id) return;
    rootRef.current?.querySelector<HTMLElement>(`[data-image-tab="${CSS.escape(ref.id)}"]`)?.click();
    // Let the panel render before the cursor looks for its controls.
    await new Promise((resolve) => setTimeout(resolve, 60));
  };
  const [activeCropRatio, setActiveCropRatio] = useState<number | null>(null);

  // Tool options for the canvas, set by the options bars.
  const [selectionOptions, setSelectionOptions] = useState<SelectionToolOptions>(DEFAULT_SELECTION_TOOL_OPTIONS);
  const [shapeOptions, setShapeOptions] = useState<ShapeToolOptions>(DEFAULT_SHAPE_TOOL_OPTIONS);
  const [typeOptions, setTypeOptions] = useState<TypeToolOptions>(DEFAULT_TYPE_TOOL_OPTIONS);
  const [typeSession, setTypeSession] = useState<TextEditSession | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [paintError, setPaintError] = useState<string | null>(null);
  const [shapeTypeError, setShapeTypeError] = useState<string | null>(null);
  const handleCanvasError = (source: ImageEditorCanvasErrorSource, message: string | null) => {
    if (source === 'paint') setPaintError(message);
    else if (source === 'select') setSelectionError(message);
    else setShapeTypeError(message);
  };
  // The canvas finishes the edit when its session is cleared.
  const finishTyping = () => setTypeSession(null);

  // Free Transform (Ctrl/Cmd+T): shared with the canvas, which drives and draws it.
  const transformToolRef = useRef<FreeTransformTool | null>(null);
  const transformControllerRef = useRef(controller);
  if (!transformToolRef.current || transformControllerRef.current !== controller) {
    transformToolRef.current?.cancel();
    transformToolRef.current = new FreeTransformTool(controller, {
      schedule: (run) => (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(run) : run()),
    });
    transformControllerRef.current = controller;
  }
  const transformTool = transformToolRef.current;
  const [, setTransformTick] = useState(0);
  useEffect(() => transformTool.subscribe(() => setTransformTick((n) => n + 1)), [transformTool]);
  useEffect(() => () => transformToolRef.current?.cancel(), []);

  // AI Tools state
  const [inpaintPrompt, setInpaintPrompt] = useState('');
  const [inpaintMaskMode, setInpaintMaskMode] = useState<'annotations' | 'crop'>('annotations');
  const [isRemovingBg, setIsRemovingBg] = useState(false);
  const [isInpainting, setIsInpainting] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiSuccess, setAiSuccess] = useState<string | null>(null);
  /** Where AI results go: by layer count (auto), a new layer / mask, or replacing the Background. */
  const [aiTarget, setAiTarget] = useState<'auto' | 'new-layer' | 'replace'>('auto');
  const aiOptions = aiTarget === 'auto' ? {} : { target: aiTarget };

  const effectiveOnInpaint = onInpaint || aiHooks?.onInpaint;
  const effectiveOnRemoveBg = onRemoveBackground || aiHooks?.onRemoveBackground;

  const handleRemoveBackground = async () => {
    if (!effectiveOnRemoveBg) {
      setAiError('No background removal hook is configured.');
      return;
    }
    setAiError(null);
    setAiSuccess(null);
    setIsRemovingBg(true);
    try {
      // AI hooks work in natural pixels (no crop or rotation): the source when the result replaces
      // it, the composite of the layers when the result becomes a layer or mask.
      const imageDataUrl = await controller.toAIInputDataURL(aiOptions);
      const result = await effectiveOnRemoveBg({ imageDataUrl });
      if (typeof result === 'string') {
        await editor.applyBackgroundRemovedImage(result, aiOptions);
        setAiSuccess('Background removed successfully!');
      } else {
        setAiSuccess('Background removal complete.');
      }
    } catch (err: any) {
      setAiError(err?.message || 'Failed to remove background.');
    } finally {
      setIsRemovingBg(false);
    }
  };

  const handleInpaint = async () => {
    if (!effectiveOnInpaint) {
      setAiError('No inpainting hook is configured.');
      return;
    }
    if (!inpaintPrompt.trim()) {
      setAiError('Please enter an inpainting prompt.');
      return;
    }
    setAiError(null);
    setAiSuccess(null);
    setIsInpainting(true);
    try {
      // Source image and mask share natural image space so they line up exactly.
      const imageDataUrl = await controller.toAIInputDataURL(aiOptions);
      const maskDataUrl = await editor.toMaskDataURL({
        useAnnotations: inpaintMaskMode === 'annotations',
        useCrop: inpaintMaskMode === 'crop',
      });
      const result = await effectiveOnInpaint({
        prompt: inpaintPrompt.trim(),
        imageDataUrl,
        maskDataUrl,
        cropBox: inpaintMaskMode === 'crop' ? editor.state.crop : null,
      });
      if (typeof result === 'string') {
        await editor.applyInpaintedImage(result, aiOptions);
        setAiSuccess('Inpainting applied successfully!');
      } else {
        setAiSuccess('Inpainting complete.');
      }
    } catch (err: any) {
      setAiError(err?.message || 'Failed to apply inpainting.');
    } finally {
      setIsInpainting(false);
    }
  };

  // Annotation drafting state
  const [activeColor, setActiveColor] = useState('#ef4444');
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [fontSize, setFontSize] = useState(24);
  const [textInput, setTextInput] = useState('');

  // Synchronize initial tool with activeTab
  useEffect(() => {
    if (activeTab === 'crop' && editor.state.activeTool !== 'crop') {
      editor.setTool('crop');
    }
  }, [activeTab, editor]);

  const handleAddText = () => {
    if (!textInput.trim()) return;
    editor.addAnnotation({
      type: 'text',
      x: 50,
      y: 50,
      text: textInput.trim(),
      fontSize,
      color: activeColor,
    });
    setTextInput('');
  };

  const handleExport = async () => {
    const dataUrl = await editor.toDataURL(exportOptions);
    if (onSave) {
      onSave(dataUrl);
    } else {
      // Default download trigger
      const link = document.createElement('a');
      link.download = `edited-image-${Date.now()}.png`;
      link.href = dataUrl;
      link.click();
    }
  };

  return (
    <div
      ref={rootRef}
      className={`relative flex flex-col bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl text-slate-100 ${className}`}
      style={style}
    >
      {/* Top Action Header */}
      <div className="flex flex-wrap items-center justify-between px-4 py-3 bg-slate-950/80 border-b border-slate-800 gap-3">
        {/* Navigation Tabs */}
        <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800 text-xs">
          <button
            type="button"
            data-image-tab="crop"
            onClick={() => {
              setActiveTab('crop');
              editor.setTool('crop');
            }}
            className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
              activeTab === 'crop' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Transform & Crop
          </button>
          <button
            type="button"
            data-image-tab="adjust"
            onClick={() => {
              setActiveTab('adjust');
              editor.setTool('select');
            }}
            className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
              activeTab === 'adjust' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Adjustments
          </button>
          <button
            type="button"
            data-image-tab="layers"
            onClick={() => {
              setActiveTab('layers');
              editor.setTool('select');
            }}
            className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
              activeTab === 'layers' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Layers
          </button>
          <button
            type="button"
            data-image-tab="paint"
            onClick={() => {
              setActiveTab('paint');
              editor.setTool('brush');
            }}
            className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
              activeTab === 'paint' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Paint
          </button>
          <button
            type="button"
            data-image-tab="select"
            onClick={() => {
              setActiveTab('select');
              editor.setTool('select');
            }}
            className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
              activeTab === 'select' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Select & Mask
          </button>
          <button
            type="button"
            data-image-tab="annotate"
            onClick={() => {
              setActiveTab('annotate');
              editor.setTool('pen');
            }}
            className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
              activeTab === 'annotate' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Annotations
          </button>
          <button
            type="button"
            data-image-tab="depth"
            onClick={() => {
              setActiveTab('depth');
              editor.setTool('select');
            }}
            className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
              activeTab === 'depth' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Depth Mask
          </button>
          <button
            type="button"
            data-image-tab="ai"
            onClick={() => {
              setActiveTab('ai');
              editor.setTool('select');
            }}
            className={`px-3 py-1.5 rounded-md font-medium transition-colors flex items-center gap-1.5 ${
              activeTab === 'ai' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
            AI Tools
          </button>
        </div>

        {/* Global Action Tools (Undo/Redo, Zoom, Compare, Save) */}
        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            disabled={!editor.canUndo}
            onClick={() => editor.undo()}
            className="p-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-800"
            title="Undo"
          >
            ↩
          </button>
          <button
            type="button"
            disabled={!editor.canRedo}
            onClick={() => editor.redo()}
            className="p-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-800"
            title="Redo"
          >
            ↪
          </button>
          <button
            type="button"
            onClick={() => editor.reset()}
            className="px-2 py-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200 hover:bg-slate-800"
          >
            Reset
          </button>

          <div className="h-4 w-px bg-slate-800 mx-1" />

          {/* Zoom */}
          <button
            type="button"
            onClick={() => editor.zoomOut()}
            className="p-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800"
            title="Zoom Out"
          >
            -
          </button>
          <span className="font-mono text-slate-400 w-10 text-center">{Math.round(state.zoom * 100)}%</span>
          <button
            type="button"
            onClick={() => editor.zoomIn()}
            className="p-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800"
            title="Zoom In"
          >
            +
          </button>

          <div className="h-4 w-px bg-slate-800 mx-1" />

          {/* Live Compare */}
          <button
            type="button"
            onMouseDown={() => editor.setComparing(true)}
            onMouseUp={() => editor.setComparing(false)}
            onMouseLeave={() => editor.setComparing(false)}
            className="px-2.5 py-1.5 rounded-lg border border-slate-800 bg-slate-900 text-amber-400 hover:bg-slate-800 select-none active:bg-amber-950/40"
          >
            Hold Compare
          </button>

          {/* Save / Export */}
          <button
            type="button"
            onClick={handleExport}
            className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium shadow-md shadow-emerald-900/30 transition-colors"
          >
            Export Image
          </button>
        </div>
      </div>

      {/* Free Transform options bar (Ctrl/Cmd+T), above the viewport while a transform is open */}
      {transformTool.active && <FreeTransformOptionsBar tool={transformTool} className="border-b border-slate-800 bg-slate-900/95 px-4 py-2" />}
      {!transformTool.active && transformTool.error && (
        <div role="alert" className="border-b border-rose-900 bg-rose-950/80 px-4 py-1.5 text-xs text-rose-200">
          {transformTool.error}
        </div>
      )}

      {/* Main Viewport + Sidebar Layout */}
      <div className="flex flex-col md:flex-row flex-1 min-h-[520px] md:h-[560px]">
        {/* Canvas Area */}
        <ImageEditorCanvas
          editor={editor}
          mode={canvasMode}
          fit={fit}
          selectionOptions={selectionOptions}
          shapeOptions={shapeOptions}
          typeOptions={typeOptions}
          annotationColor={activeColor}
          annotationWidth={strokeWidth}
          cropRatio={activeCropRatio}
          onError={handleCanvasError}
          typeSession={typeSession}
          onTypeSessionChange={setTypeSession}
          transformTool={transformTool}
          playback={playback}
          playbackId={playbackId}
          onPlaybackReveal={onPlaybackReveal}
          chromeRoot={rootRef}
          open={openPanel}
          className="flex-1 h-[360px] md:h-full min-h-[320px] bg-slate-950"
        />

        {/* Tab Controls Sidebar */}
        <div className="w-full md:w-80 bg-slate-900/90 border-t md:border-t-0 md:border-l border-slate-800 p-4 overflow-y-auto h-auto md:h-full md:max-h-[560px]">
          {/* TAB 1: CROP & TRANSFORM */}
          {activeTab === 'crop' && (
            <div className="flex flex-col gap-4 text-xs">
              <span className="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">
                Aspect Ratio Presets
              </span>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setActiveCropRatio(null);
                    editor.applyCropPreset(null);
                  }}
                  className={`px-2.5 py-2 rounded-lg border font-medium ${
                    activeCropRatio === null && state.crop
                      ? 'bg-indigo-600 border-indigo-500 text-white'
                      : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
                  }`}
                >
                  Freeform
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveCropRatio(1);
                    editor.applyCropPreset(1);
                  }}
                  className={`px-2.5 py-2 rounded-lg border font-medium ${
                    activeCropRatio === 1
                      ? 'bg-indigo-600 border-indigo-500 text-white'
                      : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
                  }`}
                >
                  1:1 Square
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveCropRatio(4 / 3);
                    editor.applyCropPreset(4 / 3);
                  }}
                  className={`px-2.5 py-2 rounded-lg border font-medium ${
                    activeCropRatio === 4 / 3
                      ? 'bg-indigo-600 border-indigo-500 text-white'
                      : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
                  }`}
                >
                  4:3 Standard
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveCropRatio(16 / 9);
                    editor.applyCropPreset(16 / 9);
                  }}
                  className={`px-2.5 py-2 rounded-lg border font-medium ${
                    activeCropRatio === 16 / 9
                      ? 'bg-indigo-600 border-indigo-500 text-white'
                      : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
                  }`}
                >
                  16:9 Wide
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveCropRatio(3 / 2);
                    editor.applyCropPreset(3 / 2);
                  }}
                  className={`px-2.5 py-2 rounded-lg border font-medium ${
                    activeCropRatio === 3 / 2
                      ? 'bg-indigo-600 border-indigo-500 text-white'
                      : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
                  }`}
                >
                  3:2 Photo
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveCropRatio(null);
                    editor.resetCrop();
                  }}
                  className="px-2.5 py-2 rounded-lg bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 border border-rose-800/40 font-medium"
                >
                  Clear Crop
                </button>
              </div>

              <div className="h-px bg-slate-800 my-1" />

              <span className="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">
                Orientation & Flips
              </span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => editor.rotate(-90)}
                  className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
                >
                  Rotate -90°
                </button>
                <button
                  type="button"
                  onClick={() => editor.rotate(90)}
                  className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
                >
                  Rotate +90°
                </button>
                <button
                  type="button"
                  onClick={() => editor.flipHorizontal()}
                  className={`px-3 py-2 rounded-lg border transition-colors ${
                    state.transform.flipH
                      ? 'bg-indigo-600 border-indigo-500 text-white'
                      : 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'
                  }`}
                >
                  Flip Horizontal
                </button>
                <button
                  type="button"
                  onClick={() => editor.flipVertical()}
                  className={`px-3 py-2 rounded-lg border transition-colors ${
                    state.transform.flipV
                      ? 'bg-indigo-600 border-indigo-500 text-white'
                      : 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'
                  }`}
                >
                  Flip Vertical
                </button>
              </div>
            </div>
          )}

          {/* TAB 2: ADJUSTMENTS */}
          {activeTab === 'adjust' && (
            <div className="flex flex-col gap-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">
                  Color Adjustments
                </span>
                <button
                  type="button"
                  onClick={() => editor.resetAdjustments()}
                  className="text-[10px] text-rose-400 hover:underline"
                >
                  Reset Sliders
                </button>
              </div>

              <Histogram histogram={editor.histogram} />

              {IMAGE_ADJUSTMENT_CONTROLS.map((spec) => (
                <React.Fragment key={spec.id}>
                  <ControlSlider
                    spec={spec}
                    value={readAdjustmentControls(state.adjustments)[spec.id]}
                    disabled={spec.requiresProcess !== undefined && legacyProcess}
                    onChange={(v) => editor.setAdjustments({ [spec.id]: v })}
                  />
                  {spec.id === 'tint' && legacyProcess && (
                    <div
                      className="flex items-center justify-between gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-200"
                      data-testid="image-editor-process-notice"
                    >
                      <span>Legacy rendering (process 1). Tint needs the current process.</span>
                      <button
                        type="button"
                        onClick={() => editor.upgradeProcess()}
                        className="shrink-0 rounded bg-amber-500/20 px-2 py-0.5 hover:bg-amber-500/30"
                      >
                        Update
                      </button>
                    </div>
                  )}
                </React.Fragment>
              ))}

              <div className="border-t border-slate-700/60 pt-3">
                <AdjustmentLayersPanel
                  controller={controller}
                  layers={state.adjustments.layers}
                  histogram={editor.histogram}
                />
              </div>
            </div>
          )}

          {/* TAB: LAYERS */}
          {activeTab === 'layers' && (
            <div className="flex flex-col gap-3 text-xs">
              <span className="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">Layers</span>
              <button
                type="button"
                title="Edit › Free Transform (Ctrl/Cmd+T): the selected pixels, or the whole active layer"
                className="px-2 py-1 rounded text-[11px] bg-slate-800 text-slate-300 hover:text-white self-start disabled:opacity-40"
                disabled={transformTool.active}
                onClick={() => transformTool.begin()}
              >
                Free Transform
              </button>
              <LayersPanel controller={controller} />
              {effectsShown && <ImageProviderEffectsPanel controller={controller} className="border-t border-slate-700/60 pt-3" />}
              <span className="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">Colour</span>
              <ColorProfilePanel controller={controller} />
            </div>
          )}

          {/* TAB: PAINT */}
          {activeTab === 'paint' && (
            <div className="flex flex-col gap-3 text-xs">
              <span className="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">Paint</span>
              <BrushOptionsBar controller={controller} />
              <button
                type="button"
                title="Edit › Free Transform (Ctrl/Cmd+T): the selected pixels, or the whole active layer"
                className="px-2 py-1 rounded text-[11px] bg-slate-800 text-slate-300 hover:text-white self-start"
                disabled={transformTool.active}
                onClick={() => transformTool.begin()}
              >
                Free Transform
              </button>
              {paintError && (
                <p role="alert" className="text-rose-400" data-testid="paint-error">
                  {paintError}
                </p>
              )}
              <div className="border-t border-slate-700/60 pt-3">
                <LayersPanel controller={controller} />
              </div>
            </div>
          )}

          {/* TAB 3: ANNOTATIONS */}
          {activeTab === 'annotate' && (
            <div className="flex flex-col gap-3 text-xs">
              <span className="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">Shape & Type Layers</span>
              <div className="grid grid-cols-2 gap-1.5">
                {(['shape', 'type'] as ImageEditorTool[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={state.activeTool === t}
                    onClick={() => editor.setTool(t)}
                    className={`py-1.5 px-2 rounded-lg font-medium border transition-colors ${
                      state.activeTool === t ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    {t === 'shape' ? 'Shape' : 'Type'}
                  </button>
                ))}
              </div>
              {state.activeTool === 'shape' && <ShapeOptionsBar controller={controller} options={shapeOptions} onChange={setShapeOptions} />}
              {state.activeTool === 'type' && (
                <TypeOptionsBar controller={controller} options={typeOptions} onChange={setTypeOptions} session={typeSession} />
              )}
              {state.activeTool === 'type' && typeSession && (
                <button type="button" onClick={finishTyping} className="self-start rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700">
                  Done editing text
                </button>
              )}
              {shapeTypeError && (
                <p role="alert" className="text-rose-400" data-testid="shape-type-error">
                  {shapeTypeError}
                </p>
              )}
              <div className="h-px bg-slate-800 my-1" />

              <span className="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">
                Draw & Annotate
              </span>

              {/* Tool Picker */}
              <div className="grid grid-cols-3 gap-1.5">
                {(['pen', 'rect', 'circle', 'arrow', 'line'] as ImageEditorTool[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => editor.setTool(t)}
                    className={`py-1.5 px-2 rounded-lg font-medium capitalize border transition-colors ${
                      state.activeTool === t
                        ? 'bg-indigo-600 border-indigo-500 text-white'
                        : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>

              {/* Color & Size */}
              <div className="flex items-center gap-2 mt-2">
                <label className="text-slate-400">Color:</label>
                <input
                  type="color"
                  value={activeColor}
                  onChange={(e) => setActiveColor(e.target.value)}
                  className="w-8 h-8 rounded border border-slate-700 cursor-pointer bg-transparent"
                />
                <div className="flex-1 ml-2">
                  <div className="flex justify-between text-slate-400 mb-0.5">
                    <span>Width:</span>
                    <span className="font-mono">{strokeWidth}px</span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="20"
                    value={strokeWidth}
                    onChange={(e) => setStrokeWidth(Number(e.target.value))}
                    className="w-full accent-indigo-500"
                  />
                </div>
              </div>

              <div className="h-px bg-slate-800 my-1" />

              {/* Text Tool */}
              <span className="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">Add Text</span>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Type watermark or label..."
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddText()}
                  className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                />
                <button
                  type="button"
                  onClick={handleAddText}
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium shadow"
                >
                  Add
                </button>
              </div>
              <div className="flex items-center justify-between text-slate-400">
                <span>Font Size:</span>
                <span className="font-mono">{fontSize}px</span>
              </div>
              <input
                type="range"
                min="12"
                max="72"
                value={fontSize}
                onChange={(e) => setFontSize(Number(e.target.value))}
                className="w-full accent-indigo-500"
              />

              {/* Layers & Selected Annotation */}
              <div className="h-px bg-slate-800 my-1" />
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Layers ({state.annotations.length})</span>
                {state.selectedAnnotationId && (
                  <button
                    type="button"
                    onClick={() => editor.removeAnnotation(state.selectedAnnotationId!)}
                    className="text-rose-400 hover:underline text-[11px]"
                  >
                    Delete Selected
                  </button>
                )}
                {state.annotations.length > 0 && (
                  <button
                    type="button"
                    onClick={() => editor.clearAnnotations()}
                    className="text-slate-400 hover:text-slate-200 text-[11px]"
                  >
                    Clear All
                  </button>
                )}
              </div>
            </div>
          )}

          {/* TAB 4: GLEAMFORGE DEPTH MASKING */}
          {activeTab === 'depth' && (
            <div className="flex flex-col gap-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">
                  Depth Masking
                </span>
                <button
                  type="button"
                  onClick={() => editor.resetDepthMask()}
                  className="text-[10px] text-rose-400 hover:underline"
                >
                  Reset Mask
                </button>
              </div>

              <label className="flex items-center gap-2 cursor-pointer text-slate-300">
                <input
                  type="checkbox"
                  checked={state.depthMask.enabled}
                  onChange={(e) => editor.setDepthMask({ enabled: e.target.checked })}
                  className="rounded accent-indigo-500"
                />
                <span>Enable Depth / Alpha Mask</span>
              </label>

              {state.depthMask.enabled && (
                <>
                  <div>
                    <label className="text-slate-400 block mb-1">Mask Image URL:</label>
                    <input
                      type="text"
                      placeholder="https://.../depthmap.png"
                      value={state.depthMask.maskSource || ''}
                      onChange={(e) => editor.setDepthMask({ maskSource: e.target.value || null })}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500"
                    />
                  </div>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => editor.setDepthMask({ mode: 'threshold' })}
                      className={`flex-1 py-1.5 rounded-lg border text-xs font-medium ${
                        state.depthMask.mode === 'threshold'
                          ? 'bg-indigo-600 border-indigo-500 text-white'
                          : 'bg-slate-800 border-slate-700 text-slate-300'
                      }`}
                    >
                      Threshold Mode
                    </button>
                    <button
                      type="button"
                      onClick={() => editor.setDepthMask({ mode: 'brightness' })}
                      className={`flex-1 py-1.5 rounded-lg border text-xs font-medium ${
                        state.depthMask.mode === 'brightness'
                          ? 'bg-indigo-600 border-indigo-500 text-white'
                          : 'bg-slate-800 border-slate-700 text-slate-300'
                      }`}
                    >
                      Brightness Mode
                    </button>
                  </div>

                  <div>
                    <div className="flex justify-between text-slate-400 mb-1">
                      <span>Depth Start (Lower):</span>
                      <span className="font-mono">{state.depthMask.depthRange[0]}</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="255"
                      value={state.depthMask.depthRange[0]}
                      onChange={(e) =>
                        editor.setDepthMask({
                          depthRange: [Number(e.target.value), state.depthMask.depthRange[1]],
                        })
                      }
                      className="w-full accent-indigo-500"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-slate-400 mb-1">
                      <span>Depth Stop (Upper):</span>
                      <span className="font-mono">{state.depthMask.depthRange[1]}</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="255"
                      value={state.depthMask.depthRange[1]}
                      onChange={(e) =>
                        editor.setDepthMask({
                          depthRange: [state.depthMask.depthRange[0], Number(e.target.value)],
                        })
                      }
                      className="w-full accent-indigo-500"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-slate-400 mb-1">
                      <span>Softness:</span>
                      <span className="font-mono">{state.depthMask.softness}</span>
                    </div>
                    <input
                      type="range"
                      min="1"
                      max="50"
                      value={state.depthMask.softness}
                      onChange={(e) => editor.setDepthMask({ softness: Number(e.target.value) })}
                      className="w-full accent-indigo-500"
                    />
                  </div>

                  <label className="flex items-center gap-2 cursor-pointer text-slate-300 mt-1">
                    <input
                      type="checkbox"
                      checked={state.depthMask.invert}
                      onChange={(e) => editor.setDepthMask({ invert: e.target.checked })}
                      className="rounded accent-indigo-500"
                    />
                    <span>Invert Mask</span>
                  </label>
                </>
              )}
            </div>
          )}

          {/* SELECT & MASK: selection tools, refine edge, layer masks */}
          {activeTab === 'select' && (
            <div className="flex flex-col gap-4 text-xs">
              <SelectionOptionsBar
                controller={controller}
                options={selectionOptions}
                onOptionsChange={setSelectionOptions}
                selection={state.selection ?? null}
                quickMask={Boolean(state.quickMask)}
              />
              {selectionError && (
                <p role="alert" className="text-rose-400">
                  {selectionError}
                </p>
              )}
              <div className="flex gap-1">
                <button
                type="button"
                title="Select › Transform Selection: the outline only"
                className="px-2 py-1 rounded text-[11px] bg-slate-800 text-slate-300 hover:text-white self-start disabled:opacity-40"
                disabled={transformTool.active}
                onClick={() => transformTool.begin({ content: 'selection-outline' })}
              >
                Transform Selection
              </button>
                <button
                type="button"
                title="Edit › Free Transform: the selected pixels of the active layer"
                className="px-2 py-1 rounded text-[11px] bg-slate-800 text-slate-300 hover:text-white self-start disabled:opacity-40"
                disabled={transformTool.active}
                onClick={() => transformTool.begin({ content: 'selection' })}
              >
                Free Transform Pixels
              </button>
              </div>
              <RefineEdgePanel controller={controller} selection={state.selection ?? null} layers={state.adjustments.layers} />
            </div>
          )}

          {/* TAB 5: AI TOOLS / INPAINTING & BACKGROUND REMOVAL */}
          {activeTab === 'ai' && (
            <div className="flex flex-col gap-4 text-xs">
              <label className="flex items-center justify-between gap-2 text-slate-300">
                <span>Results go to</span>
                <select
                  aria-label="AI result target"
                  value={aiTarget}
                  onChange={(e) => setAiTarget(e.target.value as typeof aiTarget)}
                  className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1"
                >
                  <option value="auto">{controller.isMultiLayer ? 'Auto (new layer)' : 'Auto (replace image)'}</option>
                  <option value="new-layer">New layer / mask</option>
                  <option value="replace">Replace image</option>
                </select>
              </label>
              {/* Background Removal Section */}
              <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800 flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-200 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                    <svg className="w-3.5 h-3.5 text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
                    </svg>
                    Background Removal
                  </span>
                  {isRemovingBg && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-900/60 text-indigo-300 animate-pulse">
                      Removing...
                    </span>
                  )}
                </div>

                <p className="text-slate-400 text-[11px] leading-relaxed">
                  Isolate foreground subject with AI alpha transparency segmentation.
                </p>

                <button
                  type="button"
                  onClick={handleRemoveBackground}
                  disabled={isRemovingBg || isInpainting}
                  className="mt-1 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium shadow transition-colors flex items-center justify-center gap-2"
                >
                  {isRemovingBg ? (
                    <>
                      <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      Removing Background...
                    </>
                  ) : (
                    <>
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                      </svg>
                      Remove Background
                    </>
                  )}
                </button>
              </div>

              {/* AI Inpainting / Generative Fill Section */}
              <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800 flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-200 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                    <svg className="w-3.5 h-3.5 text-purple-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="m21.64 3.64-1.28-1.28a1.2 1.2 0 0 0-1.7 0l-9.72 9.72-1.94 4.86 4.86-1.94 9.72-9.72a1.2 1.2 0 0 0 .06-1.64z" />
                      <path d="m14 7 3 3" />
                    </svg>
                    Generative Inpainting
                  </span>
                  {isInpainting && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-900/60 text-purple-300 animate-pulse">
                      Inpainting...
                    </span>
                  )}
                </div>

                <p className="text-slate-400 text-[11px] leading-relaxed">
                  Replace, modify, or fill selected regions using prompt-guided generative inpainting.
                </p>

                <div className="flex flex-col gap-1">
                  <label htmlFor="ai-inpaint-prompt-react" className="text-slate-300 text-[11px] font-medium">Prompt</label>
                  <textarea
                    id="ai-inpaint-prompt-react"
                    value={inpaintPrompt}
                    onChange={(e) => setInpaintPrompt(e.target.value)}
                    placeholder="e.g. replace sunglasses with steampunk goggles, remove person in background..."
                    rows={3}
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 resize-none"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-slate-300 text-[11px] font-medium">Target Mask Region</span>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() => setInpaintMaskMode('annotations')}
                      className={`px-2 py-1.5 rounded border text-[11px] font-medium text-left transition-colors ${
                        inpaintMaskMode === 'annotations'
                          ? 'bg-purple-600/30 border-purple-500 text-purple-200'
                          : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Drawn Shapes ({state.annotations.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setInpaintMaskMode('crop')}
                      className={`px-2 py-1.5 rounded border text-[11px] font-medium text-left transition-colors ${
                        inpaintMaskMode === 'crop'
                          ? 'bg-purple-600/30 border-purple-500 text-purple-200'
                          : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Crop Box ({state.crop ? 'Selected' : 'Full'})
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleInpaint}
                  disabled={isInpainting || isRemovingBg || !inpaintPrompt.trim()}
                  className="mt-1 px-3 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-medium shadow transition-colors flex items-center justify-center gap-2"
                >
                  {isInpainting ? (
                    <>
                      <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      Generating Inpaint...
                    </>
                  ) : (
                    <>
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                      </svg>
                      Apply Inpainting
                    </>
                  )}
                </button>
              </div>

              {aiError && (
                <div className="p-2.5 rounded-lg bg-rose-950/60 border border-rose-800 text-rose-300 text-[11px]">
                  {aiError}
                </div>
              )}

              {aiSuccess && (
                <div className="p-2.5 rounded-lg bg-emerald-950/60 border border-emerald-800 text-emerald-300 text-[11px]">
                  {aiSuccess}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
