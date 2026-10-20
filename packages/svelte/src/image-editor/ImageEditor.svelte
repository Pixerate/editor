<script lang="ts">
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
    ImageEditorFit,
  } from '@pixerate/editor/image-editor';
  import {
    canvasToImagePoint,
    hitTestCrop,
    getCropCursor,
    calculateCropDrag,
    hitTestAnnotation,
    normalizeProcessVersion,
    LATEST_PROCESS_VERSION,
    IMAGE_ADJUSTMENT_CONTROLS,
    readAdjustmentControls,
    DEFAULT_SELECTION_TOOL_OPTIONS,
    SelectionGesture,
    PaintGesture,
    handlePaintShortcut,
    pointerPressure,
    FreeTransformTool,
    getViewportProjection,
    ShapeDrawGesture,
    TypeToolGesture,
    DEFAULT_SHAPE_TOOL_OPTIONS,
    DEFAULT_TYPE_TOOL_OPTIONS,
    type SelectionToolOptions,
    type ShapeToolOptions,
    type TextEditSession,
    type TypeToolOptions,
  } from '@pixerate/editor/image-editor';
  import ControlSlider from './ControlSlider.svelte';
  import Histogram from './Histogram.svelte';
  import AdjustmentLayersPanel from './AdjustmentLayersPanel.svelte';
  import LayersPanel from './LayersPanel.svelte';
  import BrushOptionsBar from './BrushOptionsBar.svelte';
  import SelectionOptionsBar from './SelectionOptionsBar.svelte';
  import RefineEdgePanel from './RefineEdgePanel.svelte';
  import FreeTransformOptionsBar from './FreeTransformOptionsBar.svelte';
  import ShapeOptionsBar from './ShapeOptionsBar.svelte';
  import TypeOptionsBar from './TypeOptionsBar.svelte';
  import { onDestroy, untrack } from 'svelte';
  import { createReactiveImageEditor, type ReactiveImageEditor } from './imageEditorState.svelte.js';

  interface Props {
    editor?: ReactiveImageEditor;
    src?: string;
    class?: string;
    style?: string;
    onSave?: (dataUrl: string) => void;
    exportOptions?: ExportOptions;
    onInpaint?: InpaintHook;
    onRemoveBackground?: RemoveBackgroundHook;
    aiHooks?: ImageEditorAIHooks;
    fit?: ImageEditorFit;
  }

  let {
    editor: propEditor,
    src = '',
    class: className = '',
    style = '',
    onSave,
    exportOptions,
    onInpaint,
    onRemoveBackground,
    aiHooks,
    fit,
  }: Props = $props();

  const internalEditor = createReactiveImageEditor();
  const editor = $derived(propEditor || internalEditor);
  onDestroy(() => internalEditor.destroy());
  const legacyProcess = $derived(
    normalizeProcessVersion(editor.state.adjustments.process) < LATEST_PROCESS_VERSION
  );

  let canvasEl = $state<HTMLCanvasElement | null>(null);
  let containerEl = $state<HTMLDivElement | null>(null);
  let activeTab = $state<'crop' | 'adjust' | 'layers' | 'paint' | 'select' | 'annotate' | 'depth' | 'ai'>('crop');

  // Selection tools (magic wand, marquees, lasso): options bar state and the pointer gesture.
  let selectionOptions = $state<SelectionToolOptions>({ ...DEFAULT_SELECTION_TOOL_OPTIONS });
  const selectionGesture = $derived(new SelectionGesture(editor.controller, () => selectionOptions));
  // Paint tools (Move, Brush, Eraser): the pointer gesture and the brush cursor.
  const paintGesture = $derived(new PaintGesture(editor.controller));
  let brushCursor: ImagePoint | null = null;

  // Shape and type tools: their options and gestures; type is edited on the canvas through a hidden textarea.
  let shapeOptions = $state<ShapeToolOptions>({ ...DEFAULT_SHAPE_TOOL_OPTIONS });
  let typeOptions = $state<TypeToolOptions>({ ...DEFAULT_TYPE_TOOL_OPTIONS });
  const shapeGesture = $derived(new ShapeDrawGesture(editor.controller, () => shapeOptions));
  const typeTool = $derived(new TypeToolGesture(editor.controller, () => typeOptions));
  let typeSession = $state<TextEditSession | null>(null);
  let typeInputEl = $state<HTMLTextAreaElement | null>(null);
  let shapeTypeError = $state<string | null>(null);
  $effect(() => {
    const s = typeSession;
    if (!s) return;
    return untrack(() => s.subscribe(() => void renderCanvas()));
  });
  $effect(() => {
    // End the edit when the tool or tab changes.
    const keep = activeTab === 'annotate' && editor.state.activeTool === 'type';
    untrack(() => {
      if (!keep && typeTool.session) finishTyping();
    });
  });
  function finishTyping() {
    typeTool.finish();
    typeSession = null;
    void renderCanvas();
  }
  function handleTypeKeyDown(e: KeyboardEvent) {
    const session = typeTool.session;
    if (!session || e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      finishTyping();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && ['z', 'y', 'c', 'x', 'v'].includes(e.key.toLowerCase())) return;
    if (session.handleKey(e)) {
      e.preventDefault();
      shapeTypeError = session.error;
    }
  }
  function handleTypeInput(e: Event) {
    // Composed (IME) and pasted text arrives here; plain keys were handled on keydown.
    const el = e.currentTarget as HTMLTextAreaElement;
    const session = typeTool.session;
    if (session && el.value && !(e as InputEvent).isComposing) {
      session.insert(el.value);
      el.value = '';
    }
  }
  function handleTypeComposition(e: CompositionEvent) {
    const session = typeTool.session;
    if (session && e.data) session.insert(e.data);
    (e.currentTarget as HTMLTextAreaElement).value = '';
  }

  // Free Transform (Ctrl/Cmd+T): the shared tool drives a session; its overlay is drawn by the renderer.
  const transformTool = $derived(
    new FreeTransformTool(editor.controller, {
      schedule: (run) => (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(run) : run()),
    })
  );
  let transformTick = $state(0);
  let transformCursor = $state('default');
  const transformActive = $derived((void transformTick, transformTool.active));
  const transformError = $derived((void transformTick, transformTool.error));
  $effect(() => {
    const tool = transformTool;
    const off = tool.subscribe(() => {
      transformTick++;
      void renderCanvas();
    });
    return () => {
      off();
      tool.cancel();
    };
  });
  $effect(() => {
    if (typeof window === 'undefined') return;
    const tool = transformTool;
    const onKey = (e: KeyboardEvent) => {
      if (tool.key(e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /** The document point of a pointer event and the hit tolerance (6 screen px). */
  function transformPoint(e: PointerEvent) {
    const rect = canvasEl!.getBoundingClientRect();
    const sx = rect.width > 0 ? canvasEl!.width / rect.width : 1;
    const sy = rect.height > 0 ? canvasEl!.height / rect.height : 1;
    const s = editor.controller.getState();
    const cropping = activeTab === 'crop';
    const projection = getViewportProjection(s, canvasEl!.width, canvasEl!.height, cropping);
    const pt = canvasToImagePoint({ x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy }, s, canvasEl!.width, canvasEl!.height, cropping);
    transformTool.setView(projection.scale);
    return { pt, tolerance: 6 / (projection.scale || 1) };
  }
  function handleTransformPointerDown(e: PointerEvent): boolean {
    if (!transformTool.active || !canvasEl) return false;
    if (e.button !== 0) return true;
    e.preventDefault();
    try {
      canvasEl.setPointerCapture?.(e.pointerId);
    } catch {
      // Synthetic events have no active pointer to capture.
    }
    const { pt, tolerance } = transformPoint(e);
    transformTool.down(pt, tolerance);
    return true;
  }
  function handleTransformPointerMove(e: PointerEvent): boolean {
    if (!transformTool.active || !canvasEl) return false;
    const { pt, tolerance } = transformPoint(e);
    if (e.buttons & 1) transformTool.move(pt, e);
    else transformCursor = transformTool.cursor(transformTool.hit(pt, tolerance));
    return true;
  }
  function handleTransformPointerUp(): boolean {
    if (!transformTool.active) return false;
    transformTool.up();
    return true;
  }
  let paintError = $state<string | null>(null);
  let selectionDraft = $state.raw<ImagePoint[] | null>(null);
  let selectionError = $state<string | null>(null);
  let activeCropRatio = $state<number | null>(null);

  // AI state
  let inpaintPrompt = $state('');
  let inpaintMaskMode = $state<'annotations' | 'crop'>('annotations');
  let isRemovingBg = $state(false);
  let isInpainting = $state(false);
  let aiError = $state<string | null>(null);
  let aiSuccess = $state<string | null>(null);
  /** Where AI results go: by layer count (auto), a new layer / mask, or replacing the Background. */
  let aiTarget = $state<'auto' | 'new-layer' | 'replace'>('auto');
  const aiOptions = $derived(aiTarget === 'auto' ? {} : { target: aiTarget });

  const effectiveOnInpaint = $derived(onInpaint || aiHooks?.onInpaint);
  const effectiveOnRemoveBg = $derived(onRemoveBackground || aiHooks?.onRemoveBackground);

  async function handleRemoveBackground() {
    if (!effectiveOnRemoveBg) {
      aiError = 'No background removal hook is configured.';
      return;
    }
    aiError = null;
    aiSuccess = null;
    isRemovingBg = true;
    try {
      // AI hooks work in natural pixels (no crop or rotation): the source when the result replaces
      // it, the composite of the layers when the result becomes a layer or mask.
      const imageDataUrl = await editor.controller.toAIInputDataURL(aiOptions);
      const result = await effectiveOnRemoveBg({ imageDataUrl });
      if (typeof result === 'string') {
        await editor.applyBackgroundRemovedImage(result, aiOptions);
        aiSuccess = 'Background removed successfully!';
      } else {
        aiSuccess = 'Background removal complete.';
      }
    } catch (err: any) {
      aiError = err?.message || 'Failed to remove background.';
    } finally {
      isRemovingBg = false;
    }
  }

  async function handleInpaint() {
    if (!effectiveOnInpaint) {
      aiError = 'No inpainting hook is configured.';
      return;
    }
    if (!inpaintPrompt.trim()) {
      aiError = 'Please enter an inpainting prompt.';
      return;
    }
    aiError = null;
    aiSuccess = null;
    isInpainting = true;
    try {
      // Source image and mask share natural image space so they line up exactly.
      const imageDataUrl = await editor.controller.toAIInputDataURL(aiOptions);
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
        aiSuccess = 'Inpainting applied successfully!';
      } else {
        aiSuccess = 'Inpainting complete.';
      }
    } catch (err: any) {
      aiError = err?.message || 'Failed to apply inpainting.';
    } finally {
      isInpainting = false;
    }
  }

  // Annotation drafting state
  let activeColor = $state('#ef4444');
  let strokeWidth = $state(3);
  let fontSize = $state(24);
  let textInput = $state('');

  // Live draft and drag references
  let draftAnnotation = $state<Annotation | null>(null);
  let draftCrop = $state<CropBox | null>(null);
  let cropDragInfo: {
    handle: CropHandle | 'new';
    startCanvasPt: ImagePoint;
    startImgPt: ImagePoint;
    startCrop: CropBox;
  } | null = null;
  let annotationDragInfo: {
    annId: string;
    startImgPt: ImagePoint;
    initialAnn: Annotation;
  } | null = null;
  let isDrawing = false;
  let currentPath: ImagePoint[] = [];
  let dragStartPoint: ImagePoint | null = null;

  // Load the image when `src` changes. Only `src` is tracked: AI edits replace
  // the editor's source with a data URL and must not be reverted to `src`.
  let loadedSrc: string | undefined;
  $effect(() => {
    const next = src;
    if (!next || next === loadedSrc) return;
    loadedSrc = next;
    untrack(() => {
      if (next !== editor.state.sourceUrl) editor.loadImage(next);
    });
  });

  async function renderCanvas(overrideAnnotation?: Annotation | null, overrideCrop?: CropBox | null) {
    if (!canvasEl || !containerEl) return;
    const vpWidth = containerEl.clientWidth || 800;
    const vpHeight = containerEl.clientHeight || 500;

    await editor.controller.render(canvasEl, {
      viewportWidth: vpWidth,
      viewportHeight: vpHeight,
      fit,
      showCropOverlay: activeTab === 'crop',
      showSelectionOverlay: true,
      interactive: true,
      draftAnnotation: overrideAnnotation !== undefined ? overrideAnnotation : draftAnnotation,
      draftCrop: overrideCrop !== undefined ? overrideCrop : draftCrop,
      draftSelectionPath: selectionDraft,
      brushCursor:
        activeTab === 'paint' && brushCursor && editor.controller.getState().activeTool !== 'move' && !transformTool.active
          ? { ...brushCursor, diameter: editor.controller.getState().paint.brush.size }
          : null,
      freeTransform: transformTool.overlay(),
      textEdit: typeTool.session?.alive ? typeTool.session.overlay() : null,
    });
  }

  // Paint tools: pointer events (coalesced samples, pointer capture) into strokes and moves.
  function paintSamples(e: PointerEvent) {
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const list = events.length ? events : [e];
    const rect = canvasEl!.getBoundingClientRect();
    const sx = rect.width > 0 ? canvasEl!.width / rect.width : 1;
    const sy = rect.height > 0 ? canvasEl!.height / rect.height : 1;
    const s = editor.controller.getState();
    return list.map((ev) => ({
      ...canvasToImagePoint({ x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy }, s, canvasEl!.width, canvasEl!.height, false),
      pressure: pointerPressure(ev),
    }));
  }
  function handlePaintPointerDown(e: PointerEvent) {
    if (handleTransformPointerDown(e)) return;
    if (activeTab !== 'paint' || e.button !== 0 || !canvasEl) return;
    e.preventDefault();
    try {
      canvasEl.setPointerCapture?.(e.pointerId);
    } catch {
      // Synthetic events have no active pointer to capture.
    }
    paintError = paintGesture.down({ ...paintSamples(e)[0], altKey: e.altKey });
  }
  function handlePaintPointerMove(e: PointerEvent) {
    if (handleTransformPointerMove(e)) return;
    if (activeTab !== 'paint' || !canvasEl) return;
    const samples = paintSamples(e);
    brushCursor = samples[samples.length - 1] ?? null;
    if (paintGesture.active) paintGesture.moveTo(samples);
    else void renderCanvas();
  }
  function handlePaintPointerUp() {
    if (handleTransformPointerUp()) return;
    if (activeTab !== 'paint' || !paintGesture.active) return;
    paintGesture.up();
    if (paintGesture.error) paintError = paintGesture.error;
  }

  $effect(() => {
    if (activeTab !== 'paint' || typeof window === 'undefined') return;
    const c = editor.controller;
    const onKey = (e: KeyboardEvent) => {
      if (handlePaintShortcut(c, e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  $effect(() => {
    // Re-render when editor state or activeTab changes
    void editor.state;
    void activeTab;

    const raf = typeof requestAnimationFrame !== 'undefined'
      ? requestAnimationFrame
      : (cb: () => void) => setTimeout(cb, 0) as unknown as number;
    const caf = typeof cancelAnimationFrame !== 'undefined'
      ? cancelAnimationFrame
      : (id: number) => clearTimeout(id);

    const animId = raf(() => {
      renderCanvas();
    });
    return () => caf(animId);
  });

  $effect(() => {
    if (activeTab === 'crop' && editor.state.activeTool !== 'crop') {
      editor.setTool('crop');
    }
  });

  $effect(() => {
    if (!containerEl) return;
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        renderCanvas();
      });
      observer.observe(containerEl);
      return () => observer.disconnect();
    } else {
      const handleResize = () => renderCanvas();
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    }
  });

  function getCanvasEventPoint(e: MouseEvent): ImagePoint {
    if (!canvasEl) return { x: 0, y: 0 };
    const rect = canvasEl.getBoundingClientRect();
    const scaleX = rect.width > 0 ? canvasEl.width / rect.width : 1;
    const scaleY = rect.height > 0 ? canvasEl.height / rect.height : 1;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  function handleMouseDown(e: MouseEvent) {
    if (!canvasEl || transformTool.active) return;
    const canvasPt = getCanvasEventPoint(e);

    if (activeTab === 'select') {
      const gesture = selectionGesture;
      const imgPt = canvasToImagePoint(canvasPt, editor.state, canvasEl.width, canvasEl.height, false);
      void gesture.begin(imgPt, e).then(() => (selectionError = gesture.error));
      return;
    }

    if (activeTab === 'crop') {
      const activeCrop = draftCrop || editor.state.crop || {
        x: 0,
        y: 0,
        width: editor.state.imageDimensions.width,
        height: editor.state.imageDimensions.height,
      };
      const handle = hitTestCrop(canvasPt, editor.state, canvasEl.width, canvasEl.height, 14, activeCrop);
      const startImgPt = canvasToImagePoint(canvasPt, editor.state, canvasEl.width, canvasEl.height, true);

      if (handle) {
        cropDragInfo = {
          handle,
          startCanvasPt: canvasPt,
          startImgPt,
          startCrop: activeCrop,
        };
      } else {
        // Clicked outside crop box: start new crop selection
        cropDragInfo = {
          handle: 'new',
          startCanvasPt: canvasPt,
          startImgPt,
          startCrop: { x: startImgPt.x, y: startImgPt.y, width: 0, height: 0 },
        };
      }
      return;
    }

    if (activeTab === 'annotate' && (editor.state.activeTool === 'shape' || editor.state.activeTool === 'type')) {
      const imgPt = canvasToImagePoint(canvasPt, editor.state, canvasEl.width, canvasEl.height, false);
      shapeTypeError = null;
      if (editor.state.activeTool === 'shape') shapeGesture.down(imgPt);
      else {
        typeTool.down(imgPt, { shift: e.shiftKey });
        typeSession = typeTool.session;
        void renderCanvas();
      }
      return;
    }

    if (activeTab === 'annotate') {
      const imgPt = canvasToImagePoint(canvasPt, editor.state, canvasEl.width, canvasEl.height, false);
      dragStartPoint = imgPt;

      if (editor.state.activeTool === 'select') {
        for (let i = editor.state.annotations.length - 1; i >= 0; i--) {
          const ann = editor.state.annotations[i];
          if (hitTestAnnotation(imgPt, ann)) {
            editor.selectAnnotation(ann.id);
            annotationDragInfo = {
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

      if (editor.state.activeTool === 'pen') {
        isDrawing = true;
        currentPath = [imgPt];
        const draft: Annotation = {
          id: 'draft',
          type: 'pen',
          x: 0,
          y: 0,
          points: [imgPt],
          strokeColor: activeColor,
          strokeWidth,
        };
        draftAnnotation = draft;
        renderCanvas(draft);
      }
    }
  }

  function handleMouseMove(e: MouseEvent) {
    if (!canvasEl || transformTool.active) return;
    const canvasPt = getCanvasEventPoint(e);

    if (activeTab === 'select') {
      const gesture = selectionGesture;
      if (gesture.active && gesture.move(canvasToImagePoint(canvasPt, editor.state, canvasEl.width, canvasEl.height, false))) {
        selectionDraft = gesture.draftPath;
        renderCanvas();
      }
      return;
    }

    if (activeTab === 'crop') {
      if (cropDragInfo) {
        const currentImgPt = canvasToImagePoint(canvasPt, editor.state, canvasEl.width, canvasEl.height, true);
        let newCrop: CropBox;

        if (cropDragInfo.handle === 'new') {
          const minX = Math.max(0, Math.min(cropDragInfo.startImgPt.x, currentImgPt.x));
          const minY = Math.max(0, Math.min(cropDragInfo.startImgPt.y, currentImgPt.y));
          const maxX = Math.min(editor.state.imageDimensions.width, Math.max(cropDragInfo.startImgPt.x, currentImgPt.x));
          const maxY = Math.min(editor.state.imageDimensions.height, Math.max(cropDragInfo.startImgPt.y, currentImgPt.y));
          newCrop = {
            x: Math.round(minX),
            y: Math.round(minY),
            width: Math.round(Math.max(20, maxX - minX)),
            height: Math.round(Math.max(20, maxY - minY)),
          };
        } else {
          newCrop = calculateCropDrag(
            cropDragInfo.startCrop,
            cropDragInfo.handle,
            cropDragInfo.startImgPt,
            currentImgPt,
            editor.state.imageDimensions.width,
            editor.state.imageDimensions.height,
            activeCropRatio,
            editor.state.transform
          );
        }

        draftCrop = newCrop;
        renderCanvas(null, newCrop);
      } else {
        const activeCrop = draftCrop || editor.state.crop || {
          x: 0,
          y: 0,
          width: editor.state.imageDimensions.width,
          height: editor.state.imageDimensions.height,
        };
        const handle = hitTestCrop(canvasPt, editor.state, canvasEl.width, canvasEl.height, 14, activeCrop);
        canvasEl.style.cursor = getCropCursor(handle, editor.state.transform);
      }
      return;
    }

    if (activeTab === 'annotate' && editor.state.activeTool === 'shape') {
      if (shapeGesture.active) {
        shapeGesture.move(canvasToImagePoint(canvasPt, editor.state, canvasEl.width, canvasEl.height, false), { shift: e.shiftKey, alt: e.altKey });
        if (shapeGesture.error) shapeTypeError = shapeGesture.error;
      }
      return;
    }

    if (activeTab === 'annotate') {
      if (annotationDragInfo) {
        const currentImgPt = canvasToImagePoint(canvasPt, editor.state, canvasEl.width, canvasEl.height, false);
        const dx = currentImgPt.x - annotationDragInfo.startImgPt.x;
        const dy = currentImgPt.y - annotationDragInfo.startImgPt.y;
        editor.updateAnnotation(annotationDragInfo.annId, {
          x: Math.round(annotationDragInfo.initialAnn.x + dx),
          y: Math.round(annotationDragInfo.initialAnn.y + dy),
        });
        return;
      }

      if (!dragStartPoint) {
        if (editor.state.activeTool === 'select') {
          const imgPt = canvasToImagePoint(canvasPt, editor.state, canvasEl.width, canvasEl.height, false);
          let hovered = false;
          for (let i = editor.state.annotations.length - 1; i >= 0; i--) {
            if (hitTestAnnotation(imgPt, editor.state.annotations[i])) {
              hovered = true;
              break;
            }
          }
          canvasEl.style.cursor = hovered ? 'move' : 'default';
        } else {
          canvasEl.style.cursor = 'crosshair';
        }
        return;
      }

      const currentImgPt = canvasToImagePoint(canvasPt, editor.state, canvasEl.width, canvasEl.height, false);

      if (editor.state.activeTool === 'pen' && isDrawing) {
        currentPath.push(currentImgPt);
        const draft: Annotation = {
          id: 'draft',
          type: 'pen',
          x: 0,
          y: 0,
          points: [...currentPath],
          strokeColor: activeColor,
          strokeWidth,
        };
        draftAnnotation = draft;
        renderCanvas(draft);
      } else if (editor.state.activeTool === 'rect') {
        const w = currentImgPt.x - dragStartPoint.x;
        const h = currentImgPt.y - dragStartPoint.y;
        const draft: Annotation = {
          id: 'draft',
          type: 'rect',
          x: Math.min(dragStartPoint.x, currentImgPt.x),
          y: Math.min(dragStartPoint.y, currentImgPt.y),
          width: Math.abs(w),
          height: Math.abs(h),
          strokeColor: activeColor,
          strokeWidth,
        };
        draftAnnotation = draft;
        renderCanvas(draft);
      } else if (editor.state.activeTool === 'circle') {
        const rx = Math.abs(currentImgPt.x - dragStartPoint.x) / 2;
        const ry = Math.abs(currentImgPt.y - dragStartPoint.y) / 2;
        const draft: Annotation = {
          id: 'draft',
          type: 'circle',
          x: Math.min(dragStartPoint.x, currentImgPt.x) + rx,
          y: Math.min(dragStartPoint.y, currentImgPt.y) + ry,
          radiusX: rx,
          radiusY: ry,
          strokeColor: activeColor,
          strokeWidth,
        };
        draftAnnotation = draft;
        renderCanvas(draft);
      } else if (editor.state.activeTool === 'arrow') {
        const draft: Annotation = {
          id: 'draft',
          type: 'arrow',
          x: dragStartPoint.x,
          y: dragStartPoint.y,
          endX: currentImgPt.x,
          endY: currentImgPt.y,
          strokeColor: activeColor,
          strokeWidth,
        };
        draftAnnotation = draft;
        renderCanvas(draft);
      } else if (editor.state.activeTool === 'line') {
        const draft: Annotation = {
          id: 'draft',
          type: 'line',
          x: dragStartPoint.x,
          y: dragStartPoint.y,
          endX: currentImgPt.x,
          endY: currentImgPt.y,
          strokeColor: activeColor,
          strokeWidth,
        };
        draftAnnotation = draft;
        renderCanvas(draft);
      }
    }
  }

  function handleMouseUp(e: MouseEvent) {
    if (!canvasEl || transformTool.active) return;
    const canvasPt = getCanvasEventPoint(e);

    if (activeTab === 'select') {
      const gesture = selectionGesture;
      if (gesture.active) {
        gesture.end(canvasToImagePoint(canvasPt, editor.state, canvasEl.width, canvasEl.height, false), e);
        selectionDraft = null;
        renderCanvas();
      }
      return;
    }

    if (activeTab === 'crop') {
      if (cropDragInfo) {
        if (draftCrop && draftCrop.width >= 20 && draftCrop.height >= 20) {
          editor.setCrop(draftCrop, true);
        }
        cropDragInfo = null;
        draftCrop = null;
        renderCanvas();
      }
      return;
    }

    if (activeTab === 'annotate' && editor.state.activeTool === 'shape') {
      shapeGesture.up();
      return;
    }
    if (activeTab === 'annotate' && editor.state.activeTool === 'type') {
      typeTool.up(canvasToImagePoint(canvasPt, editor.state, canvasEl.width, canvasEl.height, false));
      typeSession = typeTool.session;
      if (typeTool.error) shapeTypeError = typeTool.error;
      void renderCanvas();
      // Keystrokes go to the hidden textarea while text is being edited.
      if (typeTool.session) setTimeout(() => typeInputEl?.focus(), 0);
      return;
    }

    if (activeTab === 'annotate') {
      if (annotationDragInfo) {
        annotationDragInfo = null;
        return;
      }

      if (dragStartPoint) {
        const currentImgPt = canvasToImagePoint(canvasPt, editor.state, canvasEl.width, canvasEl.height, false);

        if (editor.state.activeTool === 'pen' && isDrawing) {
          if (currentPath.length > 1) {
            editor.addAnnotation({
              type: 'pen',
              x: 0,
              y: 0,
              points: [...currentPath],
              strokeColor: activeColor,
              strokeWidth,
            });
          }
          isDrawing = false;
          currentPath = [];
        } else if (editor.state.activeTool === 'rect') {
          const w = Math.abs(currentImgPt.x - dragStartPoint.x);
          const h = Math.abs(currentImgPt.y - dragStartPoint.y);
          if (w > 4 && h > 4) {
            editor.addAnnotation({
              type: 'rect',
              x: Math.min(dragStartPoint.x, currentImgPt.x),
              y: Math.min(dragStartPoint.y, currentImgPt.y),
              width: w,
              height: h,
              strokeColor: activeColor,
              strokeWidth,
            });
          }
        } else if (editor.state.activeTool === 'circle') {
          const rx = Math.abs(currentImgPt.x - dragStartPoint.x) / 2;
          const ry = Math.abs(currentImgPt.y - dragStartPoint.y) / 2;
          if (rx > 4 && ry > 4) {
            editor.addAnnotation({
              type: 'circle',
              x: Math.min(dragStartPoint.x, currentImgPt.x) + rx,
              y: Math.min(dragStartPoint.y, currentImgPt.y) + ry,
              radiusX: rx,
              radiusY: ry,
              strokeColor: activeColor,
              strokeWidth,
            });
          }
        } else if (editor.state.activeTool === 'arrow') {
          if (Math.hypot(currentImgPt.x - dragStartPoint.x, currentImgPt.y - dragStartPoint.y) > 4) {
            editor.addAnnotation({
              type: 'arrow',
              x: dragStartPoint.x,
              y: dragStartPoint.y,
              endX: currentImgPt.x,
              endY: currentImgPt.y,
              strokeColor: activeColor,
              strokeWidth,
            });
          }
        } else if (editor.state.activeTool === 'line') {
          if (Math.hypot(currentImgPt.x - dragStartPoint.x, currentImgPt.y - dragStartPoint.y) > 4) {
            editor.addAnnotation({
              type: 'line',
              x: dragStartPoint.x,
              y: dragStartPoint.y,
              endX: currentImgPt.x,
              endY: currentImgPt.y,
              strokeColor: activeColor,
              strokeWidth,
            });
          }
        }

        draftAnnotation = null;
        dragStartPoint = null;
        renderCanvas();
      }
    }
  }

  function handleAddText() {
    if (!textInput.trim()) return;
    editor.addAnnotation({
      type: 'text',
      x: 50,
      y: 50,
      text: textInput.trim(),
      fontSize,
      color: activeColor,
    });
    textInput = '';
  }

  async function handleExport() {
    const dataUrl = await editor.toDataURL(exportOptions);
    if (onSave) {
      onSave(dataUrl);
    } else {
      const link = document.createElement('a');
      link.download = `edited-image-${Date.now()}.png`;
      link.href = dataUrl;
      link.click();
    }
  }
</script>

<div
  class="flex flex-col bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl text-slate-100 {className}"
  {style}
>
  <!-- Top Action Header -->
  <div class="flex flex-wrap items-center justify-between px-4 py-3 bg-slate-950/80 border-b border-slate-800 gap-3">
    <!-- Navigation Tabs -->
    <div class="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800 text-xs">
      <button
        type="button"
        onclick={() => {
          activeTab = 'crop';
          editor.setTool('crop');
        }}
        class="px-3 py-1.5 rounded-md font-medium transition-colors {activeTab === 'crop'
          ? 'bg-indigo-600 text-white shadow'
          : 'text-slate-400 hover:text-slate-200'}"
      >
        Transform & Crop
      </button>
      <button
        type="button"
        onclick={() => {
          activeTab = 'adjust';
          editor.setTool('select');
        }}
        class="px-3 py-1.5 rounded-md font-medium transition-colors {activeTab === 'adjust'
          ? 'bg-indigo-600 text-white shadow'
          : 'text-slate-400 hover:text-slate-200'}"
      >
        Adjustments
      </button>
      <button
        type="button"
        onclick={() => {
          activeTab = 'layers';
          editor.setTool('select');
        }}
        class="px-3 py-1.5 rounded-md font-medium transition-colors {activeTab === 'layers'
          ? 'bg-indigo-600 text-white shadow'
          : 'text-slate-400 hover:text-slate-200'}"
      >
        Layers
      </button>
      <button
        type="button"
        onclick={() => {
          activeTab = 'paint';
          editor.setTool('brush');
        }}
        class="px-3 py-1.5 rounded-md font-medium transition-colors {activeTab === 'paint'
          ? 'bg-indigo-600 text-white shadow'
          : 'text-slate-400 hover:text-slate-200'}"
      >
        Paint
      </button>
      <button
        type="button"
        onclick={() => {
          activeTab = 'select';
          editor.setTool('select');
        }}
        class="px-3 py-1.5 rounded-md font-medium transition-colors {activeTab === 'select'
          ? 'bg-indigo-600 text-white shadow'
          : 'text-slate-400 hover:text-slate-200'}"
      >
        Select & Mask
      </button>
      <button
        type="button"
        onclick={() => {
          activeTab = 'annotate';
          editor.setTool('pen');
        }}
        class="px-3 py-1.5 rounded-md font-medium transition-colors {activeTab === 'annotate'
          ? 'bg-indigo-600 text-white shadow'
          : 'text-slate-400 hover:text-slate-200'}"
      >
        Annotations
      </button>
      <button
        type="button"
        onclick={() => {
          activeTab = 'depth';
          editor.setTool('select');
        }}
        class="px-3 py-1.5 rounded-md font-medium transition-colors {activeTab === 'depth'
          ? 'bg-indigo-600 text-white shadow'
          : 'text-slate-400 hover:text-slate-200'}"
      >
        Depth Mask
      </button>
      <button
        type="button"
        onclick={() => {
          activeTab = 'ai';
          editor.setTool('select');
        }}
        class="px-3 py-1.5 rounded-md font-medium transition-colors flex items-center gap-1.5 {activeTab === 'ai'
          ? 'bg-indigo-600 text-white shadow'
          : 'text-slate-400 hover:text-slate-200'}"
      >
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
        </svg>
        AI Tools
      </button>
    </div>

    <!-- Global Action Tools (Undo/Redo, Zoom, Compare, Save) -->
    <div class="flex items-center gap-2 text-xs">
      <button
        type="button"
        disabled={!editor.canUndo}
        onclick={() => editor.undo()}
        class="p-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-800"
        title="Undo"
      >
        ↩
      </button>
      <button
        type="button"
        disabled={!editor.canRedo}
        onclick={() => editor.redo()}
        class="p-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-800"
        title="Redo"
      >
        ↪
      </button>
      <button
        type="button"
        onclick={() => editor.reset()}
        class="px-2 py-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200 hover:bg-slate-800"
      >
        Reset
      </button>

      <div class="h-4 w-px bg-slate-800 mx-1"></div>

      <!-- Zoom -->
      <button
        type="button"
        onclick={() => editor.zoomOut()}
        class="p-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800"
        title="Zoom Out"
      >
        -
      </button>
      <span class="font-mono text-slate-400 w-10 text-center">{Math.round(editor.state.zoom * 100)}%</span>
      <button
        type="button"
        onclick={() => editor.zoomIn()}
        class="p-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800"
        title="Zoom In"
      >
        +
      </button>

      <div class="h-4 w-px bg-slate-800 mx-1"></div>

      <!-- Live Compare -->
      <button
        type="button"
        onmousedown={() => editor.setComparing(true)}
        onmouseup={() => editor.setComparing(false)}
        onmouseleave={() => editor.setComparing(false)}
        class="px-2.5 py-1.5 rounded-lg border border-slate-800 bg-slate-900 text-amber-400 hover:bg-slate-800 select-none active:bg-amber-950/40"
      >
        Hold Compare
      </button>

      <!-- Save / Export -->
      <button
        type="button"
        onclick={handleExport}
        class="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium shadow-md shadow-emerald-900/30 transition-colors"
      >
        Export Image
      </button>
    </div>
  </div>

  <!-- Main Viewport + Sidebar Layout -->
  <!-- Free Transform options bar (Ctrl/Cmd+T), above the viewport while a transform is open -->
  {#if transformActive}
    <FreeTransformOptionsBar tool={transformTool} class="border-b border-slate-800 bg-slate-900/95 px-4 py-2" />
  {:else if transformError}
    <div role="alert" class="border-b border-rose-900 bg-rose-950/80 px-4 py-1.5 text-xs text-rose-200">{transformError}</div>
  {/if}

  <div class="flex flex-col md:flex-row flex-1 min-h-[520px] md:h-[560px]">
    <!-- Canvas Area -->
    <div
      bind:this={containerEl}
      class="relative flex-1 h-[360px] md:h-full min-h-[320px] bg-slate-950 overflow-hidden select-none"
    >
      <canvas
        bind:this={canvasEl}
        onmousedown={handleMouseDown}
        onmousemove={handleMouseMove}
        onmouseup={handleMouseUp}
        onmouseleave={handleMouseUp}
        onpointerdown={handlePaintPointerDown}
        onpointermove={handlePaintPointerMove}
        onpointerup={handlePaintPointerUp}
        onpointercancel={() => paintGesture.cancel()}
        data-testid="image-editor-canvas"
        style={transformActive ? `cursor: ${transformCursor}` : undefined}
        class="absolute inset-0 w-full h-full block {transformActive ? 'touch-none' : activeTab === 'paint' ? 'touch-none cursor-crosshair' : activeTab === 'annotate' && editor.state.activeTool === 'type' ? 'cursor-text' : activeTab === 'annotate' && editor.state.activeTool === 'shape' ? 'cursor-crosshair' : ''}"
      ></canvas>
      {#if typeSession}
        <textarea
          bind:this={typeInputEl}
          aria-label="Edit text"
          data-testid="type-input"
          autocapitalize="off"
          spellcheck={false}
          onkeydown={handleTypeKeyDown}
          oninput={handleTypeInput}
          oncompositionend={handleTypeComposition}
          class="absolute left-0 top-0 h-px w-px opacity-0"
        ></textarea>
      {/if}

    </div>

    <!-- Tab Controls Sidebar -->
    <div class="w-full md:w-80 bg-slate-900/90 border-t md:border-t-0 md:border-l border-slate-800 p-4 overflow-y-auto h-auto md:h-full md:max-h-[560px]">
      <!-- TAB 1: CROP & TRANSFORM -->
      {#if activeTab === 'crop'}
        <div class="flex flex-col gap-4 text-xs">
          <span class="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">
            Aspect Ratio Presets
          </span>
          <div class="grid grid-cols-3 gap-2">
            <button
              type="button"
              onclick={() => {
                activeCropRatio = null;
                editor.applyCropPreset(null);
              }}
              class="px-2.5 py-2 rounded-lg border font-medium {activeCropRatio === null && editor.state.crop
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'}"
            >
              Freeform
            </button>
            <button
              type="button"
              onclick={() => {
                activeCropRatio = 1;
                editor.applyCropPreset(1);
              }}
              class="px-2.5 py-2 rounded-lg border font-medium {activeCropRatio === 1
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'}"
            >
              1:1 Square
            </button>
            <button
              type="button"
              onclick={() => {
                activeCropRatio = 4 / 3;
                editor.applyCropPreset(4 / 3);
              }}
              class="px-2.5 py-2 rounded-lg border font-medium {activeCropRatio === 4 / 3
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'}"
            >
              4:3 Standard
            </button>
            <button
              type="button"
              onclick={() => {
                activeCropRatio = 16 / 9;
                editor.applyCropPreset(16 / 9);
              }}
              class="px-2.5 py-2 rounded-lg border font-medium {activeCropRatio === 16 / 9
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'}"
            >
              16:9 Wide
            </button>
            <button
              type="button"
              onclick={() => {
                activeCropRatio = 3 / 2;
                editor.applyCropPreset(3 / 2);
              }}
              class="px-2.5 py-2 rounded-lg border font-medium {activeCropRatio === 3 / 2
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'}"
            >
              3:2 Photo
            </button>
            <button
              type="button"
              onclick={() => {
                activeCropRatio = null;
                editor.resetCrop();
              }}
              class="px-2.5 py-2 rounded-lg bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 border border-rose-800/40 font-medium"
            >
              Clear Crop
            </button>
          </div>

          <div class="h-px bg-slate-800 my-1"></div>

          <span class="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">
            Orientation & Flips
          </span>
          <div class="grid grid-cols-2 gap-2">
            <button
              type="button"
              onclick={() => editor.rotate(-90)}
              class="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
            >
              Rotate -90°
            </button>
            <button
              type="button"
              onclick={() => editor.rotate(90)}
              class="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
            >
              Rotate +90°
            </button>
            <button
              type="button"
              onclick={() => editor.flipHorizontal()}
              class="px-3 py-2 rounded-lg border transition-colors {editor.state.transform.flipH
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'}"
            >
              Flip Horizontal
            </button>
            <button
              type="button"
              onclick={() => editor.flipVertical()}
              class="px-3 py-2 rounded-lg border transition-colors {editor.state.transform.flipV
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'}"
            >
              Flip Vertical
            </button>
          </div>
        </div>
      {/if}

      <!-- TAB 2: ADJUSTMENTS -->
      {#if activeTab === 'adjust'}
        <div class="flex flex-col gap-3 text-xs">
          <div class="flex items-center justify-between">
            <span class="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">
              Color Adjustments
            </span>
            <button
              type="button"
              onclick={() => editor.resetAdjustments()}
              class="text-[10px] text-rose-400 hover:underline"
            >
              Reset Sliders
            </button>
          </div>

          <Histogram histogram={editor.histogram} />

          {#each IMAGE_ADJUSTMENT_CONTROLS as spec (spec.id)}
            <ControlSlider
              {spec}
              value={readAdjustmentControls(editor.state.adjustments)[spec.id]}
              disabled={spec.requiresProcess !== undefined && legacyProcess}
              onchange={(v) => editor.setAdjustments({ [spec.id]: v })}
            />
            {#if spec.id === 'tint' && legacyProcess}
              <div
                class="flex items-center justify-between gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-200"
                data-testid="image-editor-process-notice"
              >
                <span>Legacy rendering (process 1). Tint needs the current process.</span>
                <button
                  type="button"
                  onclick={() => editor.upgradeProcess()}
                  class="shrink-0 rounded bg-amber-500/20 px-2 py-0.5 hover:bg-amber-500/30"
                >
                  Update
                </button>
              </div>
            {/if}
          {/each}

          <div class="border-t border-slate-700/60 pt-3">
            <AdjustmentLayersPanel
              controller={editor.controller}
              layers={editor.state.adjustments.layers}
              histogram={editor.histogram}
            />
          </div>
        </div>
      {/if}

      <!-- TAB 3: ANNOTATIONS -->
      {#if activeTab === 'layers'}
        <div class="flex flex-col gap-3 text-xs">
          <span class="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">Layers</span>
          <button
            type="button"
            title="Edit › Free Transform (Ctrl/Cmd+T): the selected pixels, or the whole active layer"
            class="px-2 py-1 rounded text-[11px] bg-slate-800 text-slate-300 hover:text-white self-start disabled:opacity-40"
            disabled={transformActive}
            onclick={() => transformTool.begin()}>Free Transform</button>
          <LayersPanel controller={editor.controller} />
        </div>
      {/if}

      {#if activeTab === 'paint'}
        <div class="flex flex-col gap-3 text-xs">
          <span class="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">Paint</span>
          <BrushOptionsBar controller={editor.controller} />
          <button
            type="button"
            title="Edit › Free Transform (Ctrl/Cmd+T): the selected pixels, or the whole active layer"
            class="px-2 py-1 rounded text-[11px] bg-slate-800 text-slate-300 hover:text-white self-start disabled:opacity-40"
            disabled={transformActive}
            onclick={() => transformTool.begin()}>Free Transform</button>
          {#if paintError}
            <p role="alert" class="text-rose-400" data-testid="paint-error">{paintError}</p>
          {/if}
          <div class="border-t border-slate-700/60 pt-3">
            <LayersPanel controller={editor.controller} />
          </div>
        </div>
      {/if}

      {#if activeTab === 'annotate'}
        <div class="flex flex-col gap-3 text-xs">
          <span class="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">Shape & Type Layers</span>
          <div class="grid grid-cols-2 gap-1.5">
            {#each ['shape', 'type'] as const as t (t)}
              <button
                type="button"
                aria-pressed={editor.state.activeTool === t}
                onclick={() => editor.setTool(t)}
                class="py-1.5 px-2 rounded-lg font-medium border transition-colors {editor.state.activeTool === t
                  ? 'bg-indigo-600 border-indigo-500 text-white'
                  : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'}">{t === 'shape' ? 'Shape' : 'Type'}</button>
            {/each}
          </div>
          {#if editor.state.activeTool === 'shape'}
            <ShapeOptionsBar controller={editor.controller} options={shapeOptions} onchange={(o) => (shapeOptions = o)} />
          {/if}
          {#if editor.state.activeTool === 'type'}
            <TypeOptionsBar controller={editor.controller} options={typeOptions} onchange={(o) => (typeOptions = o)} session={typeSession} />
            {#if typeSession}
              <button type="button" onclick={finishTyping} class="self-start rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700">Done editing text</button>
            {/if}
          {/if}
          {#if shapeTypeError}
            <p role="alert" class="text-rose-400" data-testid="shape-type-error">{shapeTypeError}</p>
          {/if}
          <div class="h-px bg-slate-800 my-1"></div>

          <span class="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">
            Draw & Annotate
          </span>

          <!-- Tool Picker -->
          <div class="grid grid-cols-3 gap-1.5">
            {#each (['pen', 'rect', 'circle', 'arrow', 'line'] as ImageEditorTool[]) as t}
              <button
                type="button"
                onclick={() => editor.setTool(t)}
                class="py-1.5 px-2 rounded-lg font-medium capitalize border transition-colors {editor.state.activeTool === t
                  ? 'bg-indigo-600 border-indigo-500 text-white'
                  : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'}"
              >
                {t}
              </button>
            {/each}
          </div>

          <!-- Color & Size -->
          <div class="flex items-center gap-2 mt-2">
            <span class="text-slate-400">Color:</span>
            <input
              type="color"
              bind:value={activeColor}
              class="w-8 h-8 rounded border border-slate-700 cursor-pointer bg-transparent"
            />
            <div class="flex-1 ml-2">
              <div class="flex justify-between text-slate-400 mb-0.5">
                <span>Width:</span>
                <span class="font-mono">{strokeWidth}px</span>
              </div>
              <input
                type="range"
                min="1"
                max="20"
                bind:value={strokeWidth}
                class="w-full accent-indigo-500"
              />
            </div>
          </div>

          <div class="h-px bg-slate-800 my-1"></div>

          <!-- Text Tool -->
          <span class="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">Add Text</span>
          <div class="flex gap-2">
            <input
              type="text"
              placeholder="Type watermark or label..."
              bind:value={textInput}
              onkeydown={(e) => e.key === 'Enter' && handleAddText()}
              class="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            />
            <button
              type="button"
              onclick={handleAddText}
              class="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium shadow"
            >
              Add
            </button>
          </div>
          <div class="flex items-center justify-between text-slate-400">
            <span>Font Size:</span>
            <span class="font-mono">{fontSize}px</span>
          </div>
          <input
            type="range"
            min="12"
            max="72"
            bind:value={fontSize}
            class="w-full accent-indigo-500"
          />

          <!-- Layers & Selected Annotation -->
          <div class="h-px bg-slate-800 my-1"></div>
          <div class="flex items-center justify-between">
            <span class="text-slate-400">Layers ({editor.state.annotations.length})</span>
            {#if editor.state.selectedAnnotationId}
              <button
                type="button"
                onclick={() => editor.removeAnnotation(editor.state.selectedAnnotationId!)}
                class="text-rose-400 hover:underline text-[11px]"
              >
                Delete Selected
              </button>
            {/if}
            {#if editor.state.annotations.length > 0}
              <button
                type="button"
                onclick={() => editor.clearAnnotations()}
                class="text-slate-400 hover:text-slate-200 text-[11px]"
              >
                Clear All
              </button>
            {/if}
          </div>
        </div>
      {/if}

      <!-- TAB 4: GLEAMFORGE DEPTH MASKING -->
      {#if activeTab === 'depth'}
        <div class="flex flex-col gap-3 text-xs">
          <div class="flex items-center justify-between">
            <span class="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">
              Depth Masking
            </span>
            <button
              type="button"
              onclick={() => editor.resetDepthMask()}
              class="text-[10px] text-rose-400 hover:underline"
            >
              Reset Mask
            </button>
          </div>

          <label class="flex items-center gap-2 cursor-pointer text-slate-300">
            <input
              type="checkbox"
              checked={editor.state.depthMask.enabled}
              onchange={(e) => editor.setDepthMask({ enabled: (e.target as HTMLInputElement).checked })}
              class="rounded accent-indigo-500"
            />
            <span>Enable Depth / Alpha Mask</span>
          </label>

          {#if editor.state.depthMask.enabled}
            <div>
              <span class="text-slate-400 block mb-1">Mask Image URL:</span>
              <input
                type="text"
                placeholder="https://.../depthmap.png"
                value={editor.state.depthMask.maskSource || ''}
                oninput={(e) => editor.setDepthMask({ maskSource: (e.target as HTMLInputElement).value || null })}
                class="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500"
              />
            </div>

            <div class="flex gap-2">
              <button
                type="button"
                onclick={() => editor.setDepthMask({ mode: 'threshold' })}
                class="flex-1 py-1.5 rounded-lg border text-xs font-medium {editor.state.depthMask.mode === 'threshold'
                  ? 'bg-indigo-600 border-indigo-500 text-white'
                  : 'bg-slate-800 border-slate-700 text-slate-300'}"
              >
                Threshold Mode
              </button>
              <button
                type="button"
                onclick={() => editor.setDepthMask({ mode: 'brightness' })}
                class="flex-1 py-1.5 rounded-lg border text-xs font-medium {editor.state.depthMask.mode === 'brightness'
                  ? 'bg-indigo-600 border-indigo-500 text-white'
                  : 'bg-slate-800 border-slate-700 text-slate-300'}"
              >
                Brightness Mode
              </button>
            </div>

            <div>
              <div class="flex justify-between text-slate-400 mb-1">
                <span>Depth Start (Lower):</span>
                <span class="font-mono">{editor.state.depthMask.depthRange[0]}</span>
              </div>
              <input
                type="range"
                min="0"
                max="255"
                value={editor.state.depthMask.depthRange[0]}
                oninput={(e) =>
                  editor.setDepthMask({
                    depthRange: [Number((e.target as HTMLInputElement).value), editor.state.depthMask.depthRange[1]],
                  })}
                class="w-full accent-indigo-500"
              />
            </div>

            <div>
              <div class="flex justify-between text-slate-400 mb-1">
                <span>Depth Stop (Upper):</span>
                <span class="font-mono">{editor.state.depthMask.depthRange[1]}</span>
              </div>
              <input
                type="range"
                min="0"
                max="255"
                value={editor.state.depthMask.depthRange[1]}
                oninput={(e) =>
                  editor.setDepthMask({
                    depthRange: [editor.state.depthMask.depthRange[0], Number((e.target as HTMLInputElement).value)],
                  })}
                class="w-full accent-indigo-500"
              />
            </div>

            <div>
              <div class="flex justify-between text-slate-400 mb-1">
                <span>Softness:</span>
                <span class="font-mono">{editor.state.depthMask.softness}</span>
              </div>
              <input
                type="range"
                min="1"
                max="50"
                value={editor.state.depthMask.softness}
                oninput={(e) => editor.setDepthMask({ softness: Number((e.target as HTMLInputElement).value) })}
                class="w-full accent-indigo-500"
              />
            </div>

            <label class="flex items-center gap-2 cursor-pointer text-slate-300 mt-1">
              <input
                type="checkbox"
                checked={editor.state.depthMask.invert}
                onchange={(e) => editor.setDepthMask({ invert: (e.target as HTMLInputElement).checked })}
                class="rounded accent-indigo-500"
              />
              <span>Invert Mask</span>
            </label>
          {/if}
        </div>
      {/if}

      <!-- SELECT & MASK: selection tools, refine edge, layer masks -->
      {#if activeTab === 'select'}
        <div class="flex flex-col gap-4 text-xs">
          <SelectionOptionsBar
            controller={editor.controller}
            options={selectionOptions}
            onOptionsChange={(next) => (selectionOptions = next)}
            selection={editor.state.selection ?? null}
            quickMask={Boolean(editor.state.quickMask)}
          />
          {#if selectionError}
            <p role="alert" class="text-rose-400">{selectionError}</p>
          {/if}
          <div class="flex gap-1">
            <button
            type="button"
            title="Select › Transform Selection: the outline only"
            class="px-2 py-1 rounded text-[11px] bg-slate-800 text-slate-300 hover:text-white self-start disabled:opacity-40"
            disabled={transformActive}
            onclick={() => transformTool.begin({ content: 'selection-outline' })}>Transform Selection</button>
            <button
            type="button"
            title="Edit › Free Transform: the selected pixels of the active layer"
            class="px-2 py-1 rounded text-[11px] bg-slate-800 text-slate-300 hover:text-white self-start disabled:opacity-40"
            disabled={transformActive}
            onclick={() => transformTool.begin({ content: 'selection' })}>Free Transform Pixels</button>
          </div>
          <RefineEdgePanel
            controller={editor.controller}
            selection={editor.state.selection ?? null}
            layers={editor.state.adjustments.layers}
          />
        </div>
      {/if}

      <!-- TAB 5: AI TOOLS / INPAINTING & BACKGROUND REMOVAL -->
      {#if activeTab === 'ai'}
        <div class="flex flex-col gap-4 text-xs">
          <label class="flex items-center justify-between gap-2 text-slate-300">
            <span>Results go to</span>
            <select
              aria-label="AI result target"
              bind:value={aiTarget}
              class="bg-slate-800 border border-slate-700 rounded px-1.5 py-1"
            >
              <option value="auto">{editor.controller.isMultiLayer ? 'Auto (new layer)' : 'Auto (replace image)'}</option>
              <option value="new-layer">New layer / mask</option>
              <option value="replace">Replace image</option>
            </select>
          </label>
          <!-- Background Removal Section -->
          <div class="p-3 rounded-lg bg-slate-950/60 border border-slate-800 flex flex-col gap-2.5">
            <div class="flex items-center justify-between">
              <span class="font-semibold text-slate-200 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                <svg class="w-3.5 h-3.5 text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/>
                </svg>
                Background Removal
              </span>
              {#if isRemovingBg}
                <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-900/60 text-indigo-300 animate-pulse">
                  Removing...
                </span>
              {/if}
            </div>

            <p class="text-slate-400 text-[11px] leading-relaxed">
              Isolate foreground subject with AI alpha transparency segmentation.
            </p>

            <button
              type="button"
              onclick={handleRemoveBackground}
              disabled={isRemovingBg || isInpainting}
              class="mt-1 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium shadow transition-colors flex items-center justify-center gap-2"
            >
              {#if isRemovingBg}
                <div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                Removing Background...
              {:else}
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg>
                Remove Background
              {/if}
            </button>
          </div>

          <!-- AI Inpainting / Generative Fill Section -->
          <div class="p-3 rounded-lg bg-slate-950/60 border border-slate-800 flex flex-col gap-2.5">
            <div class="flex items-center justify-between">
              <span class="font-semibold text-slate-200 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                <svg class="w-3.5 h-3.5 text-purple-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="m21.64 3.64-1.28-1.28a1.2 1.2 0 0 0-1.7 0l-9.72 9.72-1.94 4.86 4.86-1.94 9.72-9.72a1.2 1.2 0 0 0 .06-1.64z"/>
                  <path d="m14 7 3 3"/>
                </svg>
                Generative Inpainting
              </span>
              {#if isInpainting}
                <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-900/60 text-purple-300 animate-pulse">
                  Inpainting...
                </span>
              {/if}
            </div>

            <p class="text-slate-400 text-[11px] leading-relaxed">
              Replace, modify, or fill selected regions using prompt-guided generative inpainting.
            </p>

            <div class="flex flex-col gap-1">
              <label for="ai-inpaint-prompt" class="text-slate-300 text-[11px] font-medium">Prompt</label>
              <textarea
                id="ai-inpaint-prompt"
                bind:value={inpaintPrompt}
                placeholder="e.g. replace sunglasses with steampunk goggles, remove person in background..."
                rows="3"
                class="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 resize-none"
              ></textarea>
            </div>

            <div class="flex flex-col gap-1">
              <span class="text-slate-300 text-[11px] font-medium">Target Mask Region</span>
              <div class="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onclick={() => inpaintMaskMode = 'annotations'}
                  class="px-2 py-1.5 rounded border text-[11px] font-medium text-left transition-colors {inpaintMaskMode === 'annotations'
                    ? 'bg-purple-600/30 border-purple-500 text-purple-200'
                    : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'}"
                >
                  Drawn Shapes ({editor.state.annotations.length})
                </button>
                <button
                  type="button"
                  onclick={() => inpaintMaskMode = 'crop'}
                  class="px-2 py-1.5 rounded border text-[11px] font-medium text-left transition-colors {inpaintMaskMode === 'crop'
                    ? 'bg-purple-600/30 border-purple-500 text-purple-200'
                    : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'}"
                >
                  Crop Box ({editor.state.crop ? 'Selected' : 'Full'})
                </button>
              </div>
            </div>

            <button
              type="button"
              onclick={handleInpaint}
              disabled={isInpainting || isRemovingBg || !inpaintPrompt.trim()}
              class="mt-1 px-3 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-medium shadow transition-colors flex items-center justify-center gap-2"
            >
              {#if isInpainting}
                <div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                Generating Inpaint...
              {:else}
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg>
                Apply Inpainting
              {/if}
            </button>
          </div>

          {#if aiError}
            <div class="p-2.5 rounded-lg bg-rose-950/60 border border-rose-800 text-rose-300 text-[11px]">
              {aiError}
            </div>
          {/if}

          {#if aiSuccess}
            <div class="p-2.5 rounded-lg bg-emerald-950/60 border border-emerald-800 text-emerald-300 text-[11px]">
              {aiSuccess}
            </div>
          {/if}
        </div>
      {/if}

    </div>
  </div>
</div>
