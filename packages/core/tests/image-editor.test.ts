import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ImageEditorController,
  ImageEditorRenderer,
  DEFAULT_ADJUSTMENTS,
  DEFAULT_TRANSFORM,
  DEFAULT_DEPTH_MASK,
  applyAdjustments,
  applyDepthMask,
  removeAlpha,
  getViewportMetrics,
  canvasToImagePoint,
  imageToCanvasPoint,
  hitTestCrop,
  getCropCursor,
  calculateCropDrag,
  hitTestAnnotation,
  getAnnotationBounds,
  type ImageAdjustments,
  type DepthMaskOptions,
  type RectAnnotation,
  type PenAnnotation,
} from '../src/image-editor';

describe('ImageEditorController - Core State & Operations', () => {
  it('initializes with default state when no options are provided', () => {
    const controller = new ImageEditorController();
    const state = controller.getState();

    expect(state.crop).toBeNull();
    expect(state.transform).toEqual(DEFAULT_TRANSFORM);
    expect(state.adjustments).toEqual(DEFAULT_ADJUSTMENTS);
    expect(state.depthMask).toEqual(DEFAULT_DEPTH_MASK);
    expect(state.annotations).toEqual([]);
    expect(state.activeTool).toBe('select');
    expect(state.zoom).toBe(1);
    expect(state.pan).toEqual({ x: 0, y: 0 });
    expect(controller.canUndo).toBe(false);
    expect(controller.canRedo).toBe(false);
  });

  it('subscribes to state updates and notifies listeners', () => {
    const controller = new ImageEditorController();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);

    // Initial emission on subscribe
    expect(listener).toHaveBeenCalledTimes(1);

    controller.setTool('pen');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(controller.getState().activeTool).toBe('pen');

    unsubscribe();
    controller.setTool('rect');
    expect(listener).toHaveBeenCalledTimes(2); // No new call after unsubscribe
  });

  describe('Transformations (Rotate & Flip)', () => {
    it('rotates incrementally and normalizes degrees to 0-359', () => {
      const controller = new ImageEditorController();
      controller.rotate(90);
      expect(controller.getState().transform.rotate).toBe(90);

      controller.rotate(180);
      expect(controller.getState().transform.rotate).toBe(270);

      controller.rotate(120);
      expect(controller.getState().transform.rotate).toBe(30); // 390 % 360
    });

    it('toggles horizontal and vertical flips', () => {
      const controller = new ImageEditorController();
      expect(controller.getState().transform.flipH).toBe(false);
      expect(controller.getState().transform.flipV).toBe(false);

      controller.flipHorizontal();
      expect(controller.getState().transform.flipH).toBe(true);

      controller.flipVertical();
      expect(controller.getState().transform.flipV).toBe(true);

      controller.flipHorizontal();
      expect(controller.getState().transform.flipH).toBe(false);
    });
  });

  describe('Cropping', () => {
    it('sets and resets crop box coordinates', () => {
      const controller = new ImageEditorController();
      controller.setCrop({ x: 10, y: 20, width: 200, height: 150 });

      expect(controller.getState().crop).toEqual({ x: 10, y: 20, width: 200, height: 150 });

      controller.resetCrop();
      expect(controller.getState().crop).toBeNull();
    });

    it('applies crop aspect ratio presets accurately', () => {
      const controller = new ImageEditorController();
      // Default dimensions are 800x600
      // 1:1 aspect ratio should fit 600x600 centered horizontally at x: 100
      controller.applyCropPreset(1);
      const crop1 = controller.getState().crop!;
      expect(crop1.width).toBe(600);
      expect(crop1.height).toBe(600);
      expect(crop1.x).toBe(100);
      expect(crop1.y).toBe(0);

      // 16:9 aspect ratio in 800x600 -> width 800, height 800 / (16/9) = 450, y: (600 - 450)/2 = 75
      controller.applyCropPreset(16 / 9);
      const crop16_9 = controller.getState().crop!;
      expect(crop16_9.width).toBe(800);
      expect(crop16_9.height).toBe(450);
      expect(crop16_9.x).toBe(0);
      expect(crop16_9.y).toBe(75);

      // Null preset (freeform) resets to full 800x600
      controller.applyCropPreset(null);
      const cropFree = controller.getState().crop!;
      expect(cropFree.width).toBe(800);
      expect(cropFree.height).toBe(600);
      expect(cropFree.x).toBe(0);
      expect(cropFree.y).toBe(0);
    });
  });

  describe('Adjustments & Filters', () => {
    it('updates adjustments partially and resets them', () => {
      const controller = new ImageEditorController();
      controller.setAdjustments({ brightness: 25, contrast: -10, exposure: 15 });

      expect(controller.getState().adjustments.brightness).toBe(25);
      expect(controller.getState().adjustments.contrast).toBe(-10);
      expect(controller.getState().adjustments.exposure).toBe(15);
      expect(controller.getState().adjustments.saturation).toBe(0); // preserved

      controller.resetAdjustments();
      expect(controller.getState().adjustments).toEqual(DEFAULT_ADJUSTMENTS);
    });
  });

  describe('Depth Masking (Gleamforge parity)', () => {
    it('manages depth mask configuration', () => {
      const controller = new ImageEditorController();
      controller.setDepthMask({
        enabled: true,
        mode: 'threshold',
        depthRange: [50, 200],
        softness: 15,
        invert: true,
        maskSource: 'https://example.com/depth.png',
      });

      const dm = controller.getState().depthMask;
      expect(dm.enabled).toBe(true);
      expect(dm.mode).toBe('threshold');
      expect(dm.depthRange).toEqual([50, 200]);
      expect(dm.softness).toBe(15);
      expect(dm.invert).toBe(true);
      expect(dm.maskSource).toBe('https://example.com/depth.png');

      controller.resetDepthMask();
      expect(controller.getState().depthMask).toEqual(DEFAULT_DEPTH_MASK);
    });
  });

  describe('Annotations & Layers', () => {
    it('adds, updates, selects, and removes annotations', () => {
      const controller = new ImageEditorController();

      const rectId = controller.addAnnotation({
        type: 'rect',
        x: 50,
        y: 60,
        width: 100,
        height: 80,
        strokeColor: '#ff0000',
        strokeWidth: 2,
        fillColor: '#00ff00',
      });

      expect(controller.getState().annotations).toHaveLength(1);
      expect(controller.getState().selectedAnnotationId).toBe(rectId);

      const penId = controller.addAnnotation({
        type: 'pen',
        x: 0,
        y: 0,
        points: [{ x: 10, y: 10 }, { x: 20, y: 20 }],
        strokeColor: '#0000ff',
        strokeWidth: 4,
      });

      expect(controller.getState().annotations).toHaveLength(2);
      expect(controller.getState().selectedAnnotationId).toBe(penId);

      // Update annotation
      controller.updateAnnotation(rectId, { x: 75, width: 120 });
      const updatedRect = controller.getState().annotations.find((a) => a.id === rectId) as RectAnnotation;
      expect(updatedRect.x).toBe(75);
      expect(updatedRect.width).toBe(120);

      // Selection
      controller.selectAnnotation(rectId);
      expect(controller.getState().selectedAnnotationId).toBe(rectId);

      // Remove annotation
      controller.removeAnnotation(rectId);
      expect(controller.getState().annotations).toHaveLength(1);
      expect(controller.getState().selectedAnnotationId).toBeNull();

      // Clear all annotations
      controller.clearAnnotations();
      expect(controller.getState().annotations).toHaveLength(0);
    });
  });

  describe('History (Undo, Redo, Reset)', () => {
    it('records state transitions and performs undo/redo correctly', () => {
      const controller = new ImageEditorController();

      expect(controller.canUndo).toBe(false);
      expect(controller.canRedo).toBe(false);

      controller.rotate(90);
      expect(controller.canUndo).toBe(true);
      expect(controller.canRedo).toBe(false);
      expect(controller.getState().transform.rotate).toBe(90);

      controller.rotate(90);
      expect(controller.getState().transform.rotate).toBe(180);

      // Undo once
      const undone1 = controller.undo();
      expect(undone1).toBe(true);
      expect(controller.getState().transform.rotate).toBe(90);
      expect(controller.canRedo).toBe(true);

      // Undo twice
      const undone2 = controller.undo();
      expect(undone2).toBe(true);
      expect(controller.getState().transform.rotate).toBe(0);

      // Redo once
      const redone = controller.redo();
      expect(redone).toBe(true);
      expect(controller.getState().transform.rotate).toBe(90);

      // Branching: making new change clears redo stack
      controller.flipHorizontal();
      expect(controller.canRedo).toBe(false);
    });

    it('resets back to initial snapshot', () => {
      const controller = new ImageEditorController();
      controller.rotate(90);
      controller.setAdjustments({ brightness: 40 });
      controller.addAnnotation({
        type: 'line',
        x: 0,
        y: 0,
        endX: 100,
        endY: 100,
        strokeColor: '#000',
        strokeWidth: 2,
      });

      expect(controller.getState().transform.rotate).toBe(90);
      expect(controller.getState().adjustments.brightness).toBe(40);
      expect(controller.getState().annotations).toHaveLength(1);

      controller.reset();

      expect(controller.getState().transform.rotate).toBe(0);
      expect(controller.getState().adjustments.brightness).toBe(0);
      expect(controller.getState().annotations).toHaveLength(0);
    });
  });

  describe('State Serialization & Resume', () => {
    it('exports to JSON and restores saved state faithfully', () => {
      const controller = new ImageEditorController();
      controller.setCrop({ x: 15, y: 25, width: 300, height: 200 });
      controller.rotate(180);
      controller.flipVertical();
      controller.setAdjustments({ saturation: 50, temperature: 20 });
      controller.setDepthMask({ enabled: true, mode: 'brightness', depthRange: [10, 200], softness: 8, invert: false, maskSource: null });
      controller.addAnnotation({
        type: 'text',
        x: 40,
        y: 80,
        text: 'Hello World',
        fontSize: 24,
        color: '#ffffff',
      });

      const serialized = controller.toJSON();
      expect(serialized.version).toBe(1);
      expect(serialized.crop).toEqual({ x: 15, y: 25, width: 300, height: 200 });
      expect(serialized.transform.rotate).toBe(180);
      expect(serialized.transform.flipV).toBe(true);
      expect(serialized.adjustments.saturation).toBe(50);
      expect(serialized.annotations).toHaveLength(1);

      // Create new editor and restore
      const restoredController = new ImageEditorController();
      restoredController.loadJSON(serialized);

      const restoredState = restoredController.getState();
      expect(restoredState.crop).toEqual({ x: 15, y: 25, width: 300, height: 200 });
      expect(restoredState.transform.rotate).toBe(180);
      expect(restoredState.transform.flipV).toBe(true);
      expect(restoredState.adjustments.saturation).toBe(50);
      expect(restoredState.depthMask.enabled).toBe(true);
      expect(restoredState.annotations).toHaveLength(1);
      expect((restoredState.annotations[0] as any).text).toBe('Hello World');
    });
  });

  describe('Zoom, Pan, and Compare Mode', () => {
    it('handles zooming in, zooming out, clamping, and resetting', () => {
      const controller = new ImageEditorController();
      expect(controller.getState().zoom).toBe(1);

      controller.zoomIn(1.5);
      expect(controller.getState().zoom).toBe(1.5);

      controller.zoomOut(1.5);
      expect(controller.getState().zoom).toBe(1);

      controller.setZoom(100); // Exceeds clamp max (10)
      expect(controller.getState().zoom).toBe(10);

      controller.setZoom(0.01); // Subceeds clamp min (0.1)
      expect(controller.getState().zoom).toBe(0.1);

      controller.resetZoom();
      expect(controller.getState().zoom).toBe(1);
      expect(controller.getState().pan).toEqual({ x: 0, y: 0 });
    });

    it('toggles compare mode', () => {
      const controller = new ImageEditorController();
      expect(controller.getState().isOriginalCompared).toBe(false);

      controller.setComparing(true);
      expect(controller.getState().isOriginalCompared).toBe(true);

      controller.setComparing(false);
      expect(controller.getState().isOriginalCompared).toBe(false);
    });
  });
});

describe('Pixel Filters & Masking Functions', () => {
  // Helper to create synthetic ImageData
  function createTestImageData(width: number, height: number, fillR = 100, fillG = 100, fillB = 100, fillA = 255): ImageData {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = fillR;
      data[i + 1] = fillG;
      data[i + 2] = fillB;
      data[i + 3] = fillA;
    }
    return {
      width,
      height,
      data,
      colorSpace: 'srgb',
    } as ImageData;
  }

  it('adjusts brightness and contrast properly on ImageData', () => {
    const imgData = createTestImageData(2, 2, 100, 100, 100, 255);
    const adjustments: ImageAdjustments = {
      ...DEFAULT_ADJUSTMENTS,
      brightness: 20, // + 51
    };
    applyAdjustments(imgData, adjustments);

    // 100 + (20 * 2.55) = 151
    expect(imgData.data[0]).toBe(151);
    expect(imgData.data[1]).toBe(151);
    expect(imgData.data[2]).toBe(151);
    expect(imgData.data[3]).toBe(255);
  });

  it('adjusts temperature (warmth/coolness)', () => {
    const imgData = createTestImageData(2, 2, 100, 100, 100, 255);
    const adjustments: ImageAdjustments = {
      ...DEFAULT_ADJUSTMENTS,
      temperature: 30, // warm: red increases by 24, blue decreases by 24
    };
    applyAdjustments(imgData, adjustments);

    expect(imgData.data[0]).toBe(124); // Red increased
    expect(imgData.data[2]).toBe(76);  // Blue decreased
  });

  it('adjusts opacity on ImageData', () => {
    const imgData = createTestImageData(2, 2, 100, 100, 100, 200);
    const adjustments: ImageAdjustments = {
      ...DEFAULT_ADJUSTMENTS,
      opacity: 0.5,
    };
    applyAdjustments(imgData, adjustments);

    expect(imgData.data[3]).toBe(100);
  });

  it('applies depth mask with threshold mode and softness (Gleamforge)', () => {
    const mainImg = createTestImageData(2, 2, 255, 255, 255, 255);
    // Mask with 4 different depth values: [20, 70, 150, 240]
    const maskImg = createTestImageData(2, 2, 0, 0, 0, 255);
    maskImg.data[0] = 20;   // below depthRange[0] (50) - softness (10) -> alpha 0
    maskImg.data[4] = 70;   // inside [50, 200] -> alpha 255
    maskImg.data[8] = 150;  // inside [50, 200] -> alpha 255
    maskImg.data[12] = 240; // above depthRange[1] (200) + softness (10) -> alpha 0

    const options: DepthMaskOptions = {
      enabled: true,
      maskSource: null,
      mode: 'threshold',
      depthRange: [50, 200],
      softness: 10,
      invert: false,
    };

    applyDepthMask(mainImg, maskImg, options);

    expect(mainImg.data[3]).toBe(0);   // pixel 0 below threshold
    expect(mainImg.data[7]).toBe(255); // pixel 1 inside
    expect(mainImg.data[11]).toBe(255);// pixel 2 inside
    expect(mainImg.data[15]).toBe(0);  // pixel 3 above threshold
  });

  it('removes alpha channel making all pixels 100% opaque (removeAlpha)', () => {
    const imgData = createTestImageData(2, 2, 100, 100, 100, 50);
    expect(imgData.data[3]).toBe(50);

    removeAlpha(imgData);
    expect(imgData.data[3]).toBe(255);
    expect(imgData.data[7]).toBe(255);
    expect(imgData.data[11]).toBe(255);
    expect(imgData.data[15]).toBe(255);
  });
});

describe('ImageEditorRenderer - Transformation Dimensions & Viewport Stability', () => {
  it('swaps width and height on 90 degree and 270 degree rotation during export', async () => {
    const renderer = new ImageEditorRenderer();
    const controller = new ImageEditorController();
    
    // Create synthetic 800x400 canvas image source
    const mockSource = {
      width: 800,
      height: 400,
      naturalWidth: 800,
      naturalHeight: 400,
    } as unknown as HTMLCanvasElement;

    controller.rotate(90);
    const canvas90 = await renderer.renderExport(mockSource, controller.getState());
    expect(canvas90.width).toBe(400);
    expect(canvas90.height).toBe(800);

    controller.rotate(90); // 180 degrees
    const canvas180 = await renderer.renderExport(mockSource, controller.getState());
    expect(canvas180.width).toBe(800);
    expect(canvas180.height).toBe(400);

    controller.rotate(90); // 270 degrees
    const canvas270 = await renderer.renderExport(mockSource, controller.getState());
    expect(canvas270.width).toBe(400);
    expect(canvas270.height).toBe(800);
  });

  it('preserves viewport resolution across consecutive action renders without zoom drift', async () => {
    const renderer = new ImageEditorRenderer();
    const controller = new ImageEditorController();
    const targetCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({
        clearRect: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
        scale: vi.fn(),
        drawImage: vi.fn(),
        beginPath: vi.fn(),
        stroke: vi.fn(),
        fill: vi.fn(),
      })),
    } as unknown as HTMLCanvasElement;

    const mockSource = {
      width: 1200,
      height: 800,
      naturalWidth: 1200,
      naturalHeight: 800,
    } as unknown as HTMLCanvasElement;

    // Fixed container viewport size (e.g. 800x540)
    const viewport = { viewportWidth: 800, viewportHeight: 540 };

    // Initial render
    await renderer.renderToCanvas(targetCanvas, mockSource, controller.getState(), viewport);
    expect(targetCanvas.width).toBe(800);
    expect(targetCanvas.height).toBe(540);

    // Consecutive actions: adjustments, rotation, annotations
    controller.setAdjustments({ brightness: 20 });
    await renderer.renderToCanvas(targetCanvas, mockSource, controller.getState(), viewport);
    expect(targetCanvas.width).toBe(800);
    expect(targetCanvas.height).toBe(540);

    controller.setAdjustments({ contrast: 15 });
    await renderer.renderToCanvas(targetCanvas, mockSource, controller.getState(), viewport);
    expect(targetCanvas.width).toBe(800);
    expect(targetCanvas.height).toBe(540);

    // Zoom state should remain unchanged unless explicitly set
    expect(controller.getState().zoom).toBe(1);
  });

  it('renders crop overlay grid and handles when showCropOverlay is true without active dragging', async () => {
    const renderer = new ImageEditorRenderer();
    const controller = new ImageEditorController();
    let strokeRectCalled = false;
    const targetCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({
        clearRect: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
        scale: vi.fn(),
        drawImage: vi.fn(),
        beginPath: vi.fn(),
        stroke: vi.fn(),
        fill: vi.fn(),
        fillRect: vi.fn(),
        strokeRect: vi.fn(() => {
          strokeRectCalled = true;
        }),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        arc: vi.fn(),
      })),
    } as unknown as HTMLCanvasElement;

    const mockSource = {
      width: 1200,
      height: 800,
      naturalWidth: 1200,
      naturalHeight: 800,
    } as unknown as HTMLCanvasElement;

    await renderer.renderToCanvas(targetCanvas, mockSource, controller.getState(), {
      viewportWidth: 800,
      viewportHeight: 540,
      showCropOverlay: true,
      draftCrop: null,
    });

    expect(strokeRectCalled).toBe(true);
  });
});

describe('ImageEditor Geometry & Interactive Transformations', () => {
  it('converts points bidirectionally between canvas and image coordinates', () => {
    const controller = new ImageEditorController();
    const state = controller.getState(); // default dimensions: 800x600
    const vpW = 800;
    const vpH = 600;

    // Test center point (image center is 400, 300)
    const imgCenter = { x: 400, y: 300 };
    const canvasCenter = imageToCanvasPoint(imgCenter, state, vpW, vpH, false);
    expect(canvasCenter.x).toBeCloseTo(400, 1);
    expect(canvasCenter.y).toBeCloseTo(300, 1);

    const invertedCenter = canvasToImagePoint(canvasCenter, state, vpW, vpH, false);
    expect(invertedCenter.x).toBeCloseTo(400, 1);
    expect(invertedCenter.y).toBeCloseTo(300, 1);

    // Test with zoom and pan
    controller.setZoom(1.5);
    controller.setPan({ x: 50, y: -30 });
    const zoomedState = controller.getState();

    const canvasPt = imageToCanvasPoint({ x: 200, y: 300 }, zoomedState, vpW, vpH, false);
    const roundTripImgPt = canvasToImagePoint(canvasPt, zoomedState, vpW, vpH, false);

    expect(roundTripImgPt.x).toBeCloseTo(200, 1);
    expect(roundTripImgPt.y).toBeCloseTo(300, 1);
  });

  describe('Crop hit testing and cursor resolution', () => {
    it('detects crop box handles and interior correctly', () => {
      const controller = new ImageEditorController({
        dimensions: { width: 1000, height: 1000 },
      });
      controller.setCrop({ x: 200, y: 200, width: 400, height: 400 });
      const state = controller.getState();
      const vpW = 800;
      const vpH = 800;

      // nw corner
      const nwCanvas = imageToCanvasPoint({ x: 200, y: 200 }, state, vpW, vpH, true);
      expect(hitTestCrop(nwCanvas, state, vpW, vpH)).toBe('nw');
      expect(getCropCursor('nw')).toBe('nwse-resize');

      // se corner
      const seCanvas = imageToCanvasPoint({ x: 600, y: 600 }, state, vpW, vpH, true);
      expect(hitTestCrop(seCanvas, state, vpW, vpH)).toBe('se');
      expect(getCropCursor('se')).toBe('nwse-resize');

      // ne corner
      const neCanvas = imageToCanvasPoint({ x: 600, y: 200 }, state, vpW, vpH, true);
      expect(hitTestCrop(neCanvas, state, vpW, vpH)).toBe('ne');
      expect(getCropCursor('ne')).toBe('nesw-resize');

      // sw corner
      const swCanvas = imageToCanvasPoint({ x: 200, y: 600 }, state, vpW, vpH, true);
      expect(hitTestCrop(swCanvas, state, vpW, vpH)).toBe('sw');
      expect(getCropCursor('sw')).toBe('nesw-resize');

      // Edge midpoints
      const nCanvas = imageToCanvasPoint({ x: 400, y: 200 }, state, vpW, vpH, true);
      expect(hitTestCrop(nCanvas, state, vpW, vpH)).toBe('n');
      expect(getCropCursor('n')).toBe('ns-resize');

      const sCanvas = imageToCanvasPoint({ x: 400, y: 600 }, state, vpW, vpH, true);
      expect(hitTestCrop(sCanvas, state, vpW, vpH)).toBe('s');
      expect(getCropCursor('s')).toBe('ns-resize');

      const eCanvas = imageToCanvasPoint({ x: 600, y: 400 }, state, vpW, vpH, true);
      expect(hitTestCrop(eCanvas, state, vpW, vpH)).toBe('e');
      expect(getCropCursor('e')).toBe('ew-resize');

      const wCanvas = imageToCanvasPoint({ x: 200, y: 400 }, state, vpW, vpH, true);
      expect(hitTestCrop(wCanvas, state, vpW, vpH)).toBe('w');
      expect(getCropCursor('w')).toBe('ew-resize');

      // Inside crop box
      const centerCanvas = imageToCanvasPoint({ x: 400, y: 400 }, state, vpW, vpH, true);
      expect(hitTestCrop(centerCanvas, state, vpW, vpH)).toBe('inside');
      expect(getCropCursor('inside')).toBe('move');

      // Far outside crop box
      const outsideCanvas = imageToCanvasPoint({ x: 50, y: 50 }, state, vpW, vpH, true);
      expect(hitTestCrop(outsideCanvas, state, vpW, vpH)).toBeNull();
      expect(getCropCursor(null)).toBe('crosshair');
    });

    it('defaults to full image crop bounds when state.crop is null and isActivelyCropping is true', () => {
      const controller = new ImageEditorController();
      const state = controller.getState(); // crop is null initially
      const vpW = 800;
      const vpH = 600;

      const metrics = getViewportMetrics(state, vpW, vpH, true);
      expect(metrics.cropRect).not.toBeNull();
      expect(metrics.cropRect?.width).toBeGreaterThan(0);
      expect(metrics.cropRect?.height).toBeGreaterThan(0);

      // Hit testing top-left corner of uncropped image should detect nw handle
      const nwCanvas = imageToCanvasPoint({ x: 0, y: 0 }, state, vpW, vpH, true);
      expect(hitTestCrop(nwCanvas, state, vpW, vpH)).toBe('nw');
    });
  });

  describe('calculateCropDrag', () => {
    const initialCrop = { x: 100, y: 100, width: 300, height: 200 };

    it('translates the crop box when moving inside', () => {
      const updated = calculateCropDrag(
        initialCrop,
        'inside',
        { x: 150, y: 150 },
        { x: 180, y: 170 }, // dx: +30, dy: +20
        1000,
        1000
      );

      expect(updated.x).toBe(130);
      expect(updated.y).toBe(120);
      expect(updated.width).toBe(300);
      expect(updated.height).toBe(200);
    });

    it('clamps translation to stay within image boundaries', () => {
      const updated = calculateCropDrag(
        initialCrop,
        'inside',
        { x: 150, y: 150 },
        { x: -500, y: -500 },
        1000,
        1000
      );

      expect(updated.x).toBe(0);
      expect(updated.y).toBe(0);
      expect(updated.width).toBe(300);
      expect(updated.height).toBe(200);
    });

    it('resizes crop box from southeast handle', () => {
      const updated = calculateCropDrag(
        initialCrop,
        'se',
        { x: 400, y: 300 },
        { x: 450, y: 340 }, // dx: +50, dy: +40
        1000,
        1000
      );

      expect(updated.x).toBe(100);
      expect(updated.y).toBe(100);
      expect(updated.width).toBe(350);
      expect(updated.height).toBe(240);
    });

    it('maintains aspect ratio when aspectRatio is locked', () => {
      const squareCrop = { x: 100, y: 100, width: 200, height: 200 };
      const updated = calculateCropDrag(
        squareCrop,
        'se',
        { x: 300, y: 300 },
        { x: 400, y: 340 }, // dx: +100, dy: +40 -> dx determines scale (100)
        1000,
        1000,
        1.0 // 1:1 square ratio
      );

      expect(updated.width).toBe(300);
      expect(updated.height).toBe(300);
    });
  });

  describe('hitTestAnnotation & getAnnotationBounds', () => {
    it('hit tests rect annotations accurately', () => {
      const rectAnn: RectAnnotation = {
        id: 'r1',
        type: 'rect',
        x: 100,
        y: 100,
        width: 200,
        height: 150,
      };

      expect(hitTestAnnotation({ x: 150, y: 150 }, rectAnn)).toBe(true);
      expect(hitTestAnnotation({ x: 50, y: 50 }, rectAnn)).toBe(false);
      expect(getAnnotationBounds(rectAnn)).toEqual({ x: 100, y: 100, width: 200, height: 150 });
    });

    it('hit tests pen stroke annotations accurately', () => {
      const penAnn: PenAnnotation = {
        id: 'p1',
        type: 'pen',
        x: 0,
        y: 0,
        points: [
          { x: 10, y: 10 },
          { x: 50, y: 50 },
          { x: 100, y: 50 },
        ],
        strokeWidth: 4,
      };

      // Near a vertex / line segment
      expect(hitTestAnnotation({ x: 52, y: 51 }, penAnn, 8)).toBe(true);
      // Far away
      expect(hitTestAnnotation({ x: 300, y: 300 }, penAnn, 8)).toBe(false);

      const bounds = getAnnotationBounds(penAnn);
      expect(bounds.x).toBe(10);
      expect(bounds.y).toBe(10);
      expect(bounds.width).toBe(90);
      expect(bounds.height).toBe(40);
    });
  });
});

