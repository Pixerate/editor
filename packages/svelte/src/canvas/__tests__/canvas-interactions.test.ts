import { describe, it, expect, vi } from 'vitest';
import {
  createCanvasInteractions,
  defaultSvelteFlowPreset,
  miroCompatiblePreset,
  restorePanelPointerEvents
} from '../createCanvasInteractions.svelte.js';

describe('createCanvasInteractions', () => {
  it('exposes valid default presets', () => {
    expect(defaultSvelteFlowPreset.snapGrid).toEqual([25, 25]);
    expect(defaultSvelteFlowPreset.panOnScroll).toBe(false);
    expect(defaultSvelteFlowPreset.selectionOnDrag).toBe(false);

    expect(miroCompatiblePreset.selectionOnDrag).toBe(true);
    expect(miroCompatiblePreset.panOnDrag).toEqual([1, 2]);
  });

  it('toggles spacebar panning mode on Space keydown and keyup', () => {
    const target = new EventTarget();
    const onPanModeChange = vi.fn();

    const interactions = createCanvasInteractions({
      targetElement: target as unknown as HTMLElement,
      onPanModeChange
    });

    const cleanup = interactions.attachListeners(target as unknown as HTMLElement);

    // Press Space
    const downEvent = new KeyboardEvent('keydown', { key: ' ' });
    target.dispatchEvent(downEvent);

    expect(interactions.isSpacebarPanning).toBe(true);
    expect(onPanModeChange).toHaveBeenCalledWith(true);

    // Release Space
    const upEvent = new KeyboardEvent('keyup', { key: ' ' });
    target.dispatchEvent(upEvent);

    expect(interactions.isSpacebarPanning).toBe(false);
    expect(onPanModeChange).toHaveBeenCalledWith(false);

    cleanup();
  });

  it('detects trackpad pinch on wheel event with ctrlKey', () => {
    const target = new EventTarget();
    const onTrackpadDetected = vi.fn();

    const interactions = createCanvasInteractions({
      targetElement: target as unknown as HTMLElement,
      onTrackpadDetected
    });

    const cleanup = interactions.attachListeners(target as unknown as HTMLElement);

    expect(interactions.trackpadDetected).toBe(false);

    // Normal wheel without ctrlKey
    const wheelEvent = new WheelEvent('wheel', { ctrlKey: false });
    target.dispatchEvent(wheelEvent);
    expect(interactions.trackpadDetected).toBe(false);
    expect(onTrackpadDetected).not.toHaveBeenCalled();

    // Trackpad pinch with ctrlKey
    const pinchEvent = new WheelEvent('wheel', { ctrlKey: true });
    target.dispatchEvent(pinchEvent);
    expect(interactions.trackpadDetected).toBe(true);
    expect(onTrackpadDetected).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it('restores pointer events on DOM panels', () => {
    const panel = document.createElement('div');
    panel.className = 'svelte-flow__panel';
    panel.style.pointerEvents = 'none';
    document.body.appendChild(panel);

    restorePanelPointerEvents();

    expect(panel.style.pointerEvents).toBe('auto');
    document.body.removeChild(panel);
  });
});
