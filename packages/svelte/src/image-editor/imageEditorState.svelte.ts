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
  type AIResultOptions,
  type ImagePoint,
  type AdjustmentKind,
  type AdjustmentLayerInit,
  type AdjustmentLayerUpdate,
  type ImageHistogram,
} from '@pixerate/editor/image-editor';

export function createReactiveImageEditor(options: ImageEditorOptions = {}) {
  const controller = new ImageEditorController(options);
  let state = $state<ImageEditorState>(controller.getState());
  let historyTicks = $state<number>(0);

  let histogram = $state.raw<ImageHistogram | null>(controller.getHistogram());

  const unsubscribe = controller.subscribe((updated) => {
    state = { ...updated };
    historyTicks++;
  });
  const unsubscribeHistogram = controller.subscribeHistogram((h) => {
    histogram = h;
  });

  return {
    get controller() {
      return controller;
    },
    get state() {
      return state;
    },
    get canUndo() {
      // depend on historyTicks for reactivity
      void historyTicks;
      return controller.canUndo;
    },
    /** Histogram of the last rendered preview (after adjustments and layers); null before a render. */
    get histogram() {
      return histogram;
    },
    get canRedo() {
      void historyTicks;
      return controller.canRedo;
    },
    setTool(tool: ImageEditorTool) {
      controller.setTool(tool);
    },
    setCrop(crop: CropBox | null, addToHistory = true) {
      controller.setCrop(crop, addToHistory);
    },
    applyCropPreset(ratio: AspectRatio) {
      controller.applyCropPreset(ratio);
    },
    resetCrop() {
      controller.resetCrop();
    },
    rotate(degrees: number) {
      controller.rotate(degrees);
    },
    setRotation(degrees: number) {
      controller.setRotation(degrees);
    },
    flipHorizontal() {
      controller.flipHorizontal();
    },
    flipVertical() {
      controller.flipVertical();
    },
    setAdjustments(partial: Partial<ImageAdjustments>, commitToHistory = true) {
      controller.setAdjustments(partial, commitToHistory);
    },
    resetAdjustments() {
      controller.resetAdjustments();
    },
    /** Update to Current Process: re-render the adjustments with the latest process (one undo step). */
    upgradeProcess() {
      return controller.upgradeProcess();
    },
    /** Adds an adjustment layer (one undo step) and returns its id. */
    addAdjustmentLayer(init: AdjustmentKind | AdjustmentLayerInit, index?: number) {
      return controller.addAdjustmentLayer(init, index);
    },
    updateAdjustmentLayer(id: string, update: AdjustmentLayerUpdate, commitToHistory = true) {
      return controller.updateAdjustmentLayer(id, update, commitToHistory);
    },
    removeAdjustmentLayer(id: string) {
      return controller.removeAdjustmentLayer(id);
    },
    moveAdjustmentLayer(id: string, toIndex: number) {
      return controller.moveAdjustmentLayer(id, toIndex);
    },
    toggleAdjustmentLayer(id: string, enabled?: boolean) {
      return controller.toggleAdjustmentLayer(id, enabled);
    },
    setDepthMask(partial: Partial<DepthMaskOptions>) {
      controller.setDepthMask(partial);
    },
    resetDepthMask() {
      controller.resetDepthMask();
    },
    addAnnotation(ann: CreateAnnotationPayload) {
      return controller.addAnnotation(ann);
    },
    updateAnnotation(id: string, partial: Partial<Annotation>, commitToHistory = true) {
      controller.updateAnnotation(id, partial, commitToHistory);
    },
    removeAnnotation(id: string) {
      controller.removeAnnotation(id);
    },
    clearAnnotations() {
      controller.clearAnnotations();
    },
    selectAnnotation(id: string | null) {
      controller.selectAnnotation(id);
    },
    undo() {
      return controller.undo();
    },
    redo() {
      return controller.redo();
    },
    reset() {
      controller.reset();
    },
    zoomIn(factor?: number) {
      controller.zoomIn(factor);
    },
    zoomOut(factor?: number) {
      controller.zoomOut(factor);
    },
    resetZoom() {
      controller.resetZoom();
    },
    setZoom(zoom: number) {
      controller.setZoom(zoom);
    },
    setPan(pan: ImagePoint) {
      controller.setPan(pan);
    },
    setComparing(comparing: boolean) {
      controller.setComparing(comparing);
    },
    loadImage(src: string | HTMLImageElement) {
      return controller.loadImage(src);
    },
    toDataURL(opts?: ExportOptions) {
      return controller.toDataURL(opts);
    },
    toBlob(opts?: ExportOptions) {
      return controller.toBlob(opts);
    },
    toJSON() {
      return controller.toJSON();
    },
    loadJSON(data: SerializedImageEditorState) {
      controller.loadJSON(data);
    },
    renderMask(opts?: { useAnnotations?: boolean; useCrop?: boolean }) {
      return controller.renderMask(opts);
    },
    toMaskDataURL(opts?: { useAnnotations?: boolean; useCrop?: boolean }) {
      return controller.toMaskDataURL(opts);
    },
    toSourceDataURL(opts?: Pick<ExportOptions, 'format' | 'quality'>) {
      return controller.toSourceDataURL(opts);
    },
    /** In documents with several layers (or `target: 'new-layer'`) the result goes to a new layer. */
    applyInpaintedImage(newDataUrl: string, options?: AIResultOptions) {
      return controller.applyInpaintedImage(newDataUrl, options);
    },
    /** In documents with several layers (or `target: 'new-layer'`) the result's alpha masks the active layer. */
    applyBackgroundRemovedImage(newDataUrl: string, options?: AIResultOptions) {
      return controller.applyBackgroundRemovedImage(newDataUrl, options);
    },
    /** Stops syncing controller state; call when the editor is no longer used. */
    destroy() {
      unsubscribe();
      unsubscribeHistogram();
    },
  };
}

export type ReactiveImageEditor = ReturnType<typeof createReactiveImageEditor>;

/** The preview histogram of an image editor controller as a rune (`current`), updated after every render. */
export function createImageHistogram(controller: ImageEditorController) {
  let current = $state.raw<ImageHistogram | null>(controller.getHistogram());
  const unsubscribe = controller.subscribeHistogram((h) => {
    current = h;
  });
  return {
    get current() {
      return current;
    },
    destroy() {
      unsubscribe();
    },
  };
}
