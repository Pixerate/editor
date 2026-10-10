import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import {
  ImageEditorController,
  type ImageEditorOptions,
  type ImageEditorState,
  type ImageEditorTool,
  type CropBox,
  type AspectRatio,
  type ImageAdjustments,
  type DepthMaskOptions,
  type Annotation,
  type CreateAnnotationPayload,
  type ExportOptions,
  type SerializedImageEditorState,
  type ImagePoint,
} from '@pixerate/editor/image-editor';

export interface UseImageEditorReturn {
  controller: ImageEditorController;
  state: ImageEditorState;
  canUndo: boolean;
  canRedo: boolean;
  setTool: (tool: ImageEditorTool) => void;
  setCrop: (crop: CropBox | null, addToHistory?: boolean) => void;
  applyCropPreset: (ratio: AspectRatio) => void;
  resetCrop: () => void;
  rotate: (degrees: number) => void;
  setRotation: (degrees: number) => void;
  flipHorizontal: () => void;
  flipVertical: () => void;
  setAdjustments: (partial: Partial<ImageAdjustments>, commitToHistory?: boolean) => void;
  resetAdjustments: () => void;
  setDepthMask: (partial: Partial<DepthMaskOptions>) => void;
  resetDepthMask: () => void;
  addAnnotation: (annotation: CreateAnnotationPayload) => string;
  updateAnnotation: (id: string, partial: Partial<Annotation>, commitToHistory?: boolean) => void;
  removeAnnotation: (id: string) => void;
  clearAnnotations: () => void;
  selectAnnotation: (id: string | null) => void;
  undo: () => boolean;
  redo: () => boolean;
  reset: () => void;
  zoomIn: (factor?: number) => void;
  zoomOut: (factor?: number) => void;
  resetZoom: () => void;
  setZoom: (zoom: number) => void;
  setPan: (pan: ImagePoint) => void;
  setComparing: (comparing: boolean) => void;
  loadImage: (src: string | HTMLImageElement) => Promise<void>;
  toDataURL: (options?: ExportOptions) => Promise<string>;
  toBlob: (options?: ExportOptions) => Promise<Blob>;
  toJSON: () => SerializedImageEditorState;
  loadJSON: (data: SerializedImageEditorState) => void;
  renderMask: (options?: { useAnnotations?: boolean; useCrop?: boolean }) => Promise<HTMLCanvasElement>;
  toMaskDataURL: (options?: { useAnnotations?: boolean; useCrop?: boolean }) => Promise<string>;
  applyInpaintedImage: (newDataUrl: string) => Promise<void>;
  applyBackgroundRemovedImage: (newDataUrl: string) => Promise<void>;
}

export function useImageEditor(options: ImageEditorOptions = {}): UseImageEditorReturn {
  const controllerRef = useRef<ImageEditorController | null>(null);

  if (!controllerRef.current) {
    controllerRef.current = new ImageEditorController(options);
  }

  const controller = controllerRef.current;
  const [state, setState] = useState<ImageEditorState>(() => controller.getState());
  const [historyTicks, setHistoryTicks] = useState(0);

  useEffect(() => {
    const unsub = controller.subscribe((next) => {
      setState(next);
      setHistoryTicks((t) => t + 1);
    });
    return unsub;
  }, [controller]);

  useEffect(() => {
    if (options.image && options.image !== state.sourceUrl) {
      controller.loadImage(options.image);
    }
  }, [options.image, controller, state.sourceUrl]);

  const setTool = useCallback((tool: ImageEditorTool) => controller.setTool(tool), [controller]);
  const setCrop = useCallback(
    (crop: CropBox | null, addToHistory = true) => controller.setCrop(crop, addToHistory),
    [controller]
  );
  const applyCropPreset = useCallback((ratio: AspectRatio) => controller.applyCropPreset(ratio), [controller]);
  const resetCrop = useCallback(() => controller.resetCrop(), [controller]);
  const rotate = useCallback((deg: number) => controller.rotate(deg), [controller]);
  const setRotation = useCallback((deg: number) => controller.setRotation(deg), [controller]);
  const flipHorizontal = useCallback(() => controller.flipHorizontal(), [controller]);
  const flipVertical = useCallback(() => controller.flipVertical(), [controller]);
  const setAdjustments = useCallback(
    (partial: Partial<ImageAdjustments>, commitToHistory = true) =>
      controller.setAdjustments(partial, commitToHistory),
    [controller]
  );
  const resetAdjustments = useCallback(() => controller.resetAdjustments(), [controller]);
  const setDepthMask = useCallback((partial: Partial<DepthMaskOptions>) => controller.setDepthMask(partial), [controller]);
  const resetDepthMask = useCallback(() => controller.resetDepthMask(), [controller]);
  const addAnnotation = useCallback((ann: CreateAnnotationPayload) => controller.addAnnotation(ann), [controller]);
  const updateAnnotation = useCallback(
    (id: string, partial: Partial<Annotation>, commitToHistory = true) =>
      controller.updateAnnotation(id, partial, commitToHistory),
    [controller]
  );
  const removeAnnotation = useCallback((id: string) => controller.removeAnnotation(id), [controller]);
  const clearAnnotations = useCallback(() => controller.clearAnnotations(), [controller]);
  const selectAnnotation = useCallback((id: string | null) => controller.selectAnnotation(id), [controller]);
  const undo = useCallback(() => controller.undo(), [controller]);
  const redo = useCallback(() => controller.redo(), [controller]);
  const reset = useCallback(() => controller.reset(), [controller]);
  const zoomIn = useCallback((factor?: number) => controller.zoomIn(factor), [controller]);
  const zoomOut = useCallback((factor?: number) => controller.zoomOut(factor), [controller]);
  const resetZoom = useCallback(() => controller.resetZoom(), [controller]);
  const setZoom = useCallback((zoom: number) => controller.setZoom(zoom), [controller]);
  const setPan = useCallback((pan: ImagePoint) => controller.setPan(pan), [controller]);
  const setComparing = useCallback((comp: boolean) => controller.setComparing(comp), [controller]);
  const loadImage = useCallback((src: string | HTMLImageElement) => controller.loadImage(src), [controller]);
  const toDataURL = useCallback((opts?: ExportOptions) => controller.toDataURL(opts), [controller]);
  const toBlob = useCallback((opts?: ExportOptions) => controller.toBlob(opts), [controller]);
  const toJSON = useCallback(() => controller.toJSON(), [controller]);
  const loadJSON = useCallback((data: SerializedImageEditorState) => controller.loadJSON(data), [controller]);
  const renderMask = useCallback(
    (opts?: { useAnnotations?: boolean; useCrop?: boolean }) => controller.renderMask(opts),
    [controller]
  );
  const toMaskDataURL = useCallback(
    (opts?: { useAnnotations?: boolean; useCrop?: boolean }) => controller.toMaskDataURL(opts),
    [controller]
  );
  const applyInpaintedImage = useCallback(
    (newDataUrl: string) => controller.applyInpaintedImage(newDataUrl),
    [controller]
  );
  const applyBackgroundRemovedImage = useCallback(
    (newDataUrl: string) => controller.applyBackgroundRemovedImage(newDataUrl),
    [controller]
  );

  return useMemo(
    () => ({
      controller,
      state,
      canUndo: controller.canUndo,
      canRedo: controller.canRedo,
      setTool,
      setCrop,
      applyCropPreset,
      resetCrop,
      rotate,
      setRotation,
      flipHorizontal,
      flipVertical,
      setAdjustments,
      resetAdjustments,
      setDepthMask,
      resetDepthMask,
      addAnnotation,
      updateAnnotation,
      removeAnnotation,
      clearAnnotations,
      selectAnnotation,
      undo,
      redo,
      reset,
      zoomIn,
      zoomOut,
      resetZoom,
      setZoom,
      setPan,
      setComparing,
      loadImage,
      toDataURL,
      toBlob,
      toJSON,
      loadJSON,
      renderMask,
      toMaskDataURL,
      applyInpaintedImage,
      applyBackgroundRemovedImage,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [controller, state, historyTicks]
  );
}
