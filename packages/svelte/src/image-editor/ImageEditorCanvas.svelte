<script lang="ts">
  import type { Annotation, CropBox, CropHandle, ImageEditorFit, ImagePoint } from '@pixerate/editor/image-editor';
  import type { AgentPlayback, PlaybackPoint, PlaybackRect, PlaybackRef } from '@pixerate/editor/tools';
  import {
    canvasToImagePoint,
    imageToCanvasPoint,
    createImagePlaybackLocator,
    agentDragDraft,
    hitTestCrop,
    getCropCursor,
    calculateCropDrag,
    hitTestAnnotation,
    DEFAULT_SELECTION_TOOL_OPTIONS,
    SelectionGesture,
    PaintGesture,
    handlePaintShortcut,
    pointerPressure,
    FreeTransformTool,
    boxFrameHit,
    quadFrameOverlay,
    TRANSFORM_ROTATE_HANDLE_OFFSET,
    getViewportProjection,
    measureCanvasViewport,
    watchCanvasViewport,
    startMarchingAnts,
    ShapeDrawGesture,
    TypeToolGesture,
    DEFAULT_SHAPE_TOOL_OPTIONS,
    DEFAULT_TYPE_TOOL_OPTIONS,
    type SelectionToolOptions,
    type ShapeToolOptions,
    type TextEditSession,
    type TransformOverlay,
    type TypeToolOptions,
  } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';
  import { trackPresenceDrag } from '@pixerate/editor/tools';
  import { createPlaybackSurface, getAgentPlayback } from '../playback/playback.svelte.js';
  import PresenceLayer from '../playback/PresenceLayer.svelte';
  import type { ReactiveImageEditor } from './imageEditorState.svelte.js';
  import type { ImageEditorCanvasErrorSource, ImageEditorCanvasMode } from './canvasTypes.js';

  interface Props {
    /** The editor to draw and edit (`createReactiveImageEditor`). */
    editor: ReactiveImageEditor;
    /**
     * What pointer gestures do: `crop` (crop box and its overlay, in the crop margin), `select`
     * (the selection tools), `paint` (brush, eraser, move and their shortcuts), `annotate`
     * (annotations, shape and type layers, by the active tool) or `none` (view only). Free
     * Transform works in every mode. Default `none`.
     */
    mode?: ImageEditorCanvasMode;
    /** How the image fits the canvas (default: the renderer's). */
    fit?: ImageEditorFit;
    /** Options of the selection tools (magic wand tolerance, feather, …). */
    selectionOptions?: SelectionToolOptions;
    /** Options of the shape tool. */
    shapeOptions?: ShapeToolOptions;
    /** Options of the type tool. */
    typeOptions?: TypeToolOptions;
    /** Colour of new annotations (default `#ef4444`). */
    annotationColor?: string;
    /** Stroke width of new annotations, in image pixels (default 3). */
    annotationWidth?: number;
    /** Aspect ratio a crop handle drag keeps (width / height), or null for free (default). */
    cropRatio?: number | null;
    /** A gesture failed (`message`) or recovered (`null`). */
    onerror?: (source: ImageEditorCanvasErrorSource, message: string | null) => void;
    /** The text being edited on the canvas (bindable). Set it to `null` to finish editing. */
    typeSession?: TextEditSession | null;
    /**
     * The Free Transform tool (Ctrl/Cmd+T) the canvas drives and draws. Pass your own to show its
     * options bar or begin transforms from your UI; by default the canvas makes one.
     */
    transformTool?: FreeTransformTool;
    /**
     * Agent playback: act out the image tools' calls on this canvas with the agent's cursor
     * (default: `setAgentPlayback` above; `null` turns it off).
     */
    playback?: AgentPlayback | null;
    /** The playback surface id (default `image`, where the image tool providers play). */
    playbackId?: string;
    /** Bring the canvas on screen (switch to its tab) before the agent acts. */
    onplaybackreveal?: () => void | Promise<void>;
    /**
     * Where the default playback lookups find the editor's chrome: tabs (`[data-image-tab]`),
     * sliders (`[data-control-id]`) and layer rows (`[data-layer-id]`). Default: the canvas itself.
     */
    chromeRoot?: () => HTMLElement | null | undefined;
    /** Your own lookup for a playback ref, in document pixels (tried first). */
    locate?: (ref: PlaybackRef) => PlaybackRect | null;
    /** Your own element for a playback ref, anywhere on the page; its box is mapped to document pixels. */
    locateElement?: (ref: PlaybackRef) => Element | null;
    /** Show a panel for an `open` step (default: click its `[data-image-tab]` or `[data-image-panel]` under `chromeRoot`). */
    open?: (ref: PlaybackRef) => void | Promise<void>;
    /** Whether wheel zoom and middle/space drag panning are enabled (default true). */
    viewportGestures?: boolean;
    /**
     * Pan mode (a host's hand tool): a primary drag pans the view in every mode, as holding Space
     * does, and the canvas's own gestures pause. Needs `viewportGestures`. Default false.
     */
    panMode?: boolean;
    class?: string;
    style?: string;
  }

  let {
    editor,
    mode = 'none',
    fit,
    selectionOptions = DEFAULT_SELECTION_TOOL_OPTIONS,
    shapeOptions = DEFAULT_SHAPE_TOOL_OPTIONS,
    typeOptions = DEFAULT_TYPE_TOOL_OPTIONS,
    annotationColor = '#ef4444',
    annotationWidth = 3,
    cropRatio = null,
    onerror,
    typeSession = $bindable(null),
    transformTool: hostTransformTool,
    playback,
    playbackId = 'image',
    onplaybackreveal,
    chromeRoot,
    locate,
    locateElement,
    open,
    viewportGestures = true,
    panMode = false,
    class: className = '',
    style = '',
  }: Props = $props();

  /** Fits the image to view, resetting zoom to 1 and pan to (0, 0). */
  export function fitToView(): void {
    editor.controller.resetZoom();
  }

  let canvasEl = $state<HTMLCanvasElement | null>(null);
  let containerEl = $state<HTMLDivElement | null>(null);
  let rootEl = $state<HTMLDivElement | null>(null);
  /**
   * The viewport in CSS pixels as last rendered. The backing store is larger (device pixel ratio,
   * CSS transforms), so pointer mapping and the projection use this, never `canvasEl.width`.
   */
  let view = { width: 0, height: 0 };
  const report = (source: ImageEditorCanvasErrorSource, message: string | null) => onerror?.(source, message);

  // Agent playback: the agent's cursor in document pixels, drawn over the canvas without clipping so
  // it can visit the host's chrome (tabs, sliders, layer rows).
  const ambientPlayback = getAgentPlayback();
  const playing = $derived((playback === undefined ? ambientPlayback : playback) ?? null);
  /** Document pixels → pixels in the canvas root, through the canvas projection. */
  const docToRoot = (p: PlaybackPoint): PlaybackPoint => {
    if (!canvasEl || !rootEl || !view.width) return p;
    const r = canvasEl.getBoundingClientRect();
    const box = rootEl.getBoundingClientRect();
    const c = imageToCanvasPoint(p, editor.controller.getState(), view.width, view.height, mode === 'crop');
    return { x: r.left - box.left + (c.x * r.width) / view.width, y: r.top - box.top + (c.y * r.height) / view.height };
  };
  /** Viewport (client) pixels → document pixels. */
  const clientToDoc = (p: PlaybackPoint): PlaybackPoint => {
    if (!canvasEl || !view.width) return p;
    const r = canvasEl.getBoundingClientRect();
    const sx = r.width > 0 ? view.width / r.width : 1;
    const sy = r.height > 0 ? view.height / r.height : 1;
    return canvasToImagePoint({ x: (p.x - r.left) * sx, y: (p.y - r.top) * sy }, editor.controller.getState(), view.width, view.height, mode === 'crop');
  };
  /** A client box as a rectangle in document pixels. */
  const clientRect = (r: DOMRect | null | undefined): PlaybackRect | null => {
    if (!r || r.width <= 0) return null;
    const a = clientToDoc({ x: r.left, y: r.top });
    const b = clientToDoc({ x: r.right, y: r.bottom });
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
  };
  const chrome = () => chromeRoot?.() ?? rootEl;
  const elementRect = (selector: string): PlaybackRect | null => clientRect(chrome()?.querySelector(selector)?.getBoundingClientRect());
  const agentPresence = createPlaybackSurface(() => playing, () => playbackId, () => ({
    defaultKind: 'layer',
    locate: (ref: PlaybackRef) => {
      const own = locate?.(ref) ?? clientRect(locateElement?.(ref)?.getBoundingClientRect());
      if (own) return own;
      if (ref.kind === 'panel') return elementRect(`[data-image-tab="${CSS.escape(ref.id)}"]`);
      if (ref.kind === 'control') return elementRect(`[data-control-id="${CSS.escape(ref.id)}"]`);
      return createImagePlaybackLocator(editor.controller)(ref) ?? (ref.kind === 'layer' || ref.kind === 'item' ? elementRect(`[data-layer-id="${CSS.escape(ref.id)}"]`) : null);
    },
    open: async (ref: PlaybackRef) => {
      if (open) return open(ref);
      if (ref.kind !== 'panel') return;
      const tab = chrome()?.querySelector<HTMLElement>(`[data-image-tab="${CSS.escape(ref.id)}"]`);
      if (!tab || tab.getAttribute('aria-selected') === 'true') return;
      tab.click();
      // Let the panel render before the cursor looks for its controls.
      await new Promise((resolve) => setTimeout(resolve, 60));
    },
    bounds: () => clientRect(canvasEl?.getBoundingClientRect()),
    visible: () => {
      const r = rootEl?.getBoundingClientRect();
      return !!r && r.width > 0 && r.height > 0 && !(typeof document !== 'undefined' && document.visibilityState === 'hidden');
    },
    toViewport: (p: PlaybackPoint) => {
      const box = rootEl?.getBoundingClientRect();
      const q = docToRoot(p);
      return { x: (box?.left ?? 0) + q.x, y: (box?.top ?? 0) + q.y };
    },
    fromViewport: clientToDoc,
    reveal: () => onplaybackreveal?.(),
  }));

  let isSpacePressed = $state(false);
  let isPanning = $state(false);
  // A primary drag pans: Space held, or the host's pan mode.
  const panning = $derived(viewportGestures && (isSpacePressed || panMode));
  // Where a pan drag started, in view pixels: a scaled host (an expanded studio in a zoomed-out
  // canvas) makes screen pixels larger or smaller than the pan's.
  let panStartPoint: ImagePoint | null = null;
  let panStartOffset: { x: number; y: number } = { x: 0, y: 0 };

  function handleWheel(e: WheelEvent) {
    if (!viewportGestures || !canvasEl) return;
    e.preventDefault();

    const rect = canvasEl.getBoundingClientRect();
    const sx = rect.width > 0 ? view.width / rect.width : 1;
    const sy = rect.height > 0 ? view.height / rect.height : 1;
    const canvasPt = {
      x: (e.clientX - rect.left) * sx,
      y: (e.clientY - rect.top) * sy,
    };

    const s = editor.controller.getState();
    const currentZoom = s.zoom || 1;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const nextZoom = Math.min(10, Math.max(0.1, currentZoom * factor));

    // Zoom centered at cursor:
    // in canvas coordinates: img = (canvasPt - pan - center) / zoom
    // We want canvasPt to remain invariant after zoom:
    // (canvasPt - center - newPan) / newZoom = (canvasPt - center - oldPan) / oldZoom
    // newPan = canvasPt - center - (canvasPt - center - oldPan) * (newZoom / oldZoom)
    const centerX = view.width / 2;
    const centerY = view.height / 2;
    const curPan = s.pan || { x: 0, y: 0 };
    const ratio = nextZoom / currentZoom;

    const newPanX = canvasPt.x - centerX - (canvasPt.x - centerX - curPan.x) * ratio;
    const newPanY = canvasPt.y - centerY - (canvasPt.y - centerY - curPan.y) * ratio;

    editor.controller.setZoom(nextZoom);
    editor.controller.setPan({ x: Math.round(newPanX), y: Math.round(newPanY) });
  }

  $effect(() => {
    if (typeof window === 'undefined') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        isSpacePressed = true;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        isSpacePressed = false;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  });
  const selectionGesture = $derived(new SelectionGesture(editor.controller, () => selectionOptions));
  let selectionDraft = $state.raw<ImagePoint[] | null>(null);
  // Paint tools (Move, Brush, Eraser): the pointer gesture and the brush cursor.
  const paintGesture = $derived(new PaintGesture(editor.controller));
  let brushCursor: ImagePoint | null = null;

  // Shape and type tools; type is edited on the canvas through a hidden textarea.
  const shapeGesture = $derived(new ShapeDrawGesture(editor.controller, () => shapeOptions));
  const typeTool = $derived(new TypeToolGesture(editor.controller, () => typeOptions));
  let typeInputEl = $state<HTMLTextAreaElement | null>(null);
  $effect(() => {
    const s = typeSession;
    if (!s) return;
    return untrack(() => s.subscribe(() => void renderCanvas()));
  });
  $effect(() => {
    // End the edit when the mode or tool changes, or when the host sets `typeSession` to null.
    const keep = mode === 'annotate' && editor.state.activeTool === 'type' && typeSession !== null;
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
      report('type', session.error);
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
  const ownTransformTool = $derived(
    hostTransformTool
      ? null
      : new FreeTransformTool(editor.controller, {
          schedule: (run) => (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(run) : run()),
        })
  );
  const transformTool = $derived(hostTransformTool ?? ownTransformTool!);
  let transformTick = $state(0);
  let transformCursor = $state('default');
  const transformActive = $derived((void transformTick, transformTool.active));
  $effect(() => {
    const tool = transformTool;
    const owned = tool === ownTransformTool;
    const off = tool.subscribe(() => {
      transformTick++;
      void renderCanvas();
    });
    return () => {
      off();
      if (owned) tool.cancel();
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

  /** How far outside a frame (in hit tolerances) a drag rotates instead of picking a layer. */
  const ROTATE_BAND = 4;

  /**
   * Transform mode, with no transform open: the active layer's frame, drawn as a transform's.
   * A layer locked in place gets the outline without handles.
   */
  function layerFrame(): TransformOverlay | null {
    if (mode !== 'transform' || transformTool.active) return null;
    const c = editor.controller;
    const id = c.getState().activeLayerId;
    const layer = id ? c.getLayer(id) : undefined;
    if (!layer || layer.visible === false) return null;
    const corners = c.getLayerFrame(layer.id);
    if (!corners) return null;
    const { scale } = getViewportProjection(c.getState(), view.width, view.height, false);
    return quadFrameOverlay(corners, !(layer.locks?.all || layer.locks?.position), TRANSFORM_ROTATE_HANDLE_OFFSET / (scale || 1));
  }

  /**
   * Transform mode: a drag on the active layer's frame transforms it, and a press elsewhere picks
   * the layer there (or none) and drags that. Each drag opens a Free Transform and closes it on
   * release, one undo step when it changed something, so other edits never meet an open one.
   */
  let frameDrag = false;
  function handleFramePointerDown(e: PointerEvent): boolean {
    if (mode !== 'transform' || transformTool.active || !canvasEl) return false;
    // Middle-button and Space drags pan (see handleMouseDown).
    if (e.button !== 0 || panning) return false;
    const c = editor.controller;
    const { pt, tolerance } = transformPoint(e);
    const frame = layerFrame();
    let target = frame && boxFrameHit(frame, pt, tolerance, tolerance * ROTATE_BAND) ? c.getState().activeLayerId : null;
    if (!target) {
      target = c.layerAt(pt);
      c.setActiveLayer(target);
    }
    const layer = target ? c.getLayer(target) : undefined;
    if (!layer || layer.locks?.all || layer.locks?.position) return true;
    e.preventDefault();
    if (transformTool.begin({ layerId: layer.id })) return true;
    try {
      canvasEl.setPointerCapture?.(e.pointerId);
    } catch {
      // Synthetic events have no active pointer to capture.
    }
    // A press anywhere inside moves the layer, the centre included.
    transformTool.down(pt, tolerance, { reference: false });
    frameDrag = true;
    return true;
  }
  function endFrameDrag(cancelled = false) {
    if (!frameDrag) return;
    frameDrag = false;
    if (!transformTool.active) return;
    if (!cancelled && transformTool.modified) transformTool.commit();
    else transformTool.cancel();
  }

  /** The document point of a pointer event and the hit tolerance (6 screen px). */
  function transformPoint(e: PointerEvent) {
    const rect = canvasEl!.getBoundingClientRect();
    const sx = rect.width > 0 ? view.width / rect.width : 1;
    const sy = rect.height > 0 ? view.height / rect.height : 1;
    const s = editor.controller.getState();
    const cropping = mode === 'crop';
    const projection = getViewportProjection(s, view.width, view.height, cropping);
    const pt = canvasToImagePoint({ x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy }, s, view.width, view.height, cropping);
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

  // The agent's drags pull out the crop box or the marquee as it goes, like a user's drag; the call
  // that follows sets the real crop or selection.
  let agentDrafting = false;
  $effect(() => {
    const presence = agentPresence;
    return untrack(() =>
      presence.subscribe(
        trackPresenceDrag({
          onDrag: (box) => {
            if (cropDragInfo || selectionGesture.active) return;
            const draft = agentDragDraft(mode, box, editor.controller.getState().imageDimensions);
            if (!draft) return;
            agentDrafting = true;
            if ('crop' in draft) draftCrop = draft.crop;
            else selectionDraft = draft.selectionPath;
            void renderCanvas();
          },
          onEnd: () => {
            if (!agentDrafting) return;
            agentDrafting = false;
            draftCrop = null;
            selectionDraft = null;
            void renderCanvas();
          },
        }),
      ),
    );
  });

  // Marching ants: while a selection shows as ants, step the dash offset and redraw.
  let antsOffset = 0;
  const marching = $derived(!!editor.state.selection?.bounds && !editor.state.quickMask);
  $effect(() => {
    if (!marching) return;
    return startMarchingAnts((offset) => {
      antsOffset = offset;
      void renderCanvas();
    });
  });

  async function renderCanvas(overrideAnnotation?: Annotation | null, overrideCrop?: CropBox | null) {
    if (!canvasEl || !containerEl) return;
    const viewport = measureCanvasViewport(containerEl);
    view = { width: viewport.width, height: viewport.height };
    // The transform overlay's rotate handle sits a fixed distance out on screen.
    transformTool.setView(getViewportProjection(editor.controller.getState(), view.width, view.height, mode === 'crop').scale);

    await editor.controller.render(canvasEl, {
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      pixelRatio: viewport.pixelRatio,
      hostScale: viewport.hostScale,
      fit,
      showCropOverlay: mode === 'crop',
      showSelectionOverlay: true,
      antsOffset,
      interactive: true,
      draftAnnotation: overrideAnnotation !== undefined ? overrideAnnotation : draftAnnotation,
      draftCrop: overrideCrop !== undefined ? overrideCrop : draftCrop,
      draftSelectionPath: selectionDraft,
      brushCursor:
        mode === 'paint' && brushCursor && editor.controller.getState().activeTool !== 'move' && !transformTool.active
          ? { ...brushCursor, diameter: editor.controller.getState().paint.brush.size }
          : null,
      freeTransform: transformTool.overlay() ?? layerFrame(),
      textEdit: typeTool.session?.alive ? typeTool.session.overlay() : null,
    });
  }

  // Paint tools: pointer events (coalesced samples, pointer capture) into strokes and moves.
  function paintSamples(e: PointerEvent) {
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const list = events.length ? events : [e];
    const rect = canvasEl!.getBoundingClientRect();
    const sx = rect.width > 0 ? view.width / rect.width : 1;
    const sy = rect.height > 0 ? view.height / rect.height : 1;
    const s = editor.controller.getState();
    return list.map((ev) => ({
      ...canvasToImagePoint({ x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy }, s, view.width, view.height, false),
      pressure: pointerPressure(ev),
    }));
  }
  function handlePaintPointerDown(e: PointerEvent) {
    // Panning: the drag moves the view (handleMouseDown), not the document.
    if (panning && e.button === 0) return;
    if (handleTransformPointerDown(e)) return;
    if (handleFramePointerDown(e)) return;
    if (mode !== 'paint' || e.button !== 0 || !canvasEl) return;
    e.preventDefault();
    try {
      canvasEl.setPointerCapture?.(e.pointerId);
    } catch {
      // Synthetic events have no active pointer to capture.
    }
    report('paint', paintGesture.down({ ...paintSamples(e)[0], altKey: e.altKey }));
  }
  function handlePaintPointerMove(e: PointerEvent) {
    if (panning && !transformTool.active) return;
    if (handleTransformPointerMove(e)) return;
    if (mode === 'transform' && canvasEl) {
      const { pt, tolerance } = transformPoint(e);
      const frame = layerFrame();
      transformCursor = frame ? transformTool.cursor(boxFrameHit(frame, pt, tolerance, tolerance * ROTATE_BAND)) : 'default';
      return;
    }
    if (mode !== 'paint' || !canvasEl) return;
    const samples = paintSamples(e);
    brushCursor = samples[samples.length - 1] ?? null;
    if (paintGesture.active) paintGesture.moveTo(samples);
    else void renderCanvas();
  }
  function handlePaintPointerUp() {
    if (handleTransformPointerUp()) {
      endFrameDrag();
      return;
    }
    if (mode !== 'paint' || !paintGesture.active) return;
    paintGesture.up();
    if (paintGesture.error) report('paint', paintGesture.error);
  }

  $effect(() => {
    if (mode !== 'select' || typeof window === 'undefined') return;
    const gesture = selectionGesture;
    // The polygonal lasso: Enter closes it, Escape cancels, Backspace removes the last corner.
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (gesture.key(e.key)) {
        e.preventDefault();
        selectionDraft = gesture.draftPath;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  $effect(() => {
    if (mode !== 'paint' || typeof window === 'undefined') return;
    const c = editor.controller;
    const onKey = (e: KeyboardEvent) => {
      if (handlePaintShortcut(c, e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  $effect(() => {
    // Re-render when editor state, the mode or the fit changes
    void editor.state;
    void mode;
    void fit;

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
    if (!containerEl) return;
    const { width, height } = measureCanvasViewport(containerEl);
    view = { width, height };
    // Re-render when the layout size, the device pixel ratio or a host's CSS transform scale changes.
    return watchCanvasViewport(containerEl, () => renderCanvas());
  });

  function getCanvasEventPoint(e: MouseEvent): ImagePoint {
    if (!canvasEl) return { x: 0, y: 0 };
    const rect = canvasEl.getBoundingClientRect();
    const scaleX = rect.width > 0 ? view.width / rect.width : 1;
    const scaleY = rect.height > 0 ? view.height / rect.height : 1;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  function handleMouseDown(e: MouseEvent) {
    if (!canvasEl) return;

    if (viewportGestures && (e.button === 1 || (e.button === 0 && panning))) {
      e.preventDefault();
      isPanning = true;
      panStartPoint = getCanvasEventPoint(e);
      const curPan = editor.controller.getState().pan || { x: 0, y: 0 };
      panStartOffset = { ...curPan };
      return;
    }

    // Transform mode picks and drags layers on pointerdown (handleFramePointerDown).
    if (mode === 'transform') return;

    if (transformTool.active) return;
    const canvasPt = getCanvasEventPoint(e);

    if (mode === 'select') {
      const gesture = selectionGesture;
      const imgPt = canvasToImagePoint(canvasPt, editor.state, view.width, view.height, false);
      void gesture.begin(imgPt, e).then(() => {
        report('select', gesture.error);
        selectionDraft = gesture.draftPath;
      });
      return;
    }

    if (mode === 'crop') {
      const activeCrop = draftCrop || editor.state.crop || {
        x: 0,
        y: 0,
        width: editor.state.imageDimensions.width,
        height: editor.state.imageDimensions.height,
      };
      const handle = hitTestCrop(canvasPt, editor.state, view.width, view.height, 14, activeCrop);
      const startImgPt = canvasToImagePoint(canvasPt, editor.state, view.width, view.height, true);

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

    if (mode === 'annotate' && (editor.state.activeTool === 'shape' || editor.state.activeTool === 'type')) {
      const imgPt = canvasToImagePoint(canvasPt, editor.state, view.width, view.height, false);
      report(editor.state.activeTool, null);
      if (editor.state.activeTool === 'shape') shapeGesture.down(imgPt);
      else {
        typeTool.down(imgPt, { shift: e.shiftKey });
        typeSession = typeTool.session;
        void renderCanvas();
      }
      return;
    }

    if (mode === 'annotate') {
      const imgPt = canvasToImagePoint(canvasPt, editor.state, view.width, view.height, false);
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
          strokeColor: annotationColor,
          strokeWidth: annotationWidth,
        };
        draftAnnotation = draft;
        renderCanvas(draft);
      }
    }
  }

  function handleMouseMove(e: MouseEvent) {
    if (!canvasEl) return;

    if (isPanning && panStartPoint) {
      const pt = getCanvasEventPoint(e);
      const dx = pt.x - panStartPoint.x;
      const dy = pt.y - panStartPoint.y;
      editor.controller.setPan({
        x: Math.round(panStartOffset.x + dx),
        y: Math.round(panStartOffset.y + dy),
      });
      return;
    }

    if (panning) {
      canvasEl.style.cursor = 'grab';
      return;
    }

    if (transformTool.active) return;
    const canvasPt = getCanvasEventPoint(e);

    if (mode === 'select') {
      const gesture = selectionGesture;
      if (gesture.active && gesture.move(canvasToImagePoint(canvasPt, editor.state, view.width, view.height, false), e)) {
        selectionDraft = gesture.draftPath;
        renderCanvas();
      }
      return;
    }

    if (mode === 'crop') {
      if (cropDragInfo) {
        const currentImgPt = canvasToImagePoint(canvasPt, editor.state, view.width, view.height, true);
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
            cropRatio,
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
        const handle = hitTestCrop(canvasPt, editor.state, view.width, view.height, 14, activeCrop);
        canvasEl.style.cursor = getCropCursor(handle, editor.state.transform);
      }
      return;
    }

    if (mode === 'annotate' && editor.state.activeTool === 'shape') {
      if (shapeGesture.active) {
        shapeGesture.move(canvasToImagePoint(canvasPt, editor.state, view.width, view.height, false), { shift: e.shiftKey, alt: e.altKey });
        if (shapeGesture.error) report('shape', shapeGesture.error);
      }
      return;
    }

    if (mode === 'annotate') {
      if (annotationDragInfo) {
        const currentImgPt = canvasToImagePoint(canvasPt, editor.state, view.width, view.height, false);
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
          const imgPt = canvasToImagePoint(canvasPt, editor.state, view.width, view.height, false);
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

      const currentImgPt = canvasToImagePoint(canvasPt, editor.state, view.width, view.height, false);
      const stroke = { strokeColor: annotationColor, strokeWidth: annotationWidth };

      if (editor.state.activeTool === 'pen' && isDrawing) {
        currentPath.push(currentImgPt);
        const draft: Annotation = { id: 'draft', type: 'pen', x: 0, y: 0, points: [...currentPath], ...stroke };
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
          ...stroke,
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
          ...stroke,
        };
        draftAnnotation = draft;
        renderCanvas(draft);
      } else if (editor.state.activeTool === 'arrow' || editor.state.activeTool === 'line') {
        const draft: Annotation = {
          id: 'draft',
          type: editor.state.activeTool,
          x: dragStartPoint.x,
          y: dragStartPoint.y,
          endX: currentImgPt.x,
          endY: currentImgPt.y,
          ...stroke,
        };
        draftAnnotation = draft;
        renderCanvas(draft);
      }
    }
  }

  function handleMouseUp(e: MouseEvent) {
    if (isPanning) {
      isPanning = false;
      panStartPoint = null;
      return;
    }
    if (!canvasEl || transformTool.active) return;
    const canvasPt = getCanvasEventPoint(e);

    if (mode === 'select') {
      const gesture = selectionGesture;
      if (gesture.active) {
        gesture.end(canvasToImagePoint(canvasPt, editor.state, view.width, view.height, false), e);
        // A polygonal lasso stays open between clicks.
        selectionDraft = gesture.draftPath;
        renderCanvas();
      }
      return;
    }

    if (mode === 'crop') {
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

    if (mode === 'annotate' && editor.state.activeTool === 'shape') {
      shapeGesture.up();
      return;
    }
    if (mode === 'annotate' && editor.state.activeTool === 'type') {
      typeTool.up(canvasToImagePoint(canvasPt, editor.state, view.width, view.height, false));
      typeSession = typeTool.session;
      if (typeTool.error) report('type', typeTool.error);
      void renderCanvas();
      // Keystrokes go to the hidden textarea while text is being edited.
      if (typeTool.session) setTimeout(() => typeInputEl?.focus(), 0);
      return;
    }

    if (mode === 'annotate') {
      if (annotationDragInfo) {
        annotationDragInfo = null;
        return;
      }

      if (dragStartPoint) {
        const currentImgPt = canvasToImagePoint(canvasPt, editor.state, view.width, view.height, false);
        const stroke = { strokeColor: annotationColor, strokeWidth: annotationWidth };

        if (editor.state.activeTool === 'pen' && isDrawing) {
          if (currentPath.length > 1) {
            editor.addAnnotation({ type: 'pen', x: 0, y: 0, points: [...currentPath], ...stroke });
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
              ...stroke,
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
              ...stroke,
            });
          }
        } else if (editor.state.activeTool === 'arrow' || editor.state.activeTool === 'line') {
          if (Math.hypot(currentImgPt.x - dragStartPoint.x, currentImgPt.y - dragStartPoint.y) > 4) {
            editor.addAnnotation({
              type: editor.state.activeTool,
              x: dragStartPoint.x,
              y: dragStartPoint.y,
              endX: currentImgPt.x,
              endY: currentImgPt.y,
              ...stroke,
            });
          }
        }

        draftAnnotation = null;
        dragStartPoint = null;
        renderCanvas();
      }
    }
  }
</script>

<!--
  The image editor's canvas on its own: the render loop (sized by its container), every pointer
  gesture of the crop, select, paint and annotate modes, Free Transform, the hidden textarea for
  on-canvas type, and the agent playback surface. Give it a size (it fills its box). Parity with
  React's `<ImageEditorCanvas>`.
-->
<div bind:this={rootEl} class="relative {className}" {style} data-testid="image-editor-canvas-root">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={containerEl}
    onwheel={handleWheel}
    class="absolute inset-0 overflow-hidden select-none"
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
      onpointercancel={() => {
        paintGesture.cancel();
        endFrameDrag(true);
      }}
      data-testid="image-editor-canvas"
      style="width: 100%; height: 100%;{panning ? ` cursor: ${isPanning ? 'grabbing' : 'grab'};` : transformActive || mode === 'transform' ? ` cursor: ${transformCursor};` : ''}"
      class="absolute inset-0 w-full h-full block {transformActive || mode === 'transform' ? 'touch-none' : mode === 'paint' ? 'touch-none cursor-crosshair' : mode === 'annotate' && editor.state.activeTool === 'type' ? 'cursor-text' : mode === 'annotate' && editor.state.activeTool === 'shape' ? 'cursor-crosshair' : ''}"
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
  {#if playing}
    <PresenceLayer presence={agentPresence} viewport={docToRoot} clip={false} />
  {/if}
</div>
