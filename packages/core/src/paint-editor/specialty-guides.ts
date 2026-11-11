/**
 * Guides for specialty paint (`BRUSH_SPECIALTIES`): for each specialty the active brush has, how
 * to paint with it, whether the canvas is set up for the effect to show now (the UV blacklight,
 * heat, magnets, view tilt, a mutation agent, running wet time), and quick actions that set it up.
 * Each action names the agent tool that does the same and its arguments, so the brush panel's
 * buttons, the Specialty panel and agents (`get_specialty_guides`) share one table.
 */

import { brushSpecialtyInfo, type BrushSpecialtyKind } from '../brushes/specialty';
import type { PaintBrush } from './brush-model';
import type { PaintEditorController, PaintEditorState } from './controller';

/** A quick action of a specialty guide. */
export type BrushSpecialtyActionId = 'uv-on' | 'uv-off' | 'warm-canvas' | 'step-heat' | 'cool-canvas' | 'add-magnet' | 'cure-ferrofluid' | 'tilt-view' | 'reset-tilt' | 'seed-pattern';

/** One click that sets the canvas up for a specialty: a button label and the agent tool call that does it. */
export interface BrushSpecialtyAction {
  id: BrushSpecialtyActionId;
  /** Button label (`Turn on UV blacklight`, `Add magnet`…). */
  label: string;
  /** The paint agent tool that does the same (`set_uv_light`, `add_magnet`…). */
  tool: 'set_uv_light' | 'paint_heat' | 'advance_heat' | 'clear_heat' | 'add_magnet' | 'cure_ferrofluid' | 'set_view_tilt' | 'seed_live_patterns';
  /** That tool's arguments (document pixels). */
  arguments: Record<string, unknown>;
}

/** How to use one specialty of the active brush, and whether the canvas is ready for it. */
export interface BrushSpecialtyGuide {
  kind: BrushSpecialtyKind;
  /** The specialty's name (`Ferrofluid`, `UV-fluorescent ink`…). */
  title: string;
  /** How strokes behave and which canvas controls bring the effect out. */
  howToUse: string;
  /** The canvas as it is now, for this specialty (`UV blacklight is off (strokes are invisible until UV is on)`). */
  status: string;
  /** Whether the effect shows right away on the canvas as it is. */
  ready: boolean;
  /** Quick actions that set the canvas up (none for ghost and mutation paint). */
  actions: BrushSpecialtyAction[];
}

/** The specialty kinds an engine brush lays, in `BRUSH_SPECIALTIES` order (a wet mutation brush is mutation paint, not ghost paint). */
export function paintBrushSpecialties(brush: PaintBrush): BrushSpecialtyKind[] {
  const out: BrushSpecialtyKind[] = [];
  if (brush.ferro.amount > 0) out.push('ferro');
  if (brush.fluorescence.amount > 0) out.push('fluorescence');
  if (brush.thermochromic.hotColor !== null) out.push('thermochromic');
  if (brush.iridescence) out.push('iridescence');
  if (brush.ghost && !brush.mutation) out.push('ghost');
  if (brush.mutation) out.push('mutation');
  if (brush.livePatterns) out.push('livePatterns');
  return out;
}

/** What the guides read from the editor state. */
export type BrushSpecialtyGuideState = Pick<PaintEditorState, 'brush' | 'uvLight' | 'heat' | 'viewTilt' | 'hasMutationAgent' | 'wet'> & {
  document: Pick<PaintEditorState['document'], 'canvas' | 'magnets' | 'ferro' | 'activeLayerId'>;
};

/** The heat "Warm canvas" paints (`paint_heat` arguments): a hot disc at the centre reaching half the canvas's longer side. */
export function warmCanvasHeat(canvas: { width: number; height: number }): { points: Array<{ x: number; y: number }>; radius: number; temperature: number } {
  return { points: [{ x: Math.round(canvas.width / 2), y: Math.round(canvas.height / 2) }], radius: Math.max(1, Math.min(512, Math.round(Math.max(canvas.width, canvas.height) / 2))), temperature: 1 };
}

/**
 * Whether specialty paint is in play, for a Specialty tab's indicator: the active brush is a
 * specialty brush, or the UV blacklight, heat, magnets or a view tilt is set on the canvas.
 */
export function specialtyInPlay(state: BrushSpecialtyGuideState): boolean {
  return paintBrushSpecialties(state.brush).length > 0 || state.uvLight.on || state.heat.hotCells > 0 || (state.document.magnets?.length ?? 0) > 0 || state.viewTilt.x !== 0 || state.viewTilt.y !== 0;
}

const PATTERN_WORDS: Readonly<Record<string, string>> = { spots: 'spot', stripes: 'stripe', coral: 'coral', maze: 'maze', worms: 'worm' };
const percent = (v: number) => Math.round(v * 100);

/**
 * One guide per specialty the active brush has (empty for standard brushes and tools), with the
 * canvas's readiness and the quick actions that apply now. `hasMutationAgent` overrides
 * `state.hasMutationAgent`.
 */
export function brushSpecialtyGuides(state: BrushSpecialtyGuideState, options: { hasMutationAgent?: boolean } = {}): BrushSpecialtyGuide[] {
  const brush = state.brush;
  const { width, height } = state.document.canvas;
  const centre = { x: Math.round(width / 2), y: Math.round(height / 2) };
  const guide = (kind: BrushSpecialtyKind, status: string, ready: boolean, actions: BrushSpecialtyAction[] = []): BrushSpecialtyGuide => {
    const info = brushSpecialtyInfo(kind);
    return { kind, title: info.label, howToUse: info.howToUse, status, ready, actions };
  };
  return paintBrushSpecialties(brush).map((kind) => {
    switch (kind) {
      case 'ferro': {
        const n = state.document.magnets?.length ?? 0;
        const liquid = Object.values(state.document.ferro ?? {}).some((s) => s.tiles.size > 0);
        const actions: BrushSpecialtyAction[] = [{ id: 'add-magnet', label: 'Add magnet', tool: 'add_magnet', arguments: { x: Math.min(width - 1, centre.x + 24 * n), y: centre.y } }];
        if (n > 0 && liquid) actions.push({ id: 'cure-ferrofluid', label: 'Cure spikes', tool: 'cure_ferrofluid', arguments: {} });
        const status = n === 0 ? 'No magnets placed — add a magnet to pull liquid ferrofluid into 3D spikes' : `${n} magnet${n === 1 ? '' : 's'} active${liquid ? ' — cure the spikes to keep them as relief' : ''}`;
        return guide(kind, status, n > 0, actions);
      }
      case 'fluorescence': {
        const uv = state.uvLight;
        if (uv.on) return guide(kind, `UV blacklight is on (${percent(uv.strength)}%)`, true, [{ id: 'uv-off', label: 'Turn off UV blacklight', tool: 'set_uv_light', arguments: { on: false } }]);
        const status = brush.fluorescence.invisible ? 'UV blacklight is off (strokes are invisible until UV is on)' : 'UV blacklight is off (strokes glow only under UV)';
        return guide(kind, status, false, [{ id: 'uv-on', label: 'Turn on UV blacklight', tool: 'set_uv_light', arguments: { on: true } }]);
      }
      case 'thermochromic': {
        const { hotColor, threshold } = brush.thermochromic;
        const max = state.heat.max;
        const actions: BrushSpecialtyAction[] = [{ id: 'warm-canvas', label: 'Warm canvas', tool: 'paint_heat', arguments: warmCanvasHeat(state.document.canvas) }];
        if (max > 0) {
          actions.push({ id: 'step-heat', label: 'Step heat', tool: 'advance_heat', arguments: { steps: 10 } });
          actions.push({ id: 'cool-canvas', label: 'Cool canvas', tool: 'clear_heat', arguments: {} });
        }
        const status =
          max <= 0
            ? `Canvas is cool — warm the canvas or paint heat to shift toward ${hotColor}`
            : max < threshold
              ? `Canvas is warm (max ${percent(max)}%), below the ink's ${percent(threshold)}% threshold`
              : `Canvas is warm (max ${percent(max)}%)`;
        return guide(kind, status, max >= threshold, actions);
      }
      case 'iridescence': {
        const flat = state.viewTilt.x === 0 && state.viewTilt.y === 0;
        return flat
          ? guide(kind, 'Tilt the view or move the light to shift interference colours', true, [{ id: 'tilt-view', label: 'Tilt view', tool: 'set_view_tilt', arguments: { x: 0.6, y: -0.4 } }])
          : guide(kind, 'View is tilted — interference colours shift as the angle changes', true, [{ id: 'reset-tilt', label: 'Reset tilt', tool: 'set_view_tilt', arguments: { x: 0, y: 0 } }]);
      }
      case 'ghost': {
        const ghost = brush.ghost!;
        const status = ghost.trigger === 'agent' ? 'Smears existing paint on this layer, then its own pigment fades once an agent claims the stroke' : `Smears existing paint on this layer, then its own pigment fades away over ${ghost.linger}s`;
        return guide(kind, status, true);
      }
      case 'mutation': {
        const agent = options.hasMutationAgent ?? state.hasMutationAgent;
        return agent ? guide(kind, `Agent connected — pauses ${brush.mutation!.settle}s after your stroke so the agent can answer`, true) : guide(kind, 'No mutation agent connected — strokes will stay as ordinary paint', false);
      }
      case 'livePatterns': {
        const pattern = brush.livePatterns!.pattern;
        const word = PATTERN_WORDS[pattern] ?? pattern;
        const active = state.document.activeLayerId;
        const wet = !!active && state.wet.layerIds.includes(active);
        const actions: BrushSpecialtyAction[] = wet ? [{ id: 'seed-pattern', label: 'Seed pattern', tool: 'seed_live_patterns', arguments: { points: [centre], radius: 16, pattern } }] : [];
        const status = state.wet.paused
          ? `Wet time is paused — resume it so ${word} patterns can grow`
          : wet
            ? `${word.charAt(0).toUpperCase()}${word.slice(1)} patterns grow in the wet paint on this layer and freeze as it dries`
            : `Paint a wet wash: ${word} patterns grow while it is wet and freeze as it dries`;
        return guide(kind, status, !state.wet.paused, actions);
      }
    }
  });
}

/** Runs a guide's quick action on the editor, as its agent tool would. Returns what the controller returned. */
export function runBrushSpecialtyAction(controller: PaintEditorController, action: Pick<BrushSpecialtyAction, 'tool' | 'arguments'>): unknown {
  // The arguments are the tool's, as the guides build them.
  const a = action.arguments as never;
  switch (action.tool) {
    case 'set_uv_light':
      return controller.setUvLight(a);
    case 'paint_heat':
      return controller.paintHeat(a);
    case 'advance_heat':
      return controller.advanceHeat(a);
    case 'clear_heat':
      return controller.clearHeat();
    case 'add_magnet':
      return controller.addMagnet(a);
    case 'cure_ferrofluid':
      return controller.cureFerrofluid();
    case 'set_view_tilt':
      return controller.setViewTilt(a);
    case 'seed_live_patterns':
      return controller.seedLivePatterns(a);
  }
}
