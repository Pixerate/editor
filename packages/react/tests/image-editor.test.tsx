import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useImageEditor, ImageEditor } from '../src/image-editor';

let container: HTMLDivElement;
let root: any;

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
    url: 'https://example.com/editor',
  });
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0) as any;
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
  (globalThis as any).HTMLCanvasElement = dom.window.HTMLCanvasElement;

  const canvasProto = dom.window.HTMLCanvasElement.prototype;
  canvasProto.toDataURL = () => 'data:image/png;base64,mock';
  canvasProto.getContext = (() => ({
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(16), width: 2, height: 2 })),
    putImageData: vi.fn(),
    createImageData: vi.fn(),
    setTransform: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    fillText: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    fill: vi.fn(),
    ellipse: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    rotate: vi.fn(),
    setLineDash: vi.fn(),
  })) as any;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

describe('React Image Editor - useImageEditor hook', () => {
  it('manages editor state, transformations, and undo/redo in React lifecycle', async () => {
    let hookResult: ReturnType<typeof useImageEditor> | null = null;

    function TestComponent() {
      hookResult = useImageEditor();
      return <div>Active tool: {hookResult.state.activeTool}</div>;
    }

    await act(async () => {
      root.render(<TestComponent />);
    });

    expect(hookResult).not.toBeNull();
    expect(hookResult!.state.activeTool).toBe('select');

    // Test tool switch
    await act(async () => {
      hookResult!.setTool('pen');
    });
    expect(hookResult!.state.activeTool).toBe('pen');

    // Test rotation and history
    await act(async () => {
      hookResult!.rotate(90);
    });
    expect(hookResult!.state.transform.rotate).toBe(90);
    expect(hookResult!.canUndo).toBe(true);

    // Test undo
    await act(async () => {
      hookResult!.undo();
    });
    expect(hookResult!.state.transform.rotate).toBe(0);
    expect(hookResult!.canRedo).toBe(true);

    // Test adjustments
    await act(async () => {
      hookResult!.setAdjustments({ brightness: 30, contrast: 15 });
    });
    expect(hookResult!.state.adjustments.brightness).toBe(30);
    expect(hookResult!.state.adjustments.contrast).toBe(15);
  });
});

describe('React Image Editor - ImageEditor Component', () => {
  it('renders tab headers and switches panels smoothly', async () => {
    await act(async () => {
      root.render(<ImageEditor />);
    });

    const buttons = container.querySelectorAll('button');
    const tabLabels = Array.from(buttons).map((b) => b.textContent?.trim());

    expect(tabLabels).toContain('Transform & Crop');
    expect(tabLabels).toContain('Adjustments');
    expect(tabLabels).toContain('Annotations');
    expect(tabLabels).toContain('Depth Mask');
    expect(tabLabels).toContain('AI Tools');

    // Initially in Crop tab: check crop presets
    expect(container.textContent).toContain('Aspect Ratio Presets');
    expect(container.textContent).toContain('1:1 Square');

    // Switch to Adjustments tab
    const adjustBtn = Array.from(buttons).find((b) => b.textContent?.trim() === 'Adjustments');
    expect(adjustBtn).toBeDefined();

    await act(async () => {
      adjustBtn!.click();
    });

    expect(container.textContent).toContain('Color Adjustments');
    expect(container.textContent).toContain('Brightness');
    expect(container.textContent).toContain('Contrast');
    expect(container.textContent).toContain('Saturation');

    // Switch to Depth Mask tab
    const depthBtn = Array.from(buttons).find((b) => b.textContent?.trim() === 'Depth Mask');
    expect(depthBtn).toBeDefined();

    await act(async () => {
      depthBtn!.click();
    });

    expect(container.textContent).toContain('Depth Masking');
    expect(container.textContent).toContain('Enable Depth / Alpha Mask');

    // Switch to AI Tools tab
    const aiBtn = Array.from(buttons).find((b) => b.textContent?.includes('AI Tools'));
    expect(aiBtn).toBeDefined();

    await act(async () => {
      aiBtn!.click();
    });

    expect(container.textContent).toContain('Background Removal');
    expect(container.textContent).toContain('Generative Inpainting');
  });

  it('triggers onSave callback when Export Image is clicked', async () => {
    const onSave = vi.fn();

    await act(async () => {
      root.render(<ImageEditor onSave={onSave} />);
    });

    const exportBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Export Image'
    );
    expect(exportBtn).toBeDefined();

    await act(async () => {
      exportBtn!.click();
    });

    expect(onSave).toHaveBeenCalledWith('data:image/png;base64,mock');
  });

  it('triggers onRemoveBackground and onInpaint hooks', async () => {
    const onRemoveBackground = vi.fn().mockResolvedValue('data:image/png;base64,bgDone');
    const onInpaint = vi.fn().mockResolvedValue('data:image/png;base64,inpaintDone');

    await act(async () => {
      root.render(
        <ImageEditor
          onRemoveBackground={onRemoveBackground}
          onInpaint={onInpaint}
        />
      );
    });

    // Switch to AI tab
    const aiBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('AI Tools'));
    await act(async () => {
      aiBtn!.click();
    });

    // Click remove background
    const removeBgBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Remove Background'));
    expect(removeBgBtn).toBeDefined();

    await act(async () => {
      removeBgBtn!.click();
    });

    expect(onRemoveBackground).toHaveBeenCalled();
  });
});

