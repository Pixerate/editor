// Agent playback in the image editor (see `tools/playback.ts`), in document pixels: the cursor opens
// the panel a tool belongs to (as a user would click its tab), then traces strokes along their
// points, drags out boxes, clicks positions, visits the adjustment sliders it changes, or visits the
// layers a call names. Pure: plans read the arguments and the state before the call.
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { PlaybackPoint, PlaybackRect, PlaybackRef, PlaybackStep } from '../tools/playback.js';
import type { PresenceDrag, PresenceDragBox } from '../tools/presence.js';
import type { ImageEditorController } from './controller';

/** The playback kind of an image layer (`{ kind: 'layer', id }`, as in `data-layer-id`). */
export const IMAGE_PLAYBACK_KIND = 'layer';

/** The editor's panels (its tabs), as `{ kind: 'panel', id }` refs. */
export type ImagePlaybackPanel = 'crop' | 'adjust' | 'layers' | 'paint' | 'select' | 'annotate';

const PAINT = /^(paint_stroke|clone_stamp|heal_brush|spot_heal|dodge|burn|sponge|smudge|blur_stroke|sharpen_stroke|history_brush|set_clone_source|set_clone_transform|fill_pixels|clear_pixels|set_paint|set_retouch_options|load_mixer_brush|clean_mixer_brush)$/;
const SELECT = /^(make_work_path|add_path|set_path_geometry|rename_path|duplicate_path|delete_path|fill_path|stroke_path|select_region|select_subject|select_by_color|select_all|deselect|invert_selection|select_rect|select_ellipse|select_polygon|quick_select|select_object|select_focus_area|select_sky|select_line|magic_wand|grow_selection|select_similar|reselect|select_layer_transparency|select_color_range|load_selection_from_image|load_selection_from_mask|set_selection_display|modify_selection|refine_selection|transform_selection|apply_selection_as_mask|layer_via_copy|stroke_selection|content_aware_fill|copy_pixels|cut_pixels|paste_pixels|save_selection|load_selection_from_channel|set_channel_properties|duplicate_channel|delete_channel|load_channel_from_image|set_quick_mask|path_to_selection|select_text_shape|compare_selections|edit_selection_step|insert_selection_step|remove_selection_step|freeze_selection|separate_subject)$/;
const ANNOTATE = /^(add_shape_layer|update_shape|add_shape_component|set_shape_component|remove_shape_component|merge_shape_components|add_text_layer|set_text|set_text_style|set_paragraph_style|set_text_frame|set_text_orientation|convert_text_to_shape)$/;
const CROP = /^(set_crop|crop_to_selection|reset_crop|set_rotation|flip_image|transform_layer|warp_layer|flip_layer|offset_layer)$/;
const ADJUST = /^(set_adjustments|add_adjustment_layer|update_adjustment_layer|remove_adjustment_layer|move_adjustment_layer)$/;

/** The panel a write tool's change shows in (by its bare name), or null. */
export function imagePlaybackPanel(tool: string): ImagePlaybackPanel | null {
	if (ADJUST.test(tool)) return 'adjust';
	if (PAINT.test(tool)) return 'paint';
	if (SELECT.test(tool)) return 'select';
	if (ANNOTATE.test(tool)) return 'annotate';
	if (CROP.test(tool)) return 'crop';
	if (/layer|effect|filter|smart|group|mask|merge|flatten|profile|colors|proof|light|^set_edge_/.test(tool)) return 'layers';
	return null;
}

/** Finds `{ kind: 'layer', id }` (the layer's pixels, in document pixels) for agent playback. */
export function createImagePlaybackLocator(controller: Pick<ImageEditorController, 'getLayerBounds'>): (ref: PlaybackRef) => PlaybackRect | null {
	return (ref) => {
		if (ref.kind !== IMAGE_PLAYBACK_KIND && ref.kind !== 'item') return null;
		const b = controller.getLayerBounds(ref.id);
		return b && b.width > 0 && b.height > 0 ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
	};
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPoint = (p: unknown): p is PlaybackPoint => !!p && typeof p === 'object' && num((p as PlaybackPoint).x) && num((p as PlaybackPoint).y);

function trace(points: readonly PlaybackPoint[], max = 32, ms = 900): PlaybackStep[] {
	const list = points.length <= max ? points : Array.from({ length: max }, (_, i) => points[Math.round((i * (points.length - 1)) / (max - 1))]!);
	if (!list.length) return [];
	if (list.length === 1) return [{ type: 'move', to: list[0]! }, { type: 'press' }, { type: 'release' }];
	let total = 0;
	for (let i = 1; i < list.length; i++) total += Math.hypot(list[i]!.x - list[i - 1]!.x, list[i]!.y - list[i - 1]!.y);
	const stepMs = (i: number) => (total > 0 ? Math.max(16, (ms * Math.hypot(list[i]!.x - list[i - 1]!.x, list[i]!.y - list[i - 1]!.y)) / total) : 16);
	return [
		{ type: 'move', to: list[0]! },
		{ type: 'press', gesture: 'path' },
		...list.slice(1).map((to, i): PlaybackStep => ({ type: 'drag', to, ms: stepMs(i + 1) })),
		{ type: 'release' }
	];
}

/**
 * Cursor steps that trace closed outlines (document pixels) as lasso drags, one after another: how
 * playback shows a selection whose shape a tool learns mid-call (`select_subject`, through
 * `context.perform`). Long outlines are thinned to `maxPoints`; at most `maxOutlines` are traced.
 */
export function planOutlineTrace(outlines: readonly (readonly PlaybackPoint[])[], options: { maxOutlines?: number; maxPoints?: number } = {}): PlaybackStep[] {
	const rings = outlines.map((ring) => ring.filter(isPoint)).filter((ring) => ring.length >= 3);
	return rings
		.slice(0, options.maxOutlines ?? 4)
		.flatMap((ring) => trace([...ring, ring[0]!], options.maxPoints ?? 32, rings.length > 1 ? 700 : 1100));
}

/** A box `{ x, y, width, height }` or a line `{ x1, y1, x2, y2 }` in the arguments (or their `shape`, `box`, `rect`). */
function boxOf(args: Record<string, any>): { from: PlaybackPoint; to: PlaybackPoint } | null {
	for (const o of [args, args.shape, args.box, args.rect, args.bounds]) {
		if (!o || typeof o !== 'object') continue;
		if ([o.x, o.y, o.width, o.height].every(num)) return { from: { x: o.x, y: o.y }, to: { x: o.x + o.width, y: o.y + o.height } };
		if ([o.x1, o.y1, o.x2, o.y2].every(num)) return { from: { x: o.x1, y: o.y1 }, to: { x: o.x2, y: o.y2 } };
	}
	return null;
}

/** Layer ids a call names: `layerId`, `id`, `ids`, `layerIds`, or an effect `target`. */
function layersOf(args: Record<string, any>): string[] {
	const out: string[] = [];
	const add = (v: unknown) => typeof v === 'string' && v && !out.includes(v) && out.push(v);
	add(args.layerId);
	add(args.id);
	add(args.target);
	for (const key of ['ids', 'layerIds']) if (Array.isArray(args[key])) args[key].forEach(add);
	return out.slice(0, 6);
}

/**
 * The cursor steps for one image tool call (by bare name), or null to fall back to the ids it names.
 * Steps open the tool's panel first, then act on the canvas or on the panel's controls.
 */
export function planImageToolPlayback(tool: string, args: Record<string, any>): PlaybackStep[] | null {
	const steps: PlaybackStep[] = [];
	const panel = imagePlaybackPanel(tool);
	if (panel) steps.push({ type: 'open', ref: { kind: 'panel', id: panel } });
	const points = Array.isArray(args.points) ? (args.points as unknown[]).filter(isPoint) : [];
	const box = boxOf(args);
	if (points.length) steps.push(...trace(points));
	else if (box) steps.push({ type: 'move', to: box.from }, { type: 'press' }, { type: 'drag', to: box.to }, { type: 'release' });
	else if (num(args.x) && num(args.y)) steps.push({ type: 'move', to: { x: args.x, y: args.y } }, { type: 'press' }, { type: 'release' });
	else if (tool === 'set_adjustments' && args.values && typeof args.values === 'object') {
		// The sliders it moves (base controls; layer parameters visit the layer row).
		for (const key of Object.keys(args.values).slice(0, 4)) {
			const m = /^layers\.([^.]+)\.(.+)$/.exec(key);
			steps.push({ type: 'target', ref: m ? { kind: 'control', id: m[2]! } : { kind: 'control', id: key } });
		}
	} else for (const id of layersOf(args)) steps.push({ type: 'target', ref: { kind: IMAGE_PLAYBACK_KIND, id } });
	if (typeof args.text === 'string' && args.text.trim()) {
		const line = args.text.replace(/\s+/g, ' ').trim();
		steps.push({ type: 'type', text: line.length > 60 ? `${line.slice(0, 59)}…` : line });
	}
	return steps.length ? steps : null;
}

/**
 * Gives an image tool provider agent playback: each write tool plans its steps with
 * `planImageToolPlayback` and every call plays on `surface`. An explicit `surface` wins over the
 * provider's own `playbackSurface`; with neither, it is `image` (where `ImageEditor` attaches itself).
 */
export function withImagePlayback(provider: AgentToolProvider, surface?: string): AgentToolProvider {
	const plan = (tool: AgentTool): AgentTool =>
		tool.plan || tool.playback !== undefined ? tool : { ...tool, plan: (args) => planImageToolPlayback(tool.name, args) };
	const tools = provider.tools;
	return {
		...provider,
		playbackSurface: surface ?? provider.playbackSurface ?? 'image',
		tools: typeof tools === 'function' ? () => tools().map(plan) : tools.map(plan)
	};
}

/**
 * What a canvas draws while an agent drags on it (see `trackPresenceDrag`): in crop mode, the crop
 * box being pulled out (clamped to the image); in select mode, the lasso traced so far (a drag
 * with the `path` gesture) or else the marquee, as a selection path. The tool call that follows
 * sets the real crop or selection.
 */
export function agentDragDraft(
  mode: string,
  box: PresenceDragBox | PresenceDrag,
  image: { width: number; height: number },
): { crop: { x: number; y: number; width: number; height: number } } | { selectionPath: PlaybackPoint[] } | null {
  if (mode === 'select') {
    if ('gesture' in box && box.gesture === 'path' && box.path.length >= 2) return { selectionPath: box.path.map((p) => ({ x: p.x, y: p.y })) };
    return {
      selectionPath: [
        { x: box.x, y: box.y },
        { x: box.x + box.width, y: box.y },
        { x: box.x + box.width, y: box.y + box.height },
        { x: box.x, y: box.y + box.height },
      ],
    };
  }
  if (mode !== 'crop' || !image.width || !image.height) return null;
  const x = Math.max(0, Math.min(image.width, box.x));
  const y = Math.max(0, Math.min(image.height, box.y));
  return {
    crop: {
      x,
      y,
      width: Math.max(1, Math.min(image.width - x, box.width)),
      height: Math.max(1, Math.min(image.height - y, box.height)),
    },
  };
}
