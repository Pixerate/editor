import { compileMotionScene, indexMotionNodes, type MotionProperty } from './compile.js';
import { motionFrameAt, motionFrameToSvg, type MotionSvgOptions } from './evaluate.js';
import type { MotionRect, MotionScene } from './types.js';

/**
 * Seeing motion on a still: onion skin (faded frames either side of the playhead) and motion
 * paths (where each node's centre travels). Frames are pure functions of time, so both are just
 * more frames: no state, and the same picture every time.
 */

export interface MotionOnionSkin {
	/** Ghost frames before the playhead (default 2). */
	before?: number;
	/** Ghost frames after the playhead (default 0). */
	after?: number;
	/**
	 * Time between ghosts: ms (default 1000 / 12, every other frame at 24 fps), or `commands` to
	 * ghost the moments commands start and end around the playhead.
	 */
	spacing?: number | 'commands';
	/** Opacity of the nearest ghost (default 0.35); further ones fade as 1 / distance. */
	opacity?: number;
}

export interface MotionGhost {
	time: number;
	/** Negative before the playhead, positive after: 1 is the nearest. */
	offset: number;
	opacity: number;
}

/** The ghost frames for a playhead at `time`, nearest first on each side. */
export function motionGhosts(scene: MotionScene, time: number, onion: MotionOnionSkin = {}): MotionGhost[] {
	const before = Math.max(0, Math.floor(onion.before ?? 2));
	const after = Math.max(0, Math.floor(onion.after ?? 0));
	const base = Math.min(1, Math.max(0, onion.opacity ?? 0.35));
	const timeline = compileMotionScene(scene);
	const ghosts: MotionGhost[] = [];
	const push = (t: number, offset: number) => ghosts.push({ time: t, offset, opacity: Math.round((base / Math.abs(offset)) * 1000) / 1000 });
	if (onion.spacing === 'commands') {
		const marks = [...new Set(timeline.commands.flatMap((c) => [c.start, c.end]))].sort((a, b) => a - b);
		marks.filter((t) => t < time - 1e-6).reverse().slice(0, before).forEach((t, i) => push(t, -(i + 1)));
		marks.filter((t) => t > time + 1e-6).slice(0, after).forEach((t, i) => push(t, i + 1));
		return ghosts;
	}
	const spacing = typeof onion.spacing === 'number' && onion.spacing > 0 ? onion.spacing : 1000 / 12;
	for (let i = 1; i <= before && time - i * spacing >= 0; i++) push(time - i * spacing, -i);
	for (let i = 1; i <= after && time + i * spacing <= timeline.duration; i++) push(time + i * spacing, i);
	return ghosts;
}

export interface MotionPathOptions {
	/** From this time, ms (default 0). */
	from?: number;
	/** To this time, ms (default the end). */
	to?: number;
	/** Time between samples, ms (default 1000 / 30; at most 400 samples). */
	step?: number;
}

export interface MotionPath {
	id: string;
	/** Where the node's centre is, in document units, sample by sample. */
	points: { t: number; x: number; y: number }[];
	/** Where it is when a change that moves it (or a group it is in) starts or ends. */
	keys: { t: number; x: number; y: number }[];
}

const MOVING: MotionProperty[] = ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'follow', 'shape'];

/** Ids of the nodes whose place changes (they or a group they are in move, turn, scale, follow or morph). */
export function motionMovingIds(scene: MotionScene): string[] {
	const timeline = compileMotionScene(scene);
	const nodes = indexMotionNodes(scene.artwork.nodes);
	const moving = new Set(timeline.segments.filter((s) => s.node && MOVING.includes(s.property)).map((s) => s.node));
	return [...nodes.values()].filter((e) => e.node.visible !== false && (moving.has(e.node.id) || e.ancestors.some((a) => moving.has(a)))).map((e) => e.node.id);
}

/** Where a node's centre travels over time (its bounds as drawn, in document units). */
export function motionPath(scene: MotionScene, id: string, options: MotionPathOptions = {}): MotionPath {
	const nodes = indexMotionNodes(scene.artwork.nodes);
	const entry = nodes.get(id);
	if (!entry) throw new Error(`There is no element "${id}" in the artwork.`);
	const timeline = compileMotionScene(scene);
	const from = Math.max(0, options.from ?? 0);
	const to = Math.min(timeline.duration, options.to ?? timeline.duration);
	let step = options.step && options.step > 0 ? options.step : 1000 / 30;
	if ((to - from) / step > 400) step = (to - from) / 400;
	const r = (n: number) => Math.round(n * 100) / 100;
	const centreAt = (t: number) => {
		const node = indexMotionNodes(motionFrameAtCache(scene, t)).get(id);
		const b = node?.bounds;
		return b ? { t: r(t), x: r(b.x + b.width / 2), y: r(b.y + b.height / 2) } : null;
	};
	const points: MotionPath['points'] = [];
	for (let t = from; t <= to + 1e-6; t += step) {
		const p = centreAt(Math.min(t, to));
		if (p) points.push(p);
	}
	const owners = new Set([id, ...entry.ancestors]);
	const times = [...new Set(timeline.segments.filter((s) => owners.has(s.node) && MOVING.includes(s.property)).flatMap((s) => [s.start, s.end]))].filter((t) => t >= from && t <= to).sort((a, b) => a - b);
	const keys = times.map(centreAt).filter((p): p is NonNullable<typeof p> => p !== null);
	return { id, points, keys };
}

function motionFrameAtCache(scene: MotionScene, t: number) {
	return motionFrameAt(scene, t).document.nodes;
}

/** Motion paths as an SVG overlay: a line per node and a dot where each change starts or ends. Stroke widths follow the camera so they read the same at any zoom. */
export function motionPathsSvg(paths: readonly MotionPath[], camera: MotionRect, color = '#f43f5e'): string {
	const w = Math.max(camera.width, camera.height) / 400;
	const f = (n: number) => String(Math.round(n * 100) / 100);
	return paths
		.filter((p) => p.points.length > 1)
		.map(
			(p) =>
				`<g data-motion-path="${p.id.replace(/"/g, '&quot;')}" fill="none" stroke="${color}" stroke-width="${f(w)}" stroke-linecap="round" stroke-linejoin="round" opacity="0.8"><polyline points="${p.points.map((q) => `${f(q.x)},${f(q.y)}`).join(' ')}" stroke-dasharray="${f(w * 3)} ${f(w * 2)}"/>${p.keys.map((k) => `<circle cx="${f(k.x)}" cy="${f(k.y)}" r="${f(w * 2.5)}" fill="${color}" stroke="none"/>`).join('')}</g>`
		)
		.join('');
}

/** What the stage can draw over a frame. */
export interface MotionOverlayOptions {
	/** Faded frames either side of the playhead. */
	onionSkin?: MotionOnionSkin;
	/** Draw where nodes travel: true for every node whose place changes, or a list of ids. */
	motionPaths?: boolean | readonly string[];
	/** Colour of motion paths (default `#f43f5e`). */
	motionPathColor?: string;
}

/** The inside of a standalone SVG (between its root tags). */
const innerSvg = (svg: string) => svg.slice(svg.indexOf('>') + 1, svg.lastIndexOf('</svg>'));

/**
 * The frame at `time` as SVG with overlays: ghost frames under it (each with its own id prefix,
 * element ids dropped so they never clash) and motion paths over it. Without overlays it is
 * `motionFrameToSvg`.
 */
export function motionStageSvg(scene: MotionScene, time: number, options: MotionSvgOptions & MotionOverlayOptions = {}): string {
	const { onionSkin, motionPaths, motionPathColor, ...svgOptions } = options;
	const current = motionFrameToSvg(scene, time, svgOptions);
	if (!onionSkin && !motionPaths) return current;
	const prefix = svgOptions.idPrefix ?? 'vg-';
	const ghosts = onionSkin
		? motionGhosts(scene, time, onionSkin).map((g, i) => {
				const own = `${prefix}ghost${i}-`;
				const inner = innerSvg(motionFrameToSvg(scene, g.time, { ...svgOptions, idPrefix: own, background: false })).replace(new RegExp(` id="(?!${own.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})[^"]*"`, 'g'), '');
				return `<g data-onion="${g.offset < 0 ? 'before' : 'after'}" opacity="${g.opacity}">${inner}</g>`;
			})
		: [];
	const camera = motionFrameAt(scene, time).camera;
	const ids = motionPaths === true ? motionMovingIds(scene) : motionPaths ? [...motionPaths] : [];
	const paths = ids.length ? motionPathsSvg(ids.map((id) => motionPath(scene, id)), camera, motionPathColor) : '';
	// Ghosts go under everything but the background, paths over everything.
	const open = current.indexOf('>') + 1;
	const close = current.lastIndexOf('</svg>');
	const body = current.slice(open, close);
	const bg = svgOptions.background !== false && scene.artwork.background ? /^\s*<rect[^>]*\/>/.exec(body)?.[0] ?? '' : '';
	return `${current.slice(0, open)}${bg}${ghosts.join('')}${body.slice(bg.length)}${paths}</svg>`;
}
