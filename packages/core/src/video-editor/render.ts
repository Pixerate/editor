import { videoFrameAt, type VideoFrame, type VideoLayer, type VideoRect } from './evaluate.js';
import { formatVideoTimecode } from './timeline.js';
import type { VideoProject } from './types.js';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => String(Math.round(v * 100) / 100);

/** The part of a rect a wipe shows. */
export function videoWipeRect(rect: VideoRect, wipe: NonNullable<VideoLayer['wipe']>): VideoRect {
	const { direction, progress } = wipe;
	const w = rect.width * progress;
	const h = rect.height * progress;
	if (direction === 'right') return { ...rect, width: w };
	if (direction === 'left') return { ...rect, x: rect.x + rect.width - w, width: w };
	if (direction === 'down') return { ...rect, height: h };
	return { ...rect, y: rect.y + rect.height - h, height: h };
}

export interface VideoSvgOptions {
	/**
	 * The picture for a media layer: return an href (URL or data URL) to draw, or `null` for a
	 * labelled placeholder. Default: images use `src`, videos their `poster`, else a placeholder.
	 */
	imageFor?: (layer: VideoLayer, frame: VideoFrame) => string | null;
	/** Frame rate for the timecode on placeholders (default 30). */
	fps?: number;
}

/** A frame as standalone SVG: images and posters as `<image>`, video without one as a labelled box. */
export function videoFrameToSvg(frame: VideoFrame, options: VideoSvgOptions = {}, assets: VideoProject['assets'] = []): string {
	const defs: string[] = [];
	const body: string[] = [];
	const posters = new Map(assets.map((a) => [a.id, a.poster]));
	frame.layers.forEach((layer, i) => {
		const { rect } = layer;
		const attrs: string[] = [];
		if (layer.opacity < 1) attrs.push(`opacity="${n(layer.opacity)}"`);
		if (layer.rotation) attrs.push(`transform="rotate(${n(layer.rotation)} ${n(rect.x + rect.width / 2)} ${n(rect.y + rect.height / 2)})"`);
		if (layer.wipe) {
			const r = videoWipeRect(rect, layer.wipe);
			defs.push(`<clipPath id="w${i}"><rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}"/></clipPath>`);
			attrs.push(`clip-path="url(#w${i})"`);
		}
		const box = `x="${n(rect.x)}" y="${n(rect.y)}" width="${n(rect.width)}" height="${n(rect.height)}"`;
		let inner = '';
		if (layer.type === 'color') inner = `<rect ${box} fill="${esc(layer.color ?? '#000000')}"/>`;
		else if (layer.type === 'text' && layer.text) {
			const t = layer.text;
			const lines = t.text.split('\n');
			const lh = t.fontSize * 1.2;
			const cx = rect.x + rect.width / 2;
			const cy = rect.y + rect.height / 2;
			const top = cy - (lh * (lines.length - 1)) / 2;
			if (t.background) {
				const w = Math.max(...lines.map((l) => l.length)) * t.fontSize * 0.6 + t.fontSize;
				const h = lh * lines.length + t.fontSize * 0.4;
				inner += `<rect x="${n(cx - w / 2)}" y="${n(cy - h / 2)}" width="${n(w)}" height="${n(h)}" fill="${esc(t.background)}"/>`;
			}
			inner += `<text x="${n(cx)}" text-anchor="middle" dominant-baseline="central" font-family="${esc(t.fontFamily)}" font-size="${n(t.fontSize)}" font-weight="${t.fontWeight}" fill="${esc(t.color)}">${lines.map((l, k) => `<tspan x="${n(cx)}" y="${n(top + k * lh)}">${esc(l)}</tspan>`).join('')}</text>`;
		} else {
			const href = options.imageFor ? options.imageFor(layer, frame) : layer.assetKind === 'image' ? (layer.src ?? null) : (posters.get(layer.asset ?? '') ?? null);
			if (href) inner = `<image href="${esc(href)}" ${box} preserveAspectRatio="none"/>`;
			else {
				const label = `${layer.asset ?? layer.clip} · ${formatVideoTimecode(layer.sourceTime ?? 0, options.fps ?? 30)}`;
				const size = Math.max(10, Math.min(rect.height / 8, rect.width / Math.max(8, label.length * 0.6)));
				inner = `<rect ${box} fill="#334155" stroke="#94a3b8" stroke-width="2"/><text x="${n(rect.x + rect.width / 2)}" y="${n(rect.y + rect.height / 2)}" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-size="${n(size)}" fill="#e2e8f0">${esc(label)}</text>`;
			}
		}
		body.push(attrs.length ? `<g ${attrs.join(' ')}>${inner}</g>` : inner);
	});
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(frame.width)} ${n(frame.height)}" width="${n(frame.width)}" height="${n(frame.height)}">${defs.length ? `<defs>${defs.join('')}</defs>` : ''}<rect width="100%" height="100%" fill="${esc(frame.background)}"/>${body.join('')}</svg>`;
}

/** The project at `time` as SVG. */
export function videoProjectSvg(project: VideoProject, time: number, options: VideoSvgOptions = {}): string {
	return videoFrameToSvg(videoFrameAt(project, time), { fps: project.fps, ...options }, project.assets);
}

/** Several moments in one labelled picture, `columns` a row, each frame scaled to `width` pixels. */
export function videoContactSheetSvg(project: VideoProject, times: readonly number[], options: VideoSvgOptions & { columns?: number; width?: number } = {}): string {
	const columns = options.columns ?? Math.ceil(Math.sqrt(times.length));
	const w = options.width ?? 320;
	const h = (w * project.height) / project.width;
	const label = 18;
	const gap = 8;
	const rows = Math.ceil(times.length / columns);
	const W = columns * w + (columns + 1) * gap;
	const H = rows * (h + label) + (rows + 1) * gap;
	const cells = times.map((t, i) => {
		const x = gap + (i % columns) * (w + gap);
		const y = gap + Math.floor(i / columns) * (h + label + gap);
		const svg = videoProjectSvg(project, t, options).replace(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/, `<svg x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"`).replace(/ width="[\d.]+" height="[\d.]+">/, '>');
		return `${svg}<text x="${n(x)}" y="${n(y + h + 14)}" font-family="sans-serif" font-size="12" fill="#0f172a">${(t / 1000).toFixed(2)} s · ${formatVideoTimecode(t, project.fps)}</text>`;
	});
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(W)} ${n(H)}" width="${n(W)}" height="${n(H)}"><rect width="100%" height="100%" fill="#f8fafc"/>${cells.join('')}</svg>`;
}

/** The subset of `CanvasRenderingContext2D` `drawVideoFrame` uses (so tests and workers can pass their own). */
export type VideoCanvasContext = Pick<
	CanvasRenderingContext2D,
	'save' | 'restore' | 'fillRect' | 'drawImage' | 'translate' | 'rotate' | 'beginPath' | 'rect' | 'clip' | 'fillText' | 'measureText' | 'setTransform'
> & { globalAlpha: number; fillStyle: string | CanvasGradient | CanvasPattern; font: string; textAlign: CanvasTextAlign; textBaseline: CanvasTextBaseline; strokeStyle: string | CanvasGradient | CanvasPattern; lineWidth: number; strokeRect(x: number, y: number, w: number, h: number): void };

/**
 * Draws a frame on a 2D canvas scaled by `scale` (canvas pixels per frame pixel). `sourceFor`
 * returns what to draw for a media layer (a `<video>` seeked to `layer.sourceTime`, an `<img>`,
 * an `ImageBitmap`…) or `null` for a placeholder box.
 */
export function drawVideoFrame(ctx: VideoCanvasContext, frame: VideoFrame, sourceFor: (layer: VideoLayer) => CanvasImageSource | null, scale = 1): void {
	ctx.save();
	ctx.setTransform(scale, 0, 0, scale, 0, 0);
	ctx.globalAlpha = 1;
	ctx.fillStyle = frame.background;
	ctx.fillRect(0, 0, frame.width, frame.height);
	for (const layer of frame.layers) {
		const { rect } = layer;
		ctx.save();
		ctx.globalAlpha = layer.opacity;
		if (layer.rotation) {
			ctx.translate(rect.x + rect.width / 2, rect.y + rect.height / 2);
			ctx.rotate((layer.rotation * Math.PI) / 180);
			ctx.translate(-(rect.x + rect.width / 2), -(rect.y + rect.height / 2));
		}
		if (layer.wipe) {
			const r = videoWipeRect(rect, layer.wipe);
			ctx.beginPath();
			ctx.rect(r.x, r.y, r.width, r.height);
			ctx.clip();
		}
		if (layer.type === 'color') {
			ctx.fillStyle = layer.color ?? '#000000';
			ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
		} else if (layer.type === 'text' && layer.text) {
			const t = layer.text;
			const lines = t.text.split('\n');
			const lh = t.fontSize * 1.2;
			const cx = rect.x + rect.width / 2;
			const top = rect.y + rect.height / 2 - (lh * (lines.length - 1)) / 2;
			ctx.font = `${t.fontWeight} ${t.fontSize}px ${t.fontFamily}`;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			if (t.background) {
				const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + t.fontSize;
				const h = lh * lines.length + t.fontSize * 0.4;
				ctx.fillStyle = t.background;
				ctx.fillRect(cx - w / 2, rect.y + rect.height / 2 - h / 2, w, h);
			}
			ctx.fillStyle = t.color;
			lines.forEach((l, k) => ctx.fillText(l, cx, top + k * lh));
		} else {
			const source = sourceFor(layer);
			if (source) ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height);
			else {
				ctx.fillStyle = '#334155';
				ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
				ctx.strokeStyle = '#94a3b8';
				ctx.lineWidth = 2;
				ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
			}
		}
		ctx.restore();
	}
	ctx.restore();
}
