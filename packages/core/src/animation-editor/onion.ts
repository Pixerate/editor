import { compileMotionScene, indexMotionNodes, type MotionProperty } from './compile.js';
import { motionFrameAt, motionFrameToSvg, type MotionSvgOptions } from './evaluate.js';
import type { MotionBlur, MotionRect, MotionScene } from './types.js';

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
	/** Motion blur (default: the scene's `motionBlur`; false for none). */
	motionBlur?: MotionBlur | false;
}

/**
 * The moments a frame at `time` averages for motion blur: spread across the shutter (centred on
 * `time`), as many as the fastest moving node needs to look smooth (about one per 1.5 document
 * units it travels), and just `[time]` when nothing moves.
 */
export function motionBlurTimes(scene: MotionScene, time: number, blur: MotionBlur = {}): number[] {
	const shutter = Math.min(720, Math.max(0, blur.shutter ?? 180));
	const most = Math.max(1, Math.min(32, Math.floor(blur.samples ?? 8)));
	const span = ((1000 / (scene.fps ?? 30)) * shutter) / 360;
	if (span <= 0 || most <= 1) return [time];
	const ids = motionMovingIds(scene);
	if (!ids.length) return [time];
	const a = indexMotionNodes(motionFrameAt(scene, time - span / 2).document.nodes);
	const b = indexMotionNodes(motionFrameAt(scene, time + span / 2).document.nodes);
	let travel = 0;
	for (const id of ids) {
		const p = a.get(id)?.bounds;
		const q = b.get(id)?.bounds;
		if (p && q) travel = Math.max(travel, Math.abs(p.x - q.x), Math.abs(p.y - q.y), Math.abs(p.x + p.width - q.x - q.width), Math.abs(p.y + p.height - q.y - q.height));
	}
	const n = Math.min(most, Math.ceil(travel / 1.5));
	if (n <= 1) return [time];
	return Array.from({ length: n }, (_, k) => time - span / 2 + (span * (k + 0.5)) / n);
}

/** Moments averaged into one picture: added (plus-lighter) at 1/n each in an isolated group, an exact average, transparency included. */
function averagedFrames(scene: MotionScene, times: readonly number[], options: MotionSvgOptions, prefix: string): string {
	const n = times.length;
	return `<g data-motion-blur="${n}" style="isolation:isolate">${times
		.map((t, k) => {
			const own = `${prefix}blur${k}-`;
			const frame = motionFrameToSvg(scene, t, { ...options, idPrefix: own, background: false });
			const view = /viewBox="([^"]*)"/.exec(frame)?.[1] ?? '';
			// Element ids stay on the last moment only, so the picture has each once.
			const inner = k === n - 1 ? innerSvg(frame) : innerSvg(frame).replace(new RegExp(` id="(?!${own.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})[^"]*"`, 'g'), '');
			return `<svg viewBox="${view}" preserveAspectRatio="none" style="mix-blend-mode:plus-lighter" opacity="${Math.round(10000 / n) / 10000}">${inner}</svg>`;
		})
		.join('')}</g>`;
}

/** The inside of a standalone SVG (between its root tags). */
const innerSvg = (svg: string) => svg.slice(svg.indexOf('>') + 1, svg.lastIndexOf('</svg>'));

/**
 * The frame at `time` as SVG with overlays: ghost frames under it (each with its own id prefix,
 * element ids dropped so they never clash) and motion paths over it. Without overlays it is
 * `motionFrameToSvg`.
 */
export function motionStageSvg(scene: MotionScene, time: number, options: MotionSvgOptions & MotionOverlayOptions = {}): string {
	const { onionSkin, motionPaths, motionPathColor, motionBlur, ...svgOptions } = options;
	const prefix = svgOptions.idPrefix ?? 'vg-';
	let current = motionFrameToSvg(scene, time, svgOptions);
	const blur = motionBlur === false ? undefined : (motionBlur ?? scene.motionBlur);
	const blurTimes = blur ? motionBlurTimes(scene, time, blur) : [time];
	if (blurTimes.length > 1) {
		// The background once, then the moments averaged over it (compositing is linear, so this is the average of whole frames).
		const open = current.indexOf('>') + 1;
		const body = current.slice(open, current.lastIndexOf('</svg>'));
		const bg = svgOptions.background !== false && scene.artwork.background ? (/^\s*<rect[^>]*\/>/.exec(body)?.[0] ?? '') : '';
		current = `${current.slice(0, open)}${bg}${averagedFrames(scene, blurTimes, svgOptions, prefix)}</svg>`;
	}
	if (!onionSkin && !motionPaths) return current;
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

export interface MotionContactSheetOptions extends MotionSvgOptions, MotionOverlayOptions {
	/** Frames a row (default: about square). */
	columns?: number;
	/** Write each frame's time (and shot) under it (default true). */
	labels?: boolean;
}

/**
 * Several moments of the scene in one SVG, in a grid with each frame's time and shot under it:
 * a contact sheet, to see a whole animation (or an agent's change to it) at a glance.
 */
export function motionContactSheetSvg(scene: MotionScene, times: readonly number[], options: MotionContactSheetOptions = {}): string {
	const { columns, labels = true, ...frameOptions } = options;
	const n = Math.max(1, times.length);
	const cols = Math.max(1, Math.min(n, Math.floor(columns ?? Math.ceil(Math.sqrt(n)))));
	const rows = Math.ceil(n / cols);
	const { width: w, height: h } = scene.artwork;
	const gap = Math.round(Math.max(w, h) * 0.04);
	const label = labels ? Math.round(Math.max(12, h * 0.08)) : 0;
	const timeline = compileMotionScene(scene);
	const W = cols * w + (cols + 1) * gap;
	const H = rows * (h + label) + (rows + 1) * gap;
	const prefix = frameOptions.idPrefix ?? 'vg-';
	const cells = times.map((t, i) => {
		const x = gap + (i % cols) * (w + gap);
		const y = gap + Math.floor(i / cols) * (h + label + gap);
		const frame = motionStageSvg(scene, t, { ...frameOptions, idPrefix: `${prefix}f${i}-` });
		const view = /viewBox="([^"]*)"/.exec(frame)?.[1] ?? `0 0 ${w} ${h}`;
		// Each frame keeps its own ids under its prefix; element ids are dropped so frames never clash.
		const inner = innerSvg(frame).replace(new RegExp(` id="(?!${`${prefix}f${i}-`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})[^"]*"`, 'g'), '');
		const shot = timeline.shots.find((s) => t >= s.start && t < s.end) ?? timeline.shots[timeline.shots.length - 1];
		const caption = labels ? `<text x="${x + w / 2}" y="${y + h + label * 0.8}" font-family="system-ui, sans-serif" font-size="${Math.round(label * 0.7)}" text-anchor="middle" fill="#64748b">${(t / 1000).toFixed(2)} s${shot ? ` · ${shot.id.replace(/[<&]/g, '')}` : ''}</text>` : '';
		return `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${view}" overflow="hidden">${inner}</svg><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#cbd5e1"/>${caption}`;
	});
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#f8fafc"/>${cells.join('')}</svg>`;
}
