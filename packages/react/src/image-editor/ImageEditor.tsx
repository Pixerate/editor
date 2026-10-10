import React, { useRef, useEffect, useState, useCallback } from 'react';
import type {
  Annotation,
  CropBox,
  CropHandle,
  ExportOptions,
  ImageEditorTool,
  ImagePoint,
  InpaintHook,
  RemoveBackgroundHook,
  ImageEditorAIHooks,
} from '@pixerate/editor';
import {
  canvasToImagePoint,
  hitTestCrop,
  getCropCursor,
  calculateCropDrag,
  hitTestAnnotation,
} from '@pixerate/editor';
import { useImageEditor, type UseImageEditorReturn } from './useImageEditor';

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
}

type TabType = 'crop' | 'adjust' | 'annotate' | 'depth' | 'ai';

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
}) => {
  const internalEditor = useImageEditor({ image: src });
  const editor = externalEditor || internalEditor;
  const { state, controller } = editor;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<TabType>('crop');
  const [activeCropRatio, setActiveCropRatio] = useState<number | null>(null);

  // AI Tools state
  const [inpaintPrompt, setInpaintPrompt] = useState('');
  const [inpaintMaskMode, setInpaintMaskMode] = useState<'annotations' | 'crop'>('annotations');
  const [isRemovingBg, setIsRemovingBg] = useState(false);
  const [isInpainting, setIsInpainting] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiSuccess, setAiSuccess] = useState<string | null>(null);

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
      const imageDataUrl = await editor.toDataURL(exportOptions);
      const result = await effectiveOnRemoveBg({ imageDataUrl });
      if (typeof result === 'string') {
        await editor.applyBackgroundRemovedImage(result);
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
      const imageDataUrl = await editor.toDataURL(exportOptions);
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
        await editor.applyInpaintedImage(result);
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

  // Live draft and drag references
  const draftAnnotationRef = useRef<Annotation | null>(null);
  const draftCropRef = useRef<CropBox | null>(null);
  const cropDragInfoRef = useRef<{
    handle: CropHandle | 'new';
    startCanvasPt: ImagePoint;
    startImgPt: ImagePoint;
    startCrop: CropBox;
  } | null>(null);
  const annotationDragInfoRef = useRef<{
    annId: string;
    startImgPt: ImagePoint;
    initialAnn: Annotation;
  } | null>(null);
  const isDrawingRef = useRef(false);
  const currentPathRef = useRef<ImagePoint[]>([]);
  const dragStartPointRef = useRef<ImagePoint | null>(null);

  // Canvas viewport sizing and re-render
  const renderCanvas = useCallback(
    async (draftAnnotation?: Annotation | null, draftCrop?: CropBox | null) => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;

      const vpWidth = container.clientWidth || 800;
      const vpHeight = container.clientHeight || 500;

      await controller.render(canvas, {
        viewportWidth: vpWidth,
        viewportHeight: vpHeight,
        showCropOverlay: activeTab === 'crop',
        showSelectionOverlay: true,
        interactive: true,
        draftAnnotation: draftAnnotation !== undefined ? draftAnnotation : draftAnnotationRef.current,
        draftCrop: draftCrop !== undefined ? draftCrop : draftCropRef.current,
      });
    },
    [controller, activeTab]
  );

  useEffect(() => {
    const raf =
      typeof requestAnimationFrame !== 'undefined'
        ? requestAnimationFrame
        : (cb: () => void) => setTimeout(cb, 0) as unknown as number;
    const caf =
      typeof cancelAnimationFrame !== 'undefined'
        ? cancelAnimationFrame
        : (id: number) => clearTimeout(id);

    const animId = raf(() => {
      renderCanvas();
    });
    return () => caf(animId);
  }, [renderCanvas, state]);

  // Synchronize initial tool with activeTab
  useEffect(() => {
    if (activeTab === 'crop' && editor.state.activeTool !== 'crop') {
      editor.setTool('crop');
    }
  }, [activeTab, editor]);

  // Container resize observer to safely adapt viewport without feedback loops
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        renderCanvas();
      });
      observer.observe(container);
      return () => observer.disconnect();
    } else {
      const handleResize = () => renderCanvas();
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    }
  }, [renderCanvas]);

  // Convert mouse event coordinates to internal canvas pixel space
  const getCanvasEventPoint = (e: React.MouseEvent<HTMLCanvasElement>): ImagePoint => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width > 0 ? canvas.width / rect.width : 1;
    const scaleY = rect.height > 0 ? canvas.height / rect.height : 1;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  // Pointer event handlers for drawing and annotations
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const canvasPt = getCanvasEventPoint(e);

    if (activeTab === 'crop') {
      const activeCrop = draftCropRef.current || state.crop || {
        x: 0,
        y: 0,
        width: state.imageDimensions.width,
        height: state.imageDimensions.height,
      };
      const handle = hitTestCrop(canvasPt, state, canvas.width, canvas.height, 14, activeCrop);
      const startImgPt = canvasToImagePoint(canvasPt, state, canvas.width, canvas.height, true);

      if (handle) {
        cropDragInfoRef.current = {
          handle,
          startCanvasPt: canvasPt,
          startImgPt,
          startCrop: activeCrop,
        };
      } else {
        // Clicked outside crop box: start new crop selection
        cropDragInfoRef.current = {
          handle: 'new',
          startCanvasPt: canvasPt,
          startImgPt,
          startCrop: { x: startImgPt.x, y: startImgPt.y, width: 0, height: 0 },
        };
      }
      return;
    }

    if (activeTab === 'annotate') {
      const imgPt = canvasToImagePoint(canvasPt, state, canvas.width, canvas.height, false);
      dragStartPointRef.current = imgPt;

      if (state.activeTool === 'select') {
        for (let i = state.annotations.length - 1; i >= 0; i--) {
          const ann = state.annotations[i];
          if (hitTestAnnotation(imgPt, ann)) {
            editor.selectAnnotation(ann.id);
            annotationDragInfoRef.current = {
              annId: ann.id,
              startImgPt: imgPt,
              initialAnn: { ...ann },
            };
            return;
          }
        }
        editor.selectAnnotation(null);
        return;
      }

      if (state.activeTool === 'pen') {
        isDrawingRef.current = true;
        currentPathRef.current = [imgPt];
        const draft: Annotation = {
          id: 'draft',
          type: 'pen',
          x: 0,
          y: 0,
          points: [imgPt],
          strokeColor: activeColor,
          strokeWidth,
        };
        draftAnnotationRef.current = draft;
        renderCanvas(draft);
      }
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const canvasPt = getCanvasEventPoint(e);

    if (activeTab === 'crop') {
      const drag = cropDragInfoRef.current;
      if (drag) {
        const currentImgPt = canvasToImagePoint(canvasPt, state, canvas.width, canvas.height, true);
        let newCrop: CropBox;

        if (drag.handle === 'new') {
          const minX = Math.max(0, Math.min(drag.startImgPt.x, currentImgPt.x));
          const minY = Math.max(0, Math.min(drag.startImgPt.y, currentImgPt.y));
          const maxX = Math.min(state.imageDimensions.width, Math.max(drag.startImgPt.x, currentImgPt.x));
          const maxY = Math.min(state.imageDimensions.height, Math.max(drag.startImgPt.y, currentImgPt.y));
          newCrop = {
            x: Math.round(minX),
            y: Math.round(minY),
            width: Math.round(Math.max(20, maxX - minX)),
            height: Math.round(Math.max(20, maxY - minY)),
          };
        } else {
          newCrop = calculateCropDrag(
            drag.startCrop,
            drag.handle,
            drag.startImgPt,
            currentImgPt,
            state.imageDimensions.width,
            state.imageDimensions.height,
            activeCropRatio
          );
        }

        draftCropRef.current = newCrop;
        renderCanvas(null, newCrop);
      } else {
        const activeCrop = draftCropRef.current || state.crop || {
          x: 0,
          y: 0,
          width: state.imageDimensions.width,
          height: state.imageDimensions.height,
        };
        const handle = hitTestCrop(canvasPt, state, canvas.width, canvas.height, 14, activeCrop);
        canvas.style.cursor = getCropCursor(handle);
      }
      return;
    }

    if (activeTab === 'annotate') {
      // If moving selected annotation
      if (annotationDragInfoRef.current) {
        const drag = annotationDragInfoRef.current;
        const currentImgPt = canvasToImagePoint(canvasPt, state, canvas.width, canvas.height, false);
        const dx = currentImgPt.x - drag.startImgPt.x;
        const dy = currentImgPt.y - drag.startImgPt.y;
        editor.updateAnnotation(drag.annId, {
          x: Math.round(drag.initialAnn.x + dx),
          y: Math.round(drag.initialAnn.y + dy),
        });
        return;
      }

      const startPt = dragStartPointRef.current;
      if (!startPt) {
        // Update cursor for hover on select tool
        if (state.activeTool === 'select') {
          const imgPt = canvasToImagePoint(canvasPt, state, canvas.width, canvas.height, false);
          let hovered = false;
          for (let i = state.annotations.length - 1; i >= 0; i--) {
            if (hitTestAnnotation(imgPt, state.annotations[i])) {
              hovered = true;
              break;
            }
          }
          canvas.style.cursor = hovered ? 'move' : 'default';
        } else {
          canvas.style.cursor = 'crosshair';
        }
        return;
      }

      const currentImgPt = canvasToImagePoint(canvasPt, state, canvas.width, canvas.height, false);

      if (state.activeTool === 'pen' && isDrawingRef.current) {
        currentPathRef.current.push(currentImgPt);
        const draft: Annotation = {
          id: 'draft',
          type: 'pen',
          x: 0,
          y: 0,
          points: [...currentPathRef.current],
          strokeColor: activeColor,
          strokeWidth,
        };
        draftAnnotationRef.current = draft;
        renderCanvas(draft);
      } else if (state.activeTool === 'rect') {
        const w = currentImgPt.x - startPt.x;
        const h = currentImgPt.y - startPt.y;
        const draft: Annotation = {
          id: 'draft',
          type: 'rect',
          x: Math.min(startPt.x, currentImgPt.x),
          y: Math.min(startPt.y, currentImgPt.y),
          width: Math.abs(w),
          height: Math.abs(h),
          strokeColor: activeColor,
          strokeWidth,
        };
        draftAnnotationRef.current = draft;
        renderCanvas(draft);
      } else if (state.activeTool === 'circle') {
        const rx = Math.abs(currentImgPt.x - startPt.x) / 2;
        const ry = Math.abs(currentImgPt.y - startPt.y) / 2;
        const draft: Annotation = {
          id: 'draft',
          type: 'circle',
          x: Math.min(startPt.x, currentImgPt.x) + rx,
          y: Math.min(startPt.y, currentImgPt.y) + ry,
          radiusX: rx,
          radiusY: ry,
          strokeColor: activeColor,
          strokeWidth,
        };
        draftAnnotationRef.current = draft;
        renderCanvas(draft);
      } else if (state.activeTool === 'arrow') {
        const draft: Annotation = {
          id: 'draft',
          type: 'arrow',
          x: startPt.x,
          y: startPt.y,
          endX: currentImgPt.x,
          endY: currentImgPt.y,
          strokeColor: activeColor,
          strokeWidth,
        };
        draftAnnotationRef.current = draft;
        renderCanvas(draft);
      } else if (state.activeTool === 'line') {
        const draft: Annotation = {
          id: 'draft',
          type: 'line',
          x: startPt.x,
          y: startPt.y,
          endX: currentImgPt.x,
          endY: currentImgPt.y,
          strokeColor: activeColor,
          strokeWidth,
        };
        draftAnnotationRef.current = draft;
        renderCanvas(draft);
      }
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const canvasPt = getCanvasEventPoint(e);

    if (activeTab === 'crop') {
      if (cropDragInfoRef.current) {
        if (
          draftCropRef.current &&
          draftCropRef.current.width >= 20 &&
          draftCropRef.current.height >= 20
        ) {
          editor.setCrop(draftCropRef.current, true);
        }
        cropDragInfoRef.current = null;
        draftCropRef.current = null;
        renderCanvas();
      }
      return;
    }

    if (activeTab === 'annotate') {
      if (annotationDragInfoRef.current) {
        annotationDragInfoRef.current = null;
        return;
      }

      const startPt = dragStartPointRef.current;
      if (startPt) {
        const currentImgPt = canvasToImagePoint(canvasPt, state, canvas.width, canvas.height, false);

        if (state.activeTool === 'pen' && isDrawingRef.current) {
          if (currentPathRef.current.length > 1) {
            editor.addAnnotation({
              type: 'pen',
              x: 0,
              y: 0,
              points: [...currentPathRef.current],
              strokeColor: activeColor,
              strokeWidth,
            });
          }
          isDrawingRef.current = false;
          currentPathRef.current = [];
        } else if (state.activeTool === 'rect') {
          const w = Math.abs(currentImgPt.x - startPt.x);
          const h = Math.abs(currentImgPt.y - startPt.y);
          if (w > 4 && h > 4) {
            editor.addAnnotation({
              type: 'rect',
              x: Math.min(startPt.x, currentImgPt.x),
              y: Math.min(startPt.y, currentImgPt.y),
              width: w,
              height: h,
              strokeColor: activeColor,
              strokeWidth,
            });
          }
        } else if (state.activeTool === 'circle') {
          const rx = Math.abs(currentImgPt.x - startPt.x) / 2;
          const ry = Math.abs(currentImgPt.y - startPt.y) / 2;
          if (rx > 4 && ry > 4) {
            editor.addAnnotation({
              type: 'circle',
              x: Math.min(startPt.x, currentImgPt.x) + rx,
              y: Math.min(startPt.y, currentImgPt.y) + ry,
              radiusX: rx,
              radiusY: ry,
              strokeColor: activeColor,
              strokeWidth,
            });
          }
        } else if (state.activeTool === 'arrow') {
          if (Math.hypot(currentImgPt.x - startPt.x, currentImgPt.y - startPt.y) > 4) {
            editor.addAnnotation({
              type: 'arrow',
              x: startPt.x,
              y: startPt.y,
              endX: currentImgPt.x,
              endY: currentImgPt.y,
              strokeColor: activeColor,
              strokeWidth,
            });
          }
        } else if (state.activeTool === 'line') {
          if (Math.hypot(currentImgPt.x - startPt.x, currentImgPt.y - startPt.y) > 4) {
            editor.addAnnotation({
              type: 'line',
              x: startPt.x,
              y: startPt.y,
              endX: currentImgPt.x,
              endY: currentImgPt.y,
              strokeColor: activeColor,
              strokeWidth,
            });
          }
        }

        draftAnnotationRef.current = null;
        dragStartPointRef.current = null;
        renderCanvas();
      }
    }
  };

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
      className={`flex flex-col bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl text-slate-100 ${className}`}
      style={style}
    >
      {/* Top Action Header */}
      <div className="flex flex-wrap items-center justify-between px-4 py-3 bg-slate-950/80 border-b border-slate-800 gap-3">
        {/* Navigation Tabs */}
        <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800 text-xs">
          <button
            type="button"
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

      {/* Main Viewport + Sidebar Layout */}
      <div className="flex flex-col md:flex-row flex-1 min-h-[520px] md:h-[560px]">
        {/* Canvas Area */}
        <div
          ref={containerRef}
          className="relative flex-1 h-[360px] md:h-full min-h-[320px] bg-slate-950 overflow-hidden select-none"
        >
          <canvas
            ref={canvasRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            className="absolute inset-0 w-full h-full block"
          />
        </div>

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

              {/* Brightness */}
              <div>
                <div className="flex justify-between text-slate-400 mb-1">
                  <span>Brightness</span>
                  <span className="font-mono">{state.adjustments.brightness}</span>
                </div>
                <input
                  type="range"
                  min="-100"
                  max="100"
                  value={state.adjustments.brightness}
                  onChange={(e) => editor.setAdjustments({ brightness: Number(e.target.value) })}
                  className="w-full accent-indigo-500"
                />
              </div>

              {/* Contrast */}
              <div>
                <div className="flex justify-between text-slate-400 mb-1">
                  <span>Contrast</span>
                  <span className="font-mono">{state.adjustments.contrast}</span>
                </div>
                <input
                  type="range"
                  min="-100"
                  max="100"
                  value={state.adjustments.contrast}
                  onChange={(e) => editor.setAdjustments({ contrast: Number(e.target.value) })}
                  className="w-full accent-indigo-500"
                />
              </div>

              {/* Saturation */}
              <div>
                <div className="flex justify-between text-slate-400 mb-1">
                  <span>Saturation</span>
                  <span className="font-mono">{state.adjustments.saturation}</span>
                </div>
                <input
                  type="range"
                  min="-100"
                  max="100"
                  value={state.adjustments.saturation}
                  onChange={(e) => editor.setAdjustments({ saturation: Number(e.target.value) })}
                  className="w-full accent-indigo-500"
                />
              </div>

              {/* Exposure */}
              <div>
                <div className="flex justify-between text-slate-400 mb-1">
                  <span>Exposure</span>
                  <span className="font-mono">{state.adjustments.exposure}</span>
                </div>
                <input
                  type="range"
                  min="-100"
                  max="100"
                  value={state.adjustments.exposure}
                  onChange={(e) => editor.setAdjustments({ exposure: Number(e.target.value) })}
                  className="w-full accent-indigo-500"
                />
              </div>

              {/* Temperature / Warmth */}
              <div>
                <div className="flex justify-between text-slate-400 mb-1">
                  <span>Warmth / Temperature</span>
                  <span className="font-mono">{state.adjustments.temperature}</span>
                </div>
                <input
                  type="range"
                  min="-100"
                  max="100"
                  value={state.adjustments.temperature}
                  onChange={(e) => editor.setAdjustments({ temperature: Number(e.target.value) })}
                  className="w-full accent-indigo-500"
                />
              </div>

              {/* Blur */}
              <div>
                <div className="flex justify-between text-slate-400 mb-1">
                  <span>Blur</span>
                  <span className="font-mono">{state.adjustments.blur}px</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="30"
                  value={state.adjustments.blur}
                  onChange={(e) => editor.setAdjustments({ blur: Number(e.target.value) })}
                  className="w-full accent-indigo-500"
                />
              </div>

              {/* Opacity */}
              <div>
                <div className="flex justify-between text-slate-400 mb-1">
                  <span>Opacity</span>
                  <span className="font-mono">{Math.round(state.adjustments.opacity * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={state.adjustments.opacity}
                  onChange={(e) => editor.setAdjustments({ opacity: Number(e.target.value) })}
                  className="w-full accent-indigo-500"
                />
              </div>
            </div>
          )}

          {/* TAB 3: ANNOTATIONS */}
          {activeTab === 'annotate' && (
            <div className="flex flex-col gap-3 text-xs">
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

          {/* TAB 5: AI TOOLS / INPAINTING & BACKGROUND REMOVAL */}
          {activeTab === 'ai' && (
            <div className="flex flex-col gap-4 text-xs">
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
