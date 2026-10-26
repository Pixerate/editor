import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentPlayback, PlaybackPoint, PlaybackRect, PlaybackRef } from '@pixerate/editor/tools';
import type { Annotation, CropBox, CropHandle, ImageEditorFit, ImagePoint } from '@pixerate/editor/image-editor';
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
  getViewportProjection,
  measureCanvasViewport,
  watchCanvasViewport,
  ShapeDrawGesture,
  TypeToolGesture,
  DEFAULT_SHAPE_TOOL_OPTIONS,
  DEFAULT_TYPE_TOOL_OPTIONS,
  type SelectionToolOptions,
  type ShapeToolOptions,
  type TextEditSession,
  type TransformHandle,
  type TypeToolOptions,
} from '@pixerate/editor/image-editor';
import { useAgentPlayback } from '../playback/AgentPlaybackContext';
import { usePlaybackSurface } from '../playback/usePlaybackSurface';
import { trackPresenceDrag } from '@pixerate/editor/tools';
import { PresenceLayer } from '../playback/PresenceLayer';
import type { UseImageEditorReturn } from './useImageEditor';

/** What pointer gestures on the canvas do (and whether the crop overlay shows). */
export type ImageEditorCanvasMode = 'crop' | 'select' | 'paint' | 'annotate' | 'none';
/** Which gesture an `onError` report comes from. */
export type ImageEditorCanvasErrorSource = 'paint' | 'select' | 'shape' | 'type';

export interface ImageEditorCanvasProps {
  /** The editor to draw and edit (`useImageEditor`). */
  editor: UseImageEditorReturn;
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
  onError?: (source: ImageEditorCanvasErrorSource, message: string | null) => void;
  /**
   * The text being edited on the canvas. Pass it with `onTypeSessionChange` to follow it; changing
   * it from a session to `null` finishes editing.
   */
  typeSession?: TextEditSession | null;
  /** Called when on-canvas text editing starts or ends. */
  onTypeSessionChange?: (session: TextEditSession | null) => void;
  /**
   * The Free Transform tool (Ctrl/Cmd+T) the canvas drives and draws. Pass your own to show its
   * options bar or begin transforms from your UI; by default the canvas makes one.
   */
  transformTool?: FreeTransformTool;
  /**
   * Agent playback: act out the image tools' calls on this canvas with the agent's cursor
   * (default: the nearest `AgentPlaybackProvider`; `null` turns it off).
   */
  playback?: AgentPlayback | null;
  /** The playback surface id (default `image`, where the image tool providers play). */
  playbackId?: string;
  /** Bring the canvas on screen (switch to its tab) before the agent acts. */
  onPlaybackReveal?: () => void | Promise<void>;
  /**
   * Where the default playback lookups find the editor's chrome: tabs (`[data-image-tab]`),
   * sliders (`[data-control-id]`) and layer rows (`[data-layer-id]`). Default: the canvas itself.
   */
  chromeRoot?: React.RefObject<HTMLElement | null>;
  /** Your own lookup for a playback ref, in document pixels (tried first). */
  locate?: (ref: PlaybackRef) => PlaybackRect | null;
  /** Your own element for a playback ref, anywhere on the page; its box is mapped to document pixels. */
  locateElement?: (ref: PlaybackRef) => Element | null;
  /** Show a panel for an `open` step (default: click its `[data-image-tab]` under `chromeRoot`). */
  open?: (ref: PlaybackRef) => void | Promise<void>;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * The image editor's canvas on its own: the render loop (sized by its container), every pointer
 * gesture of the crop, select, paint and annotate modes, Free Transform, the hidden textarea for
 * on-canvas type, and the agent playback surface. Give it a size (it fills its box). Parity with
 * Svelte's `<ImageEditorCanvas>`.
 */
export const ImageEditorCanvas: React.FC<ImageEditorCanvasProps> = ({
  editor,
  mode = 'none',
  fit,
  selectionOptions = DEFAULT_SELECTION_TOOL_OPTIONS,
  shapeOptions = DEFAULT_SHAPE_TOOL_OPTIONS,
  typeOptions = DEFAULT_TYPE_TOOL_OPTIONS,
  annotationColor = '#ef4444',
  annotationWidth = 3,
  cropRatio = null,
  onError,
  typeSession: typeSessionProp,
  onTypeSessionChange,
  transformTool: hostTransformTool,
  playback,
  playbackId = 'image',
  onPlaybackReveal,
  chromeRoot,
  locate,
  locateElement,
  open,
  className = '',
  style,
}) => {
  const { state, controller } = editor;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /**
   * The viewport in CSS pixels as last rendered. The backing store is larger (device pixel ratio,
   * CSS transforms), so pointer mapping and the projection use this, never `canvas.width`.
   */
  const viewRef = useRef({ width: 0, height: 0 });
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const latest = useRef({ onError, onTypeSessionChange, locate, locateElement, open, chromeRoot, onPlaybackReveal });
  latest.current = { onError, onTypeSessionChange, locate, locateElement, open, chromeRoot, onPlaybackReveal };
  const report = (source: ImageEditorCanvasErrorSource, message: string | null) => latest.current.onError?.(source, message);

  // Agent playback: the agent's cursor in document pixels, drawn over the canvas without clipping so
  // it can visit the host's chrome (tabs, sliders, layer rows).
  const ambientPlayback = useAgentPlayback();
  const playing = (playback === undefined ? ambientPlayback : playback) ?? null;
  const locateLayer = useMemo(() => createImagePlaybackLocator(controller), [controller]);
  /** Document pixels → pixels in the canvas root, through the canvas projection. */
  const docToRoot = (p: PlaybackPoint): PlaybackPoint => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!canvas || !root || !viewRef.current.width) return p;
    const r = canvas.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    const c = imageToCanvasPoint(p, controller.getState(), viewRef.current.width, viewRef.current.height, modeRef.current === 'crop');
    return { x: r.left - box.left + (c.x * r.width) / viewRef.current.width, y: r.top - box.top + (c.y * r.height) / viewRef.current.height };
  };
  /** Viewport (client) pixels → document pixels. */
  const clientToDoc = (p: PlaybackPoint): PlaybackPoint => {
    const canvas = canvasRef.current;
    if (!canvas || !viewRef.current.width) return p;
    const r = canvas.getBoundingClientRect();
    const sx = r.width > 0 ? viewRef.current.width / r.width : 1;
    const sy = r.height > 0 ? viewRef.current.height / r.height : 1;
    return canvasToImagePoint({ x: (p.x - r.left) * sx, y: (p.y - r.top) * sy }, controller.getState(), viewRef.current.width, viewRef.current.height, modeRef.current === 'crop');
  };
  /** A client box as a rectangle in document pixels. */
  const clientRect = (r: DOMRect | null | undefined): PlaybackRect | null => {
    if (!r || r.width <= 0) return null;
    const a = clientToDoc({ x: r.left, y: r.top });
    const b = clientToDoc({ x: r.right, y: r.bottom });
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
  };
  const chrome = () => latest.current.chromeRoot?.current ?? rootRef.current;
  const elementRect = (selector: string): PlaybackRect | null => clientRect(chrome()?.querySelector(selector)?.getBoundingClientRect());
  const agentPresence = usePlaybackSurface(playing, playbackId, {
    defaultKind: 'layer',
    locate: (ref: PlaybackRef) => {
      const host = latest.current;
      const own = host.locate?.(ref) ?? clientRect(host.locateElement?.(ref)?.getBoundingClientRect());
      if (own) return own;
      if (ref.kind === 'panel') return elementRect(`[data-image-tab="${CSS.escape(ref.id)}"]`);
      if (ref.kind === 'control') return elementRect(`[data-control-id="${CSS.escape(ref.id)}"]`);
      return locateLayer(ref) ?? (ref.kind === 'layer' || ref.kind === 'item' ? elementRect(`[data-layer-id="${CSS.escape(ref.id)}"]`) : null);
    },
    open: async (ref: PlaybackRef) => {
      if (latest.current.open) return latest.current.open(ref);
      if (ref.kind !== 'panel') return;
      const tab = chrome()?.querySelector<HTMLElement>(`[data-image-tab="${CSS.escape(ref.id)}"]`);
      if (!tab || tab.getAttribute('aria-selected') === 'true') return;
      tab.click();
      // Let the panel render before the cursor looks for its controls.
      await new Promise((resolve) => setTimeout(resolve, 60));
    },
    bounds: () => clientRect(canvasRef.current?.getBoundingClientRect()),
    visible: () => {
      const r = rootRef.current?.getBoundingClientRect();
      return !!r && r.width > 0 && r.height > 0 && !(typeof document !== 'undefined' && document.visibilityState === 'hidden');
    },
    toViewport: (p) => {
      const box = rootRef.current?.getBoundingClientRect();
      const q = docToRoot(p);
      return { x: (box?.left ?? 0) + q.x, y: (box?.top ?? 0) + q.y };
    },
    fromViewport: clientToDoc,
    reveal: () => latest.current.onPlaybackReveal?.(),
  });

  // Selection tools (magic wand, marquees, lasso): the pointer gesture.
  const selectionOptionsRef = useRef(selectionOptions);
  selectionOptionsRef.current = selectionOptions;
  const selectionGestureRef = useRef<SelectionGesture | null>(null);
  if (!selectionGestureRef.current || selectionGestureRef.current.controller !== controller) {
    selectionGestureRef.current = new SelectionGesture(controller, () => selectionOptionsRef.current);
  }
  const selectionDraftRef = useRef<ImagePoint[] | null>(null);

  // Paint tools (Move, Brush, Eraser): the pointer gesture and the brush cursor.
  const paintGestureRef = useRef<PaintGesture | null>(null);
  const paintControllerRef = useRef(controller);
  if (!paintGestureRef.current || paintControllerRef.current !== controller) {
    paintGestureRef.current = new PaintGesture(controller);
    paintControllerRef.current = controller;
  }
  const brushCursorRef = useRef<ImagePoint | null>(null);

  // Free Transform (Ctrl/Cmd+T): the shared tool drives a session; its overlay is drawn by the renderer.
  const ownTransformRef = useRef<FreeTransformTool | null>(null);
  const ownTransformControllerRef = useRef(controller);
  if (!hostTransformTool && (!ownTransformRef.current || ownTransformControllerRef.current !== controller)) {
    ownTransformRef.current?.cancel();
    ownTransformRef.current = new FreeTransformTool(controller, {
      schedule: (run) => (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(run) : run()),
    });
    ownTransformControllerRef.current = controller;
  }
  const transformTool = hostTransformTool ?? ownTransformRef.current!;
  const [, setTransformTick] = useState(0);
  const [transformCursor, setTransformCursor] = useState('default');
  useEffect(() => () => ownTransformRef.current?.cancel(), []);

  // Shape and type tools; type is edited on the canvas through a hidden textarea.
  const shapeOptionsRef = useRef(shapeOptions);
  shapeOptionsRef.current = shapeOptions;
  const typeOptionsRef = useRef(typeOptions);
  typeOptionsRef.current = typeOptions;
  const shapeGestureRef = useRef<ShapeDrawGesture | null>(null);
  const typeToolRef = useRef<TypeToolGesture | null>(null);
  const shapeTypeControllerRef = useRef(controller);
  if (!shapeGestureRef.current || !typeToolRef.current || shapeTypeControllerRef.current !== controller) {
    typeToolRef.current?.finish();
    shapeGestureRef.current = new ShapeDrawGesture(controller, () => shapeOptionsRef.current);
    typeToolRef.current = new TypeToolGesture(controller, () => typeOptionsRef.current);
    shapeTypeControllerRef.current = controller;
  }
  const typeInputRef = useRef<HTMLTextAreaElement>(null);
  const [typeSession, setTypeSessionState] = useState(typeToolRef.current.session);
  const setTypeSession = (session: TextEditSession | null) => {
    setTypeSessionState(session);
    latest.current.onTypeSessionChange?.(session);
  };

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

      const viewport = measureCanvasViewport(container);
      viewRef.current = { width: viewport.width, height: viewport.height };

      await controller.render(canvas, {
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        pixelRatio: viewport.pixelRatio,
        fit,
        showCropOverlay: mode === 'crop',
        showSelectionOverlay: true,
        interactive: true,
        draftAnnotation: draftAnnotation !== undefined ? draftAnnotation : draftAnnotationRef.current,
        draftCrop: draftCrop !== undefined ? draftCrop : draftCropRef.current,
        draftSelectionPath: selectionDraftRef.current,
        brushCursor:
          mode === 'paint' && brushCursorRef.current && controller.getState().activeTool !== 'move' && !transformTool.active
            ? { ...brushCursorRef.current, diameter: controller.getState().paint.brush.size }
            : null,
        freeTransform: transformTool.overlay(),
        textEdit: typeToolRef.current?.session?.alive ? typeToolRef.current.session.overlay() : null,
      });
    },
    [controller, mode, fit, transformTool]
  );

  // The text being edited: re-render on every change, and end it when the tool or mode changes or
  // the host clears its session.
  // The agent's drags pull out the crop box or the marquee as it goes, like a user's drag; the call
  // that follows sets the real crop or selection.
  useEffect(() => {
    let drafting = false;
    return agentPresence.subscribe(
      trackPresenceDrag({
        onDrag: (box) => {
          if (cropDragInfoRef.current || selectionGestureRef.current?.active) return;
          const draft = agentDragDraft(modeRef.current, box, controller.getState().imageDimensions);
          if (!draft) return;
          drafting = true;
          if ('crop' in draft) draftCropRef.current = draft.crop;
          else selectionDraftRef.current = draft.selectionPath;
          void renderCanvas();
        },
        onEnd: () => {
          if (!drafting) return;
          drafting = false;
          draftCropRef.current = null;
          selectionDraftRef.current = null;
          void renderCanvas();
        },
      }),
    );
  }, [agentPresence, controller, renderCanvas]);

  useEffect(() => typeSession?.subscribe(() => void renderCanvas()), [typeSession, renderCanvas]);
  const finishTyping = () => {
    typeToolRef.current?.finish();
    setTypeSession(null);
    void renderCanvas();
  };
  useEffect(() => {
    if (mode === 'annotate' && state.activeTool === 'type') return;
    if (typeToolRef.current?.session) finishTyping();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, state.activeTool, renderCanvas]);
  const prevTypeSessionProp = useRef(typeSessionProp);
  useEffect(() => {
    const was = prevTypeSessionProp.current;
    prevTypeSessionProp.current = typeSessionProp;
    if (was && typeSessionProp === null && typeToolRef.current?.session) finishTyping();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeSessionProp]);
  const handleTypeKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const session = typeToolRef.current?.session;
    if (!session || e.nativeEvent.isComposing) return;
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
  };
  const handleTypeInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    // Composed (IME) and pasted text arrives here; plain keys were handled on keydown.
    const el = e.currentTarget;
    const session = typeToolRef.current?.session;
    if (session && el.value && !(e.nativeEvent as InputEvent).isComposing) {
      session.insert(el.value);
      el.value = '';
    }
  };

  useEffect(() => transformTool.subscribe(() => {
    setTransformTick((n) => n + 1);
    void renderCanvas();
  }), [transformTool, renderCanvas]);

  /** The canvas point of a pointer event, its document point, and the screen scale. */
  const transformPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width > 0 ? viewRef.current.width / rect.width : 1;
    const sy = rect.height > 0 ? viewRef.current.height / rect.height : 1;
    const s = controller.getState();
    const cropping = mode === 'crop';
    const projection = getViewportProjection(s, viewRef.current.width, viewRef.current.height, cropping);
    const pt = canvasToImagePoint({ x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy }, s, viewRef.current.width, viewRef.current.height, cropping);
    transformTool.setView(projection.scale);
    return { pt, tolerance: 6 / (projection.scale || 1) };
  };
  const handleTransformPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): boolean => {
    if (!transformTool.active) return false;
    if (e.button !== 0) return true;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // Synthetic events have no active pointer to capture.
    }
    const { pt, tolerance } = transformPoint(e);
    transformTool.down(pt, tolerance);
    return true;
  };
  const handleTransformPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): boolean => {
    if (!transformTool.active) return false;
    const { pt, tolerance } = transformPoint(e);
    if (e.buttons & 1) transformTool.move(pt, e);
    else {
      const over: TransformHandle | null = transformTool.hit(pt, tolerance);
      setTransformCursor(transformTool.cursor(over));
    }
    return true;
  };
  const handleTransformPointerUp = (): boolean => {
    if (!transformTool.active) return false;
    transformTool.up();
    return true;
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (transformTool.key(e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [transformTool]);

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

  // Re-render when the layout size, the device pixel ratio or a host's CSS transform scale changes.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const { width, height } = measureCanvasViewport(container);
    viewRef.current = { width, height };
    return watchCanvasViewport(container, () => renderCanvas());
  }, [renderCanvas]);

  // Convert mouse event coordinates to internal canvas pixel space
  const getCanvasEventPoint = (e: React.MouseEvent<HTMLCanvasElement>): ImagePoint => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width > 0 ? viewRef.current.width / rect.width : 1;
    const scaleY = rect.height > 0 ? viewRef.current.height / rect.height : 1;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  // Paint tools: pointer events (coalesced samples, pointer capture) into strokes and moves.
  const paintSamples = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const native = e.nativeEvent as PointerEvent;
    const events = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
    const list = events.length ? events : [native];
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width > 0 ? viewRef.current.width / rect.width : 1;
    const sy = rect.height > 0 ? viewRef.current.height / rect.height : 1;
    const s = controller.getState();
    return list.map((ev) => ({
      ...canvasToImagePoint({ x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy }, s, viewRef.current.width, viewRef.current.height, false),
      pressure: pointerPressure(ev),
    }));
  };
  const handlePaintPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (handleTransformPointerDown(e)) return;
    if (mode !== 'paint' || e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // Synthetic events have no active pointer to capture.
    }
    const [first] = paintSamples(e);
    report('paint', paintGestureRef.current!.down({ ...first, altKey: e.altKey }));
  };
  const handlePaintPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (handleTransformPointerMove(e)) return;
    if (mode !== 'paint') return;
    const samples = paintSamples(e);
    brushCursorRef.current = samples[samples.length - 1] ?? null;
    if (paintGestureRef.current!.active) paintGestureRef.current!.moveTo(samples);
    else void renderCanvas();
  };
  const handlePaintPointerUp = () => {
    if (handleTransformPointerUp()) return;
    if (mode !== 'paint') return;
    const g = paintGestureRef.current!;
    if (g.active) {
      g.up();
      if (g.error) report('paint', g.error);
    }
  };

  useEffect(() => {
    if (mode !== 'paint' || typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (handlePaintShortcut(controller, e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, controller]);

  // Pointer event handlers for drawing and annotations
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || transformTool.active) return;
    const canvasPt = getCanvasEventPoint(e);

    if (mode === 'select') {
      const gesture = selectionGestureRef.current!;
      const imgPt = canvasToImagePoint(canvasPt, state, viewRef.current.width, viewRef.current.height, false);
      void gesture.begin(imgPt, e).then(() => report('select', gesture.error));
      return;
    }

    if (mode === 'crop') {
      const activeCrop = draftCropRef.current || state.crop || {
        x: 0,
        y: 0,
        width: state.imageDimensions.width,
        height: state.imageDimensions.height,
      };
      const handle = hitTestCrop(canvasPt, state, viewRef.current.width, viewRef.current.height, 14, activeCrop);
      const startImgPt = canvasToImagePoint(canvasPt, state, viewRef.current.width, viewRef.current.height, true);

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

    if (mode === 'annotate' && (state.activeTool === 'shape' || state.activeTool === 'type')) {
      const imgPt = canvasToImagePoint(canvasPt, state, viewRef.current.width, viewRef.current.height, false);
      report(state.activeTool, null);
      if (state.activeTool === 'shape') shapeGestureRef.current!.down(imgPt);
      else {
        typeToolRef.current!.down(imgPt, { shift: e.shiftKey });
        setTypeSession(typeToolRef.current!.session);
        void renderCanvas();
      }
      return;
    }

    if (mode === 'annotate') {
      const imgPt = canvasToImagePoint(canvasPt, state, viewRef.current.width, viewRef.current.height, false);
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
          strokeColor: annotationColor,
          strokeWidth: annotationWidth,
        };
        draftAnnotationRef.current = draft;
        renderCanvas(draft);
      }
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || transformTool.active) return;
    const canvasPt = getCanvasEventPoint(e);

    if (mode === 'select') {
      const gesture = selectionGestureRef.current!;
      if (gesture.active && gesture.move(canvasToImagePoint(canvasPt, state, viewRef.current.width, viewRef.current.height, false))) {
        selectionDraftRef.current = gesture.draftPath;
        renderCanvas();
      }
      return;
    }

    if (mode === 'crop') {
      const drag = cropDragInfoRef.current;
      if (drag) {
        const currentImgPt = canvasToImagePoint(canvasPt, state, viewRef.current.width, viewRef.current.height, true);
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
            cropRatio,
            state.transform
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
        const handle = hitTestCrop(canvasPt, state, viewRef.current.width, viewRef.current.height, 14, activeCrop);
        canvas.style.cursor = getCropCursor(handle, state.transform);
      }
      return;
    }

    if (mode === 'annotate' && state.activeTool === 'shape') {
      const g = shapeGestureRef.current!;
      if (g.active) {
        g.move(canvasToImagePoint(canvasPt, state, viewRef.current.width, viewRef.current.height, false), { shift: e.shiftKey, alt: e.altKey });
        if (g.error) report('shape', g.error);
      }
      return;
    }

    if (mode === 'annotate') {
      // If moving selected annotation
      if (annotationDragInfoRef.current) {
        const drag = annotationDragInfoRef.current;
        const currentImgPt = canvasToImagePoint(canvasPt, state, viewRef.current.width, viewRef.current.height, false);
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
          const imgPt = canvasToImagePoint(canvasPt, state, viewRef.current.width, viewRef.current.height, false);
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

      const currentImgPt = canvasToImagePoint(canvasPt, state, viewRef.current.width, viewRef.current.height, false);
      const stroke = { strokeColor: annotationColor, strokeWidth: annotationWidth };

      if (state.activeTool === 'pen' && isDrawingRef.current) {
        currentPathRef.current.push(currentImgPt);
        const draft: Annotation = { id: 'draft', type: 'pen', x: 0, y: 0, points: [...currentPathRef.current], ...stroke };
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
          ...stroke,
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
          ...stroke,
        };
        draftAnnotationRef.current = draft;
        renderCanvas(draft);
      } else if (state.activeTool === 'arrow' || state.activeTool === 'line') {
        const draft: Annotation = {
          id: 'draft',
          type: state.activeTool,
          x: startPt.x,
          y: startPt.y,
          endX: currentImgPt.x,
          endY: currentImgPt.y,
          ...stroke,
        };
        draftAnnotationRef.current = draft;
        renderCanvas(draft);
      }
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || transformTool.active) return;
    const canvasPt = getCanvasEventPoint(e);

    if (mode === 'select') {
      const gesture = selectionGestureRef.current!;
      if (gesture.active) {
        gesture.end(canvasToImagePoint(canvasPt, state, viewRef.current.width, viewRef.current.height, false), e);
        selectionDraftRef.current = null;
        renderCanvas();
      }
      return;
    }

    if (mode === 'crop') {
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

    if (mode === 'annotate' && state.activeTool === 'shape') {
      shapeGestureRef.current!.up();
      return;
    }
    if (mode === 'annotate' && state.activeTool === 'type') {
      const tool = typeToolRef.current!;
      tool.up(canvasToImagePoint(canvasPt, state, viewRef.current.width, viewRef.current.height, false));
      setTypeSession(tool.session);
      if (tool.error) report('type', tool.error);
      void renderCanvas();
      // Keystrokes go to the hidden textarea while text is being edited.
      if (tool.session) setTimeout(() => typeInputRef.current?.focus(), 0);
      return;
    }

    if (mode === 'annotate') {
      if (annotationDragInfoRef.current) {
        annotationDragInfoRef.current = null;
        return;
      }

      const startPt = dragStartPointRef.current;
      if (startPt) {
        const currentImgPt = canvasToImagePoint(canvasPt, state, viewRef.current.width, viewRef.current.height, false);
        const stroke = { strokeColor: annotationColor, strokeWidth: annotationWidth };

        if (state.activeTool === 'pen' && isDrawingRef.current) {
          if (currentPathRef.current.length > 1) {
            editor.addAnnotation({ type: 'pen', x: 0, y: 0, points: [...currentPathRef.current], ...stroke });
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
              ...stroke,
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
              ...stroke,
            });
          }
        } else if (state.activeTool === 'arrow' || state.activeTool === 'line') {
          if (Math.hypot(currentImgPt.x - startPt.x, currentImgPt.y - startPt.y) > 4) {
            editor.addAnnotation({
              type: state.activeTool,
              x: startPt.x,
              y: startPt.y,
              endX: currentImgPt.x,
              endY: currentImgPt.y,
              ...stroke,
            });
          }
        }

        draftAnnotationRef.current = null;
        dragStartPointRef.current = null;
        renderCanvas();
      }
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`.trim()} style={style} data-testid="image-editor-canvas-root">
      <div ref={containerRef} className="absolute inset-0 overflow-hidden select-none">
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onPointerDown={handlePaintPointerDown}
          onPointerMove={handlePaintPointerMove}
          onPointerUp={handlePaintPointerUp}
          onPointerCancel={() => paintGestureRef.current?.cancel()}
          data-testid="image-editor-canvas"
          style={transformTool.active ? { width: '100%', height: '100%', cursor: transformCursor } : { width: '100%', height: '100%' }}
          className={`absolute inset-0 w-full h-full block ${transformTool.active ? 'touch-none' : mode === 'paint' ? 'touch-none cursor-crosshair' : mode === 'annotate' && state.activeTool === 'type' ? 'cursor-text' : mode === 'annotate' && state.activeTool === 'shape' ? 'cursor-crosshair' : ''}`}
        />
        {typeSession && (
          <textarea
            ref={typeInputRef}
            aria-label="Edit text"
            data-testid="type-input"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onKeyDown={handleTypeKeyDown}
            onInput={handleTypeInput}
            onCompositionEnd={(e) => {
              const session = typeToolRef.current?.session;
              if (session && e.data) session.insert(e.data);
              e.currentTarget.value = '';
            }}
            className="absolute left-0 top-0 h-px w-px opacity-0"
          />
        )}
      </div>
      {playing && <PresenceLayer presence={agentPresence} viewport={docToRoot} clip={false} />}
    </div>
  );
};
