import { describe, expect, it } from 'vitest';
import {
  ImageEditorController,
  LAYER_EFFECT_KINDS,
  LAYER_EFFECT_MENU,
  defaultLayerEffect,
  effectControlChange,
  layerEffectControls,
  layerEffectsBadge,
  layerEffectsPanel,
  mergeLayerEffect,
} from '../src/image-editor';

function setup() {
  const fake = { width: 20, height: 20, naturalWidth: 20, naturalHeight: 20 } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: 20, height: 20, data: new Uint8ClampedArray(1600).fill(255) });
  const id = c.addPixelLayer({ name: 'Shape' });
  return { c, id };
}

describe('layer effects panel model', () => {
  it('lists a layer\'s effects and says when a layer cannot take them', () => {
    const { c, id } = setup();
    expect(layerEffectsPanel(c.getLayer(id))).toMatchObject({ available: true, readOnly: false, enabled: true, scale: 1, rows: [] });
    c.addLayerEffect(id, 'drop-shadow');
    c.addLayerEffect(id, 'stroke', { enabled: false });
    const model = layerEffectsPanel(c.getLayer(id));
    expect(model.rows.map((r) => [r.kind, r.label, r.enabled])).toEqual([
      ['drop-shadow', 'Drop Shadow', true],
      ['stroke', 'Stroke', false],
    ]);
    expect(layerEffectsBadge(c.getLayer(id)!)).toBe('on');
    c.setLayerEffectsEnabled(id, false);
    expect(layerEffectsBadge(c.getLayer(id)!)).toBe('off');
    expect(layerEffectsBadge(c.getLayers()[0])).toBeNull();
    const adj = c.addAdjustmentLayer({ kind: 'curves' });
    expect(layerEffectsPanel(c.getLayer(adj))).toMatchObject({ available: false, reason: expect.stringMatching(/Adjustment layers/) });
    c.setLayerProperties(id, { locks: { all: true } });
    expect(layerEffectsPanel(c.getLayer(id))).toMatchObject({ available: true, readOnly: true, reason: expect.stringMatching(/locked/) });
    expect(LAYER_EFFECT_MENU.map((m) => m.kind)).toEqual([...LAYER_EFFECT_KINDS]);
  });

  it('gives every kind controls whose changes the controller accepts', () => {
    const { c, id } = setup();
    for (const kind of LAYER_EFFECT_KINDS) {
      const { effect } = c.addLayerEffect(id, kind);
      for (const control of layerEffectControls(effect)) {
        expect(control.label, `${kind}.${control.key}`).toBeTruthy();
        const value =
          control.type === 'range' ? control.max : control.type === 'color' ? '#123456' : control.type === 'checkbox' ? !control.value : control.options[control.options.length - 1].value;
        const current = c.getLayerEffects(id).items.find((e) => e.id === effect.id)!;
        expect(() => c.updateLayerEffect(id, effect.id, effectControlChange(current, control.key, value)), `${kind}.${control.key}`).not.toThrow();
      }
    }
  });

  it('maps nested controls to whole objects and switches fills by type', () => {
    const stroke = defaultLayerEffect('stroke', 's');
    expect(effectControlChange(stroke, 'fill.color', '#ff0000')).toEqual({ fill: { type: 'color', color: '#ff0000' } });
    const toGradient = effectControlChange(stroke, 'fill.type', 'gradient') as { fill: { type: string; gradient: unknown } };
    expect(toGradient.fill.type).toBe('gradient');
    const withGradient = mergeLayerEffect(stroke, toGradient);
    const end = effectControlChange(withGradient, 'fill.gradient.stops.last.color', '#00ff00') as { fill: { gradient: { stops: Array<{ color: string }> } } };
    expect(end.fill.gradient.stops.map((s) => s.color)).toEqual(['#000000', '#00ff00']);
    expect(effectControlChange(stroke, 'fill.type', 'pattern')).toEqual({ fill: { type: 'pattern', patternId: 'checker', scale: 1 } });
    expect(effectControlChange(defaultLayerEffect('pattern-overlay', 'p'), 'patternId', 'dots')).toEqual({ patternId: 'dots', name: 'Dots' });
    const doc = [{ id: 'doc', name: 'Wood', width: 1, height: 1, data: new Uint8ClampedArray(4) }];
    const ctl = layerEffectControls(defaultLayerEffect('pattern-overlay', 'p'), doc).find((x) => x.key === 'patternId')!;
    expect(ctl.type === 'select' && ctl.options[0]).toEqual({ value: 'doc', label: 'Wood' });
    // Effects never offer the pigment layer mode.
    const blend = layerEffectControls(defaultLayerEffect('satin', 's')).find((x) => x.key === 'blend')!;
    expect(blend.type === 'select' && blend.options.some((o) => o.value === 'pigment')).toBe(false);
  });
});
