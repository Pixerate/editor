import { describe, it, expect } from 'vitest';
import { createReactiveImageEditor } from '../src/image-editor/imageEditorState.svelte';
import { ImageEditor } from '../src/image-editor';
import * as RootExports from '../src';

describe('Svelte Image Editor - createReactiveImageEditor rune', () => {
  it('initializes with default state and provides reactive getters', () => {
    const editor = createReactiveImageEditor();

    expect(editor.state).toBeDefined();
    expect(editor.state.activeTool).toBe('select');
    expect(editor.state.zoom).toBe(1);
    expect(editor.state.transform.rotate).toBe(0);
    expect(editor.canUndo).toBe(false);
    expect(editor.canRedo).toBe(false);
  });

  it('handles tool switches, rotation, adjustments, and undo/redo history', () => {
    const editor = createReactiveImageEditor();

    // Switch tool
    editor.setTool('pen');
    expect(editor.state.activeTool).toBe('pen');

    // Rotate
    editor.rotate(90);
    expect(editor.state.transform.rotate).toBe(90);
    expect(editor.canUndo).toBe(true);

    // Flip horizontal
    editor.flipHorizontal();
    expect(editor.state.transform.flipH).toBe(true);

    // Adjustments
    editor.setAdjustments({ brightness: 25, contrast: -10 });
    expect(editor.state.adjustments.brightness).toBe(25);
    expect(editor.state.adjustments.contrast).toBe(-10);

    // Add annotation
    const annId = editor.addAnnotation({
      type: 'rect',
      x: 10,
      y: 20,
      width: 100,
      height: 80,
      strokeColor: '#3b82f6',
      strokeWidth: 2,
    });
    expect(editor.state.annotations.length).toBe(1);
    expect(editor.state.annotations[0].id).toBe(annId);

    // Undo annotation
    editor.undo();
    expect(editor.state.annotations.length).toBe(0);
    expect(editor.canRedo).toBe(true);

    // Redo annotation
    editor.redo();
    expect(editor.state.annotations.length).toBe(1);
  });

  it('supports depth mask controls', () => {
    const editor = createReactiveImageEditor();
    expect(editor.state.depthMask.enabled).toBe(false);

    editor.setDepthMask({ enabled: true, mode: 'brightness', softness: 20 });
    expect(editor.state.depthMask.enabled).toBe(true);
    expect(editor.state.depthMask.mode).toBe('brightness');
    expect(editor.state.depthMask.softness).toBe(20);

    editor.resetDepthMask();
    expect(editor.state.depthMask.enabled).toBe(false);
    expect(editor.state.depthMask.mode).toBe('threshold');
  });

  it('supports serialization to and from JSON', () => {
    const editor = createReactiveImageEditor();
    editor.rotate(180);
    editor.setAdjustments({ saturation: 40 });

    const json = editor.toJSON();
    expect(json.version).toBe(1);
    expect(json.transform.rotate).toBe(180);
    expect(json.adjustments.saturation).toBe(40);

    const editor2 = createReactiveImageEditor();
    editor2.loadJSON(json);
    expect(editor2.state.transform.rotate).toBe(180);
    expect(editor2.state.adjustments.saturation).toBe(40);
  });

  it('supports AI masking, inpainting application, and background removal application', async () => {
    const editor = createReactiveImageEditor();
    editor.addAnnotation({
      type: 'rect',
      x: 5,
      y: 5,
      width: 20,
      height: 20,
    });
    expect(editor.state.annotations.length).toBe(1);

    const maskDataUrl = await editor.toMaskDataURL();
    expect(maskDataUrl).toBeDefined();

    await editor.applyInpaintedImage('data:image/png;base64,inpaintMock');
    expect(editor.state.sourceUrl).toBe('data:image/png;base64,inpaintMock');
    expect(editor.state.annotations.length).toBe(0);

    await editor.applyBackgroundRemovedImage('data:image/png;base64,bgRemovedMock');
    expect(editor.state.sourceUrl).toBe('data:image/png;base64,bgRemovedMock');
  });
});

describe('Svelte Image Editor - Exports', () => {
  it('exports ImageEditor and createReactiveImageEditor from root', () => {
    expect(RootExports.ImageEditor).toBeDefined();
    expect(RootExports.createReactiveImageEditor).toBeDefined();
    expect(ImageEditor).toBeDefined();
  });
});
