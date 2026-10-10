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

export function createReactiveImageEditor(options: ImageEditorOptions = {}) {
  const controller = new ImageEditorController(options);
  let state = $state<ImageEditorState>(controller.getState());
  let historyTicks = $state<number>(0);

  controller.subscribe((updated) => {
    state = { ...updated };
    historyTicks++;
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
    applyInpaintedImage(newDataUrl: string) {
      return controller.applyInpaintedImage(newDataUrl);
    },
    applyBackgroundRemovedImage(newDataUrl: string) {
      return controller.applyBackgroundRemovedImage(newDataUrl);
    },
  };
}

export type ReactiveImageEditor = ReturnType<typeof createReactiveImageEditor>;
