// Agent playback in the paint editor (see `tools/playback.ts`). Strokes, fills and replays belong
// to the `PaintDirector` (its cursor paints them live), so with a director those tools play
// themselves; every other write opens the side panel it belongs to (Colour, Wet, Paper, Layers,
// Effects) as a user would click its tab, then points at the control it changes. Plans only name
// panels and controls; `PaintEditor` finds them (in document pixels).
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { PlaybackRef, PlaybackStep } from '../tools/playback.js';

/** The paint editor's side panels, as `{ kind: 'panel', id }` refs. */
export type PaintPlaybackPanel = 'color' | 'wet' | 'paper' | 'layers' | 'effects';

const WET = /^(advance_wet_paint|dry_paint|wet_paper|set_wet_settings|set_flow_map|set_canvas_tilt|pause_wet_paint|set_wet_engine|set_water_overlay)$/;
const PAPER = /^(set_paper|set_lighting|flatten_relief|set_instant_dry)$/;
const LAYERS = /^(add_layer|update_layer|set_active_layer|remove_layer|duplicate_layer|move_layer|merge_layer_down|clear_layer|update_sticker|arrange_stickers|remove_stickers)$/;
const PAD = /^(mixing_pad_stroke|pick_mixing_pad_color|clear_mixing_pad|mix_on_pad|save_mixing_pad|load_mixing_pad|remove_mixing_pad|mix_colors)$/;
const COLOR = /^(set_color|set_paint|color_harmony|add_swatch|remove_swatch|load_mixer_brush|clean_mixer_brush)$/;
const EFFECTS = /effect/;

/** The panel a paint write shows in (by its bare name), or null. */
export function paintPlaybackPanel(tool: string): PaintPlaybackPanel | null {
	if (WET.test(tool)) return 'wet';
	if (PAPER.test(tool)) return 'paper';
	if (LAYERS.test(tool)) return 'layers';
	if (PAD.test(tool) || COLOR.test(tool)) return 'color';
	if (EFFECTS.test(tool)) return 'effects';
	return null;
}

/** The control a paint write points at once its panel is open: `{ kind: 'control', id }`. */
function controlOf(tool: string): PlaybackRef | null {
	if (PAD.test(tool)) return { kind: 'control', id: 'mixing-pad' };
	if (tool === 'set_lighting' || tool === 'flatten_relief') return { kind: 'control', id: 'lighting' };
	if (tool === 'set_symmetry' || tool === 'set_perspective_guide') return { kind: 'control', id: 'symmetry' };
	const panel = paintPlaybackPanel(tool);
	return panel ? { kind: 'panel-body', id: panel } : null;
}

/** The cursor steps for one paint tool call (by bare name), or null to fall back to the ids it names. */
export function planPaintToolPlayback(tool: string, _args: Record<string, any>): PlaybackStep[] | null {
	const steps: PlaybackStep[] = [];
	const panel = paintPlaybackPanel(tool);
	if (panel) steps.push({ type: 'open', ref: { kind: 'panel', id: panel } });
	const control = controlOf(tool);
	if (control) steps.push({ type: 'target', ref: control }, { type: 'press' }, { type: 'release' });
	return steps.length ? steps : null;
}

const DIRECTED = new Set(['paint_stroke', 'fill_layer', 'replay_strokes']);

/**
 * Gives a paint tool provider agent playback on `surface`. An explicit `surface` wins over the
 * provider's own `playbackSurface`; with neither, it is `paint` (where `PaintEditor` attaches). With a director, strokes, fills and replays play through it (`playback: 'self'`).
 */
export function withPaintPlayback(provider: AgentToolProvider, options: { director: boolean; surface?: string }): AgentToolProvider {
	const plan = (tool: AgentTool): AgentTool => {
		if (tool.plan || tool.playback !== undefined) return tool;
		if (options.director && DIRECTED.has(tool.name)) return { ...tool, playback: 'self' };
		return { ...tool, plan: (args) => planPaintToolPlayback(tool.name, args) };
	};
	const tools = provider.tools;
	return {
		...provider,
		playbackSurface: options.surface ?? provider.playbackSurface ?? 'paint',
		tools: typeof tools === 'function' ? () => tools().map(plan) : tools.map(plan)
	};
}
