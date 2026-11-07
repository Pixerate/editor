/**
 * The brush panel's slider tables and the controls each engine adds (`brushEngineControls`),
 * as plain data: paths into the engine brush. No renderer is imported, so the brush editor
 * descriptor (`@pixerate/editor/brushes` `brushEditorSections`) reuses them without bundling the
 * paint engine.
 */

import type { PaintBrush, PaintBrushInput } from './brushes';

/** One slider of a panel: a path into the brush (or paper) settings. */
export interface SliderControl {
  path: string;
  label: string;
  min: number;
  max: number;
  step: number;
}

export const BRUSH_SLIDERS: readonly SliderControl[] = [
  { path: 'tip.size', label: 'Size', min: 1, max: 400, step: 1 },
  { path: 'tip.opacity', label: 'Opacity', min: 0, max: 1, step: 0.01 },
  { path: 'tip.flow', label: 'Flow', min: 0, max: 1, step: 0.01 },
  { path: 'tip.hardness', label: 'Hardness', min: 0, max: 1, step: 0.01 },
  { path: 'tip.spacing', label: 'Spacing', min: 0.01, max: 1, step: 0.01 },
  { path: 'tip.roundness', label: 'Roundness', min: 0.05, max: 1, step: 0.01 },
  { path: 'tip.angle', label: 'Angle', min: -180, max: 180, step: 1 },
  { path: 'grain', label: 'Grain', min: 0, max: 1, step: 0.01 },
  { path: 'tip.smoothing', label: 'Smoothing', min: 0, max: 0.95, step: 0.01 },
  { path: 'pressureSmoothing', label: 'Pressure smoothing', min: 0, max: 0.95, step: 0.01 },
  { path: 'dynamics.minSize', label: 'Min size', min: 0, max: 1, step: 0.01 },
  { path: 'dynamics.tiltSize', label: 'Tilt size', min: 0, max: 1, step: 0.01 },
  { path: 'dynamics.velocitySize', label: 'Speed size', min: -1, max: 1, step: 0.01 },
];

export interface BrushEngineControls {
  /** Section heading. */
  title: string;
  sliders: readonly SliderControl[];
  /** Where the RGB / pigment choice is stored, or `null` when the engine has none. */
  mixingPath: 'behavior.mixing' | 'blender.mixing' | 'smudge.mixing' | null;
  /** The dirty-brush toggle (`behavior.dirty`). */
  dirty: boolean;
  /** The multi-colour controls (`behavior.multicolor`; the panels show the brush gradient, `brush.paint`, instead). */
  multicolor: boolean;
  /** Load / Clean buttons and a swatch of what the brush carries. */
  load: boolean;
  /** The wet tool menu (`wet.tool`, `WET_TOOLS`) and medium menu (`wet.medium`, `WET_MEDIA`). */
  wetTool?: boolean;
  /** The impasto tool menu (`impasto.tool`, `IMPASTO_TOOLS`). */
  impastoTool?: boolean;
  /**
   * The particle menus: kind and render (`particle.kind`, `particle.render`), ribbon pairs
   * (`particle.ribbonPairs`), and the textured-dot stamps, order and rotation
   * (`particle.dotTextures` up to `MAX_DOT_TEXTURES` of `STAMP_KINDS`, `dotTextureOrder`, `dotRotation`).
   */
  particleMenus?: boolean;
  /** The sticker picker for the brush's stickers (`sticker.stamps`, refs from the sticker library; `toggleStickerRef`). */
  stickerStamps?: boolean;
  /** Light paint: the "light follows pressure" toggle (`light.pressure`); the Light slider is in `sliders`. */
  light?: boolean;
  /** Thin-film iridescence: whether the brush can lay a thin-film iridescent coat (`iridescence`; `IRIDESCENCE_SLIDERS` are in `sliders` when enabled). */
  iridescence?: boolean;
}

/** The light paint slider (every engine that lays colour but sticker brushes; wet brushes when they paint). */
const LIGHT_SLIDER: SliderControl = { path: 'light.amount', label: 'Light', min: 0, max: 1, step: 0.01 };

/** The thin-film iridescence sliders (appended when `brush.iridescence` is set). */
export const IRIDESCENCE_SLIDERS: readonly SliderControl[] = [
  { path: 'iridescence.thickness', label: 'Film thickness (nm)', min: 100, max: 1000, step: 5 },
  { path: 'iridescence.pressureToThickness', label: 'Pressure → thickness', min: 0, max: 1, step: 0.01 },
  { path: 'iridescence.ior', label: 'Refractive index', min: 1.2, max: 2, step: 0.01 },
];

const PICKUP_SLIDERS: readonly SliderControl[] = [
  { path: 'behavior.pickup', label: 'Pick-up', min: 0, max: 1, step: 0.01 },
  { path: 'behavior.mix', label: 'Mix', min: 0, max: 1, step: 0.01 },
];

/**
 * The controls the active brush's engine adds to the brush panel (`null` for the eraser):
 * blender strength and blend distance; smudge strength and length; the Mixer Brush's pick-up,
 * mix and load; a dab brush's pick-up and mix ratios. Every engine but the eraser has an RGB /
 * pigment choice; dab and mixer brushes also have the dirty and multi-colour controls. Pick-up
 * and mix always go through `behavior`, which keeps a Mixer Brush's `mixer` block in sync.
 */
export function brushEngineControls(brush: Pick<PaintBrush, 'engine'> & { wet?: PaintBrush['wet']; iridescence?: PaintBrush['iridescence'] }): BrushEngineControls | null {
  const c = engineControls(brush);
  const wetPaint = brush.engine === 'wet' && brush.wet?.tool === 'paint';
  if (!c || !(wetPaint || ['dab', 'mixer', 'particle', 'bristle', 'impasto'].includes(brush.engine))) return c;
  // Light paint: how much light the brush lays (and, for impasto, rim and clarity).
  const extra: SliderControl[] = brush.engine === 'impasto' ? [{ path: 'impasto.rim', label: 'Rim', min: 0, max: 1, step: 0.01 }, { path: 'impasto.clarity', label: 'Clarity', min: 0, max: 1, step: 0.01 }] : [];
  const film: readonly SliderControl[] = brush.iridescence ? IRIDESCENCE_SLIDERS : [];
  return { ...c, sliders: [...c.sliders, LIGHT_SLIDER, ...extra, ...film], light: true, iridescence: true };
}

function engineControls(brush: Pick<PaintBrush, 'engine'> & { wet?: PaintBrush['wet'] }): BrushEngineControls | null {
  switch (brush.engine) {
    case 'particle':
      return {
        title: 'Particles',
        sliders: [
          { path: 'particle.count', label: 'Particles', min: 1, max: 64, step: 1 },
          { path: 'particle.size', label: 'Mark size', min: 0, max: 1, step: 0.01 },
          { path: 'particle.spread', label: 'Spread', min: 0, max: 1, step: 0.01 },
          { path: 'particle.stiffness', label: 'Stiffness', min: 0, max: 1, step: 0.01 },
          { path: 'particle.damping', label: 'Damping', min: 0, max: 1, step: 0.01 },
          { path: 'particle.speed', label: 'Speed', min: 0, max: 1, step: 0.01 },
          { path: 'particle.gravity', label: 'Gravity', min: -1, max: 1, step: 0.01 },
          { path: 'particle.life', label: 'Life', min: 0, max: 1, step: 0.01 },
          { path: 'particle.interval', label: 'Bead spacing', min: 0, max: 1, step: 0.01 },
          { path: 'particle.ribbonFill', label: 'Ribbon fill', min: 0, max: 1, step: 0.01 },
          { path: 'particle.waveAmplitude', label: 'Wave', min: 0, max: 1, step: 0.01 },
          { path: 'particle.waveLength', label: 'Wavelength', min: 4, max: 400, step: 1 },
          { path: 'particle.waveSpeed', label: 'Wave speed', min: 0, max: 1, step: 0.01 },
          { path: 'particle.wavePhaseJitter', label: 'Wave scatter', min: 0, max: 1, step: 0.01 },
        ],
        mixingPath: null,
        dirty: false,
        multicolor: false,
        load: false,
        particleMenus: true,
      };
    case 'bristle':
      return {
        title: 'Bristles',
        sliders: [
          { path: 'bristle.count', label: 'Bristles', min: 3, max: 128, step: 1 },
          { path: 'bristle.stiffness', label: 'Stiffness', min: 0, max: 1, step: 0.01 },
          { path: 'bristle.splay', label: 'Splay', min: 0, max: 1, step: 0.01 },
          { path: 'bristle.thickness', label: 'Bristle width', min: 0, max: 1, step: 0.01 },
          { path: 'bristle.load', label: 'Load', min: 0, max: 1, step: 0.01 },
          { path: 'bristle.jitter', label: 'Variation', min: 0, max: 1, step: 0.01 },
        ],
        mixingPath: null,
        dirty: false,
        multicolor: false,
        load: false,
      };
    case 'sticker':
      return {
        title: 'Stickers',
        sliders: [
          { path: 'sticker.density', label: 'Density', min: 0, max: 1, step: 0.01 },
          { path: 'sticker.sizeJitter', label: 'Size jitter', min: 0, max: 1, step: 0.01 },
          { path: 'sticker.rotationJitter', label: 'Turn jitter', min: 0, max: 1, step: 0.01 },
          { path: 'sticker.scatter', label: 'Scatter', min: 0, max: 2, step: 0.01 },
          { path: 'sticker.colorJitter', label: 'Colour jitter', min: 0, max: 1, step: 0.01 },
        ],
        mixingPath: null,
        dirty: false,
        multicolor: false,
        load: false,
        stickerStamps: true,
      };
    case 'impasto':
      return {
        title: 'Thick paint',
        sliders: [
          { path: 'impasto.thickness', label: 'Thickness', min: 0, max: 1, step: 0.01 },
          { path: 'impasto.gloss', label: 'Gloss', min: 0, max: 1, step: 0.01 },
          { path: 'impasto.metallic', label: 'Metallic', min: 0, max: 1, step: 0.01 },
          { path: 'impasto.load', label: 'Load', min: 0, max: 1, step: 0.01 },
          { path: 'impasto.thinner', label: 'Thinner', min: 0, max: 1, step: 0.01 },
          { path: 'impasto.drag', label: 'Drag', min: 0, max: 1, step: 0.01 },
          ...PICKUP_SLIDERS,
        ],
        mixingPath: 'behavior.mixing',
        dirty: true,
        multicolor: false,
        load: true,
        impastoTool: true,
      };
    case 'wet': {
      const tool = brush.wet?.tool ?? 'paint';
      const sliders: SliderControl[] =
        tool === 'paint'
          ? [
              { path: 'wet.water', label: 'Water', min: 0, max: 1, step: 0.01 },
              { path: 'wet.pigment', label: 'Pigment', min: 0, max: 1, step: 0.01 },
              { path: 'wet.body', label: 'Body (opacity)', min: 0, max: 1, step: 0.01 },
              { path: 'wet.rewet', label: 'Re-wet', min: 0, max: 1, step: 0.01 },
              { path: 'wet.load', label: 'Load', min: 0, max: 1, step: 0.01 },
              { path: 'wet.thinner', label: 'Thinner', min: 0, max: 1, step: 0.01 },
              ...PICKUP_SLIDERS,
            ]
          : tool === 'water'
            ? [
                { path: 'wet.water', label: 'Water', min: 0, max: 1, step: 0.01 },
                { path: 'wet.rewet', label: 'Re-wet', min: 0, max: 1, step: 0.01 },
              ]
            : [{ path: 'wet.strength', label: 'Strength', min: 0, max: 1, step: 0.01 }];
      return { title: 'Wet brush', sliders, mixingPath: tool === 'paint' ? 'behavior.mixing' : null, dirty: tool === 'paint', multicolor: false, load: tool === 'paint', wetTool: true };
    }
    case 'blender':
      return {
        title: 'Blender',
        sliders: [
          { path: 'blender.strength', label: 'Strength', min: 0, max: 1, step: 0.01 },
          { path: 'blender.distance', label: 'Blend distance', min: 0, max: 1, step: 0.01 },
        ],
        mixingPath: 'blender.mixing',
        dirty: false,
        multicolor: false,
        load: false,
      };
    case 'smudge':
      return {
        title: 'Smudge',
        sliders: [
          { path: 'smudge.strength', label: 'Strength', min: 0, max: 1, step: 0.01 },
          { path: 'smudge.length', label: 'Length', min: 0, max: 1, step: 0.01 },
        ],
        mixingPath: 'smudge.mixing',
        dirty: false,
        multicolor: false,
        load: false,
      };
    case 'mixer':
      return { title: 'Mixer Brush', sliders: [...PICKUP_SLIDERS, { path: 'mixer.load', label: 'Load', min: 0, max: 1, step: 0.01 }], mixingPath: 'behavior.mixing', dirty: true, multicolor: true, load: true };
    case 'dab':
      return { title: 'Paint behaviour', sliders: PICKUP_SLIDERS, mixingPath: 'behavior.mixing', dirty: true, multicolor: true, load: true };
    default:
      return null;
  }
}

/** The multi-colour sliders for a mode: softness, and dabs per colour in `dab` mode. */
export function multiColorSliders(mode: string): readonly SliderControl[] {
  if (mode === 'off') return [];
  const soft: SliderControl = { path: 'behavior.multicolor.softness', label: 'Colour softness', min: 0, max: 1, step: 0.01 };
  return mode === 'dab' ? [soft, { path: 'behavior.multicolor.length', label: 'Dabs per colour', min: 1, max: 100, step: 1 }] : [soft];
}

/** A brush change setting `path` (e.g. `smudge.mixing`, `behavior.dirty`) to any value, keeping the rest of its block. */
export function patchBrushValue(brush: PaintBrush, path: string, value: unknown): PaintBrushInput {
  const set = (obj: Record<string, unknown>, keys: string[]): Record<string, unknown> => {
    const [head, ...rest] = keys;
    if (!rest.length) return { ...obj, [head]: value };
    return { ...obj, [head]: set((obj[head] as Record<string, unknown>) ?? {}, rest) };
  };
  const [head, ...rest] = path.split('.');
  if (!rest.length) return { [head]: value } as PaintBrushInput;
  return { [head]: set({ ...((brush as unknown as Record<string, Record<string, unknown>>)[head] ?? {}) }, rest) } as PaintBrushInput;
}
