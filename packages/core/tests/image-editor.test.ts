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

  describe('AI Masking & Inpainting Controller Support', () => {
    it('generates binary mask canvas and data URL from crop or annotations', async () => {
      const controller = new ImageEditorController();
      controller.setCrop({ x: 20, y: 30, width: 100, height: 100 });
      controller.addAnnotation({
        type: 'rect',
        x: 10,
        y: 10,
        width: 50,
        height: 50,
      });

      const maskCanvas = await controller.renderMask({ useCrop: true, useAnnotations: true });
      expect(maskCanvas).toBeDefined();

      const maskDataUrl = await controller.toMaskDataURL({ useCrop: true, useAnnotations: true });
      expect(maskDataUrl).toBeDefined();
      expect(typeof maskDataUrl).toBe('string');
    });

    it('applies inpainted image, records history, and clears mask annotations', async () => {
      const controller = new ImageEditorController();
      controller.addAnnotation({
        type: 'pen',
        points: [{ x: 5, y: 5 }, { x: 10, y: 10 }],
      });
      expect(controller.getState().annotations.length).toBe(1);

      await controller.applyInpaintedImage('data:image/png;base64,mockInpaintedResult');
      expect(controller.getState().sourceUrl).toBe('data:image/png;base64,mockInpaintedResult');
      expect(controller.getState().annotations.length).toBe(0);
      expect(controller.canUndo).toBe(true);
    });

    it('applies background removed image and records history', async () => {
      const controller = new ImageEditorController();
      await controller.applyBackgroundRemovedImage('data:image/png;base64,mockTransparentForeground');
      expect(controller.getState().sourceUrl).toBe('data:image/png;base64,mockTransparentForeground');
      expect(controller.canUndo).toBe(true);
    });
  });
});



// ---------------------------------------------------------------------------
// Canonical coordinate space (natural image pixels) under rotate / flip / crop
// ---------------------------------------------------------------------------

type Call = { name: string; args: any[]; fillStyle?: unknown; strokeStyle?: unknown };

function makeRecordingCtx(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const ctx: any = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    globalAlpha: 1,
  };
  const methods = [
    'clearRect', 'save', 'restore', 'translate', 'scale', 'rotate', 'drawImage', 'beginPath',
    'stroke', 'fill', 'fillRect', 'strokeRect', 'moveTo', 'lineTo', 'rect', 'clip', 'closePath',
    'fillText', 'setLineDash', 'putImageData', 'arc',
  ];
  for (const m of methods) {
    ctx[m] = (...args: any[]) => {
      calls.push({ name: m, args, fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle });
    };
  }
  ctx.ellipse = (...args: any[]) => {
    // Mirror the real canvas: negative radii throw IndexSizeError.
    if (args[2] < 0 || args[3] < 0) throw new Error('IndexSizeError: negative radius');
    calls.push({ name: 'ellipse', args, fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle });
  };
  Object.assign(ctx, overrides);
  return { ctx, calls };
}

function fakeImage(src: string, width: number, height: number) {
  return { src, width, height, naturalWidth: width, naturalHeight: height, complete: true } as unknown as HTMLImageElement;
}

describe('Image editor geometry - canonical natural-image space', () => {
  const VP = 2000; // large viewport so fitScale === 1 for an 800x600 image
  const rotations = [0, 90, 180, 270];
  const flips = [
    { flipH: false, flipV: false },
    { flipH: true, flipV: false },
    { flipH: false, flipV: true },
    { flipH: true, flipV: true },
  ];
  const crops = [null, { x: 100, y: 50, width: 400, height: 300 }];

  function makeState(rotate: number, flipH: boolean, flipV: boolean, crop: any) {
    const controller = new ImageEditorController({ initialState: { transform: { rotate, flipH, flipV }, crop } });
    controller.setZoom(1.25);
    controller.setPan({ x: 13, y: -7 });
    return controller.getState();
  }

  for (const rotate of rotations) {
    for (const { flipH, flipV } of flips) {
      for (const crop of crops) {
        for (const active of [false, true]) {
          it(`round-trips points at ${rotate}deg flipH=${flipH} flipV=${flipV} crop=${!!crop} cropping=${active}`, () => {
            const state = makeState(rotate, flipH, flipV, crop);
            const imgPts = [
              { x: 0, y: 0 },
              { x: 123.25, y: 456.5 },
              { x: 800, y: 600 },
              { x: 37.5, y: 599 },
            ];
            for (const pt of imgPts) {
              const c = imageToCanvasPoint(pt, state, 1024, 768, active);
              const back = canvasToImagePoint(c, state, 1024, 768, active);
              expect(back.x).toBeCloseTo(pt.x, 6);
              expect(back.y).toBeCloseTo(pt.y, 6);
            }
            const canvasPt = { x: 311.5, y: 222.25 };
            const img = canvasToImagePoint(canvasPt, state, 1024, 768, active);
            const again = imageToCanvasPoint(img, state, 1024, 768, active);
            expect(again.x).toBeCloseTo(canvasPt.x, 6);
            expect(again.y).toBeCloseTo(canvasPt.y, 6);
          });
        }

        it(`maps the visible region's top-left to the right screen corner at ${rotate}deg flipH=${flipH} flipV=${flipV} crop=${!!crop}`, () => {
          const controller = new ImageEditorController({ initialState: { transform: { rotate, flipH, flipV }, crop } });
          const state = controller.getState();
          const m = getViewportMetrics(state, VP, VP, false);
          const r = m.imageRect;
          const corners = [
            { x: r.x, y: r.y }, // TL
            { x: r.x + r.width, y: r.y }, // TR
            { x: r.x + r.width, y: r.y + r.height }, // BR
            { x: r.x, y: r.y + r.height }, // BL
          ];
          // Flip happens in image space first, then clockwise quarter turns.
          const start = flipH && flipV ? 2 : flipH ? 1 : flipV ? 3 : 0;
          const expected = corners[(start + rotate / 90) % 4];
          const origin = crop ? { x: crop.x, y: crop.y } : { x: 0, y: 0 };
          const actual = imageToCanvasPoint(origin, state, VP, VP, false);
          expect(actual.x).toBeCloseTo(expected.x, 6);
          expect(actual.y).toBeCloseTo(expected.y, 6);
        });
      }
    }
  }

  it('moves the crop the opposite way in image space when dragging on a flipped image', () => {
    const controller = new ImageEditorController({ initialState: { transform: { rotate: 0, flipH: true, flipV: false } } });
    const state = controller.getState();
    const a = canvasToImagePoint({ x: 500, y: 500 }, state, 1000, 1000, true);
    const b = canvasToImagePoint({ x: 510, y: 500 }, state, 1000, 1000, true);
    expect(b.x - a.x).toBeLessThan(0);
    expect(b.y - a.y).toBeCloseTo(0, 6);
  });

  it('draws a left-half crop at 90deg as a wide strip across the top (crop overlay rect)', () => {
    const controller = new ImageEditorController({ initialState: { transform: { rotate: 90, flipH: false, flipV: false } } });
    const crop = { x: 0, y: 0, width: 400, height: 600 };
    controller.setCrop(crop);
    const state = controller.getState();
    const m = getViewportMetrics(state, VP, VP, true, crop);
    // Rotated base is 600x800 centred at (1000, 1000): x 700..1300, y 600..1400.
    expect(m.cropRect!.x).toBeCloseTo(700, 6);
    expect(m.cropRect!.y).toBeCloseTo(600, 6);
    expect(m.cropRect!.width).toBeCloseTo(600, 6);
    expect(m.cropRect!.height).toBeCloseTo(400, 6);
  });

  it('renderer draws the crop border at the projected rect under 90deg rotation', async () => {
    const renderer = new ImageEditorRenderer();
    const controller = new ImageEditorController({ initialState: { transform: { rotate: 90, flipH: false, flipV: false } } });
    controller.setCrop({ x: 0, y: 0, width: 400, height: 600 });
    const { ctx, calls } = makeRecordingCtx();
    const target = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
    const source = fakeImage('', 800, 600);
    await renderer.renderToCanvas(target, source, controller.getState(), {
      viewportWidth: VP,
      viewportHeight: VP,
      showCropOverlay: true,
    });
    const border = calls.find((c) => c.name === 'strokeRect')!;
    expect(border.args[2]).toBeCloseTo(600, 6);
    expect(border.args[3]).toBeCloseTo(400, 6);
    expect(border.args[0]).toBeCloseTo(700, 6);
    expect(border.args[1]).toBeCloseTo(600, 6);
  });

  it('hit-tests crop handles in screen orientation and reports image-space handles', () => {
    const crop = { x: 200, y: 150, width: 400, height: 300 };
    const flipped = new ImageEditorController({ initialState: { transform: { rotate: 0, flipH: true, flipV: false }, crop } }).getState();
    const mf = getViewportMetrics(flipped, VP, VP, true);
    const leftMid = { x: mf.cropRect!.x, y: mf.cropRect!.y + mf.cropRect!.height / 2 };
    // The left edge on screen is the crop's right ('e') edge in the mirrored image.
    expect(hitTestCrop(leftMid, flipped, VP, VP)).toBe('e');
    expect(getCropCursor('e', flipped.transform)).toBe('ew-resize');

    const rotated = new ImageEditorController({ initialState: { transform: { rotate: 90, flipH: false, flipV: false }, crop } }).getState();
    const mr = getViewportMetrics(rotated, VP, VP, true);
    const topMid = { x: mr.cropRect!.x + mr.cropRect!.width / 2, y: mr.cropRect!.y };
    // Rotating 90deg clockwise moves the image's left ('w') edge to the top of the screen.
    expect(hitTestCrop(topMid, rotated, VP, VP)).toBe('w');
    expect(getCropCursor('w', rotated.transform)).toBe('ns-resize');
    const topLeft = { x: mr.cropRect!.x, y: mr.cropRect!.y };
    expect(hitTestCrop(topLeft, rotated, VP, VP)).toBe('sw');
    expect(getCropCursor('sw', rotated.transform)).toBe('nwse-resize');
  });

  it('inverts the on-screen aspect ratio for crop drags under a quarter turn', () => {
    const start = { x: 0, y: 0, width: 200, height: 100 };
    const res = calculateCropDrag(start, 'e', { x: 200, y: 50 }, { x: 300, y: 50 }, 1000, 1000, 2, {
      rotate: 90,
      flipH: false,
      flipV: false,
    });
    // On screen 2:1 means 1:2 in natural image space.
    expect(res.height / res.width).toBeCloseTo(2, 6);
  });
});

describe('Image editor - immutable transforms & shared bounds', () => {
  it('rotate/flip produce new transform objects', () => {
    const controller = new ImageEditorController();
    const before = controller.getState().transform;
    controller.rotate(90);
    const afterRotate = controller.getState().transform;
    expect(afterRotate).not.toBe(before);
    expect(before.rotate).toBe(0);
    controller.flipHorizontal();
    expect(controller.getState().transform).not.toBe(afterRotate);
    expect(afterRotate.flipH).toBe(false);
    const afterH = controller.getState().transform;
    controller.flipVertical();
    expect(controller.getState().transform).not.toBe(afterH);
    const afterV = controller.getState().transform;
    controller.setRotation(180);
    expect(controller.getState().transform).not.toBe(afterV);
  });

  it('uses one getAnnotationBounds implementation that handles negative radii', () => {
    const circle = { id: 'c', type: 'circle', x: 100, y: 100, radiusX: -20, radiusY: -10, strokeColor: '#f00', strokeWidth: 2 } as const;
    const expected = { x: 80, y: 90, width: 40, height: 20 };
    expect(getAnnotationBounds(circle as any)).toEqual(expected);
    expect(new ImageEditorRenderer().getAnnotationBounds(circle as any)).toEqual(expected);
  });
});

describe('Image editor renderer - mask, depth mask and cache', () => {
  it('renders a strictly black/white inpainting mask and tolerates negative radii', async () => {
    const renderer = new ImageEditorRenderer();
    const pixels = new Uint8ClampedArray([0, 0, 0, 255, 200, 200, 200, 128, 100, 50, 20, 255, 255, 255, 255, 255]);
    let written: Uint8ClampedArray | null = null;
    const { ctx, calls } = makeRecordingCtx({
      getImageData: () => ({ data: pixels, width: 2, height: 2 }),
      putImageData: (img: { data: Uint8ClampedArray }) => {
        written = img.data;
      },
    });
    renderer.createCanvas = (w: number, h: number) =>
      ({ width: w, height: h, getContext: () => ctx }) as unknown as HTMLCanvasElement;

    const controller = new ImageEditorController();
    controller.addAnnotation({ type: 'circle', x: 100, y: 100, radiusX: -20, radiusY: -15, strokeColor: '#ff0000', strokeWidth: 2, fillColor: '#00ff00' });
    controller.addAnnotation({ type: 'arrow', x: 10, y: 10, endX: 90, endY: 40, strokeColor: '#ff0000', strokeWidth: 3 });
    controller.addAnnotation({ type: 'line', x: 10, y: 10, endX: 90, endY: 40, strokeColor: '#0000ff', strokeWidth: 3 });
    controller.addAnnotation({ type: 'text', x: 10, y: 10, text: 'hi', fontSize: 20, color: '#123456' });
    controller.addAnnotation({ type: 'rect', x: 10, y: 10, width: 20, height: 20, strokeColor: '#abcdef', strokeWidth: 1, fillColor: '#fedcba', opacity: 0.3 });

    await expect(renderer.renderMask(controller.getState(), { useAnnotations: true, useCrop: false })).resolves.toBeDefined();

    const paintCalls = calls.filter((c) => ['fill', 'stroke', 'fillRect', 'strokeRect', 'fillText'].includes(c.name));
    expect(paintCalls.length).toBeGreaterThan(0);
    for (const c of paintCalls) {
      const style = c.name === 'stroke' || c.name === 'strokeRect' ? c.strokeStyle : c.fillStyle;
      expect(['#000000', '#ffffff']).toContain(style);
    }

    expect(written).not.toBeNull();
    const out = written!;
    for (let i = 0; i < out.length; i += 4) {
      expect([0, 255]).toContain(out[i]);
      expect(out[i + 1]).toBe(out[i]);
      expect(out[i + 2]).toBe(out[i]);
      expect(out[i + 3]).toBe(255);
    }
  });

  it('invalidates the cached base render when depthMask.maskSource changes', async () => {
    const renderer = new ImageEditorRenderer();
    const createSpy = vi.spyOn(renderer, 'createCanvas');
    const { ctx } = makeRecordingCtx();
    const target = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
    const source = fakeImage('', 800, 600);
    const controller = new ImageEditorController();
    controller.setDepthMask({ enabled: true, maskSource: 'mask-a.png' });
    const opts = { viewportWidth: 1000, viewportHeight: 800 };

    await renderer.renderToCanvas(target, source, controller.getState(), opts);
    await renderer.renderToCanvas(target, source, controller.getState(), opts);
    expect(createSpy).toHaveBeenCalledTimes(1); // cached

    controller.setDepthMask({ maskSource: 'mask-b.png' });
    await renderer.renderToCanvas(target, source, controller.getState(), opts);
    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  it('applies the rotate/flip transform to the depth mask', async () => {
    const renderer = new ImageEditorRenderer();
    const maskImg = fakeImage('depth-rot.png', 800, 600);
    renderer.imageCache.set('depth-rot.png', maskImg);

    const contexts: ReturnType<typeof makeRecordingCtx>[] = [];
    renderer.createCanvas = (w: number, h: number) => {
      const rec = makeRecordingCtx({
        getImageData: (_x: number, _y: number, iw: number, ih: number) => ({
          data: new Uint8ClampedArray(Math.max(1, iw * ih) * 4),
          width: iw,
          height: ih,
        }),
      });
      contexts.push(rec);
      return { width: w, height: h, getContext: () => rec.ctx } as unknown as HTMLCanvasElement;
    };

    const controller = new ImageEditorController({ initialState: { transform: { rotate: 90, flipH: true, flipV: false } } });
    controller.setDepthMask({ enabled: true, maskSource: 'depth-rot.png' });
    await renderer.renderExport(fakeImage('', 800, 600), controller.getState());

    const maskCtx = contexts.find((c) => c.calls.some((call) => call.name === 'drawImage' && call.args[0] === maskImg));
    expect(maskCtx).toBeDefined();
    const names = maskCtx!.calls.map((c) => c.name);
    const rotateIdx = names.indexOf('rotate');
    const drawIdx = names.indexOf('drawImage');
    expect(rotateIdx).toBeGreaterThanOrEqual(0);
    expect(rotateIdx).toBeLessThan(drawIdx);
    expect(maskCtx!.calls[rotateIdx].args[0]).toBeCloseTo(Math.PI / 2, 6);
    expect(maskCtx!.calls.some((c) => c.name === 'scale' && c.args[0] === -1)).toBe(true);
  });
});

describe('Image editor - undoable AI source replacement', () => {
  it('applyInpaintedImage is one undo step that restores source and annotations; redo re-applies', async () => {
    const orig = fakeImage('orig-inpaint.png', 800, 600);
    const next = fakeImage('next-inpaint.png', 1600, 1200);
    new ImageEditorRenderer().imageCache.set('next-inpaint.png', next);

    const controller = new ImageEditorController({ image: orig });
    controller.setCrop({ x: 100, y: 100, width: 200, height: 200 });
    controller.addAnnotation({ type: 'rect', x: 10, y: 20, width: 30, height: 40, strokeColor: '#f00', strokeWidth: 2 });

    await controller.applyInpaintedImage('next-inpaint.png');
    let s = controller.getState();
    expect(s.sourceUrl).toBe('next-inpaint.png');
    expect(s.imageDimensions).toEqual({ width: 1600, height: 1200 });
    expect(controller.getImageElement()).toBe(next);
    expect(s.annotations).toEqual([]);
    // Crop rescaled to the new (2x) image dimensions
    expect(s.crop).toEqual({ x: 200, y: 200, width: 400, height: 400 });

    // ONE undo restores both the previous source and the annotations
    expect(controller.undo()).toBe(true);
    s = controller.getState();
    expect(s.sourceUrl).toBe('orig-inpaint.png');
    expect(s.imageDimensions).toEqual({ width: 800, height: 600 });
    expect(controller.getImageElement()).toBe(orig);
    expect(s.annotations).toHaveLength(1);
    expect(s.crop).toEqual({ x: 100, y: 100, width: 200, height: 200 });

    // The next undo is the annotation add (no duplicate entry from clearing annotations)
    controller.undo();
    expect(controller.getState().annotations).toHaveLength(0);
    expect(controller.getState().crop).toEqual({ x: 100, y: 100, width: 200, height: 200 });

    controller.redo();
    controller.redo();
    s = controller.getState();
    expect(s.sourceUrl).toBe('next-inpaint.png');
    expect(controller.getImageElement()).toBe(next);
    expect(s.annotations).toEqual([]);
    expect(controller.canRedo).toBe(false);

    // reset() still returns to the original image, not the AI result
    controller.reset();
    expect(controller.getState().sourceUrl).toBe('orig-inpaint.png');
    expect(controller.getImageElement()).toBe(orig);
  });

  it('applyBackgroundRemovedImage keeps (rescaled) annotations and undoes in one step', async () => {
    const orig = fakeImage('orig-bg.png', 800, 600);
    const next = fakeImage('next-bg.png', 400, 300);
    new ImageEditorRenderer().imageCache.set('next-bg.png', next);

    const controller = new ImageEditorController({ image: orig });
    controller.addAnnotation({ type: 'line', x: 100, y: 100, endX: 200, endY: 300, strokeColor: '#f00', strokeWidth: 4 });

    await controller.applyBackgroundRemovedImage('next-bg.png');
    const ann = controller.getState().annotations[0] as any;
    expect(ann).toMatchObject({ x: 50, y: 50, endX: 100, endY: 150, strokeWidth: 2 });

    controller.undo();
    expect(controller.getState().sourceUrl).toBe('orig-bg.png');
    expect(controller.getState().annotations[0]).toMatchObject({ x: 100, y: 100, endX: 200, endY: 300 });
  });
});
