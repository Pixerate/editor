/**
 * An effects provider's `EffectSequence` (what a sequence template fills to) as video edits, so a
 * template lands on the timeline as one undo step:
 *
 * - Each shot's bottom layer, when it lasts exactly the shot, goes on a base track; otherwise the
 *   shot gets a black colour clip there. A shot's transition goes on its base clip (a provider
 *   `effect` transition from the base clip before), so it blends the base pictures.
 * - Other layers go on tracks above by role (background, subject, overlay), packed so clips of a
 *   track never overlap: an effect with no subject is an effect clip; a picture or SVG is a media
 *   clip on a new image asset, carrying the layer's effect as a clip effect; words are a text clip;
 *   an open slot is a grey placeholder colour clip named after it.
 * - A layer's `rect` becomes the clip's placement; `opacity` and `fade` carry over.
 * - Titles and captions are text clips on the top track.
 *
 * Camera moves are not carried over (notes say so); set them with `set_clip_camera_move`.
 */

import { effectLayerRole, effectLayerSpan, effectSequenceTiming } from '../effects/templates.js';
import type { EffectLayer, EffectRect, EffectSequence } from '../effects/types.js';
import type { NewVideoClip, VideoEdit } from './edit.js';
import { allVideoClipIds, videoProjectDuration } from './timeline.js';
import type { VideoProject, VideoTransform } from './types.js';

export interface VideoSequenceEdits {
	edits: VideoEdit[];
	/** The new clips' ids, base clips first. */
	clips: string[];
	/** The new tracks' ids, top to bottom. */
	tracks: string[];
	assets: string[];
	/** Where the sequence starts and ends on the timeline (ms). */
	start: number;
	end: number;
	/** Placeholder clips standing in for open subject slots, by slot. */
	placeholders: Record<string, string[]>;
	notes: string[];
}

const svgUrl = (svg: string) => (svg.trimStart().startsWith('<') ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : svg);
const GROUPS = ['base', 'background', 'subject', 'overlay', 'text'] as const;
type Group = (typeof GROUPS)[number];

/** The edits that put a sequence on a project's timeline at `at` (default its end), on new tracks above the others. */
export function videoEditsFromSequence(project: VideoProject, sequence: EffectSequence, options: { at?: number; provider?: string } = {}): VideoSequenceEdits {
	const at = options.at ?? videoProjectDuration(project);
	const W = project.width;
	const H = project.height;
	const sx = W / sequence.stage.width;
	const sy = H / sequence.stage.height;
	const timing = effectSequenceTiming(sequence);
	const provider = options.provider ? { provider: options.provider } : {};
	const notes: string[] = [];
	const usedClips = new Set(allVideoClipIds(project));
	const usedTracks = new Set(project.tracks.map((t) => t.id));
	const usedAssets = new Set(project.assets.map((a) => a.id));
	const fresh = (used: Set<string>, base: string) => {
		for (let i = 1; ; i++) if (!used.has(`${base}${i}`)) return used.add(`${base}${i}`), `${base}${i}`;
	};
	const edits: VideoEdit[] = [];
	const assets: string[] = [];
	const placeholders: Record<string, string[]> = {};
	const items: { group: Group; clip: NewVideoClip & { id: string; start: number; duration: number } }[] = [];

	const placement = (r: EffectRect | undefined): { transform?: VideoTransform } => {
		if (!r) return {};
		const x = (r.x + r.width / 2) * sx - W / 2;
		const y = (r.y + r.height / 2) * sy - H / 2;
		const scale = Math.min((r.width * sx) / W, (r.height * sy) / H);
		return { transform: { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, scale: Math.round(scale * 1000) / 1000 } };
	};
	const clipOf = (layer: EffectLayer, start: number, duration: number, shot: number): NewVideoClip & { id: string; start: number; duration: number } => {
		const id = fresh(usedClips, 'tpl-c');
		const common = { id, start, duration, ...(layer.opacity !== undefined && layer.opacity < 1 ? { opacity: layer.opacity } : {}), ...(layer.fade ? { fadeIn: layer.fade, fadeOut: layer.fade } : {}), ...placement(layer.rect) };
		const effects = layer.effect ? { effects: [{ id: 'fx1', effect: layer.effect, ...provider, ...(layer.values ? { values: layer.values } : {}) }] } : {};
		const s = layer.subject;
		if (!s) return { ...common, type: 'effect', effect: layer.effect!, ...provider, ...(layer.values ? { values: layer.values } : {}) };
		if ('slot' in s) {
			(placeholders[s.slot] ??= []).push(id);
			if (layer.effect) notes.push(`Shot ${shot + 1}: the "${s.slot}" slot is a grey placeholder; when you swap in the picture, apply ${layer.effect} to it again (apply_effect).`);
			return { ...common, type: 'color', color: '#475569', name: `Slot "${s.slot}"` };
		}
		if ('text' in s) return { ...common, type: 'text', text: s.text, ...(s.font ? { fontFamily: s.font } : {}), ...(typeof s.weight === 'number' ? { fontWeight: s.weight } : {}), ...effects };
		const asset = fresh(usedAssets, 'tpl-a');
		assets.push(asset);
		if ('video' in s) {
			notes.push(`Shot ${shot + 1}: a video's length is not known here, so its asset is given the clip's length (${Math.round(duration)} ms); correct it with update_video_asset if it is longer.`);
			edits.push({ op: 'add_asset', asset: { id: asset, kind: 'video', src: s.video, duration } });
		} else edits.push({ op: 'add_asset', asset: { id: asset, kind: 'image', src: 'image' in s ? s.image : svgUrl(s.svg) } });
		return { ...common, type: 'media', asset, fit: 'contain', ...effects } as NewVideoClip & { id: string; start: number; duration: number };
	};

	sequence.shots.forEach((shot, i) => {
		const shotStart = timing.starts[i];
		const shotEnd = timing.starts[i + 1] ?? timing.total;
		let base: (typeof items)[number] | undefined;
		shot.layers.forEach((layer, j) => {
			const span = effectLayerSpan(layer, i, timing.starts, timing.total);
			if (span.end - span.start <= 0) return void notes.push(`Shot ${i + 1}, layer ${j + 1} lasts no time, so it was left out.`);
			const clip = clipOf(layer, at + span.start, span.end - span.start, i);
			const isBase = j === 0 && !base && span.start === shotStart && span.end === shotEnd && effectLayerRole(layer) === 'background' && !layer.rect;
			const item = { group: (isBase ? 'base' : effectLayerRole(layer)) as Group, clip };
			if (isBase) base = item;
			items.push(item);
		});
		if (!base) {
			base = { group: 'base', clip: { id: fresh(usedClips, 'tpl-c'), type: 'color', color: '#000000', name: `Shot ${i + 1}`, start: at + shotStart, duration: shotEnd - shotStart } };
			items.push(base);
		}
		if (i > 0 && shot.transition) {
			(base.clip as { transition?: unknown }).transition = { type: 'effect', duration: shot.transition.ms ?? 800, effect: { effect: shot.transition.effect, ...provider, ...(shot.transition.values ? { values: shot.transition.values } : {}) } };
			if (shot.layers.length > 1) notes.push(`Shot ${i + 1}: its transition blends the clips on the base track; the layers above it cut.`);
		}
		const words = (text: string, y: number, size: number, name: string) =>
			items.push({ group: 'text', clip: { id: fresh(usedClips, 'tpl-c'), type: 'text', text, name, fontSize: Math.round(size), start: at + shotStart, duration: shotEnd - shotStart, transform: { x: 0, y: Math.round(y) } } });
		if (shot.title) words(shot.title, 0, H * 0.09, 'Title');
		if (shot.caption) words(shot.caption, H * 0.35, H * 0.045, 'Caption');
		if (shot.camera?.in !== undefined || shot.camera?.during !== undefined || shot.camera?.framing) notes.push(`Shot ${i + 1}: its camera framing and moves were not carried over; set them with set_clip_camera_move on its clips.`);
	});

	// Tracks: each group gets as many tracks as its clips need, packed so they never overlap.
	const lanes: { group: Group; id: string; ends: number[]; clips: typeof items }[] = [];
	for (const group of GROUPS) {
		const mine: (typeof lanes)[number][] = [];
		for (const item of items.filter((x) => x.group === group).sort((a, b) => a.clip.start - b.clip.start)) {
			let lane = group === 'base' ? mine[0] : mine.find((l) => l.ends.every((e) => e <= item.clip.start + 1e-6));
			if (!lane) mine.push((lane = { group, id: fresh(usedTracks, 'tpl-v'), ends: [], clips: [] }));
			lane.ends.push(item.clip.start + item.clip.duration);
			lane.clips.push(item);
		}
		lanes.push(...mine);
	}
	// Bottom to top in `lanes`; each new track goes in at the top, so the last is topmost.
	for (const lane of lanes) edits.push({ op: 'add_track', track: { id: lane.id, kind: 'video', name: `Template ${lane.group}` }, at: 0 });
	for (const lane of lanes) for (const item of lane.clips) edits.push({ op: 'add_clip', track: lane.id, clip: item.clip });
	return {
		edits,
		clips: lanes.flatMap((l) => l.clips.map((c) => c.clip.id)),
		tracks: lanes.map((l) => l.id).reverse(),
		assets,
		start: at,
		end: at + timing.total,
		placeholders,
		notes
	};
}
