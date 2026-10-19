/**
 * Proxies: smaller copies of an asset's media the preview plays instead of the original, so
 * editing stays smooth on large footage. They live on the asset (`VideoAsset.proxies`); the preview
 * picks one by its preview scale; the export, EDL and agents' source times always use the original.
 */
import { videoShellQuote } from './export.js';
import type { VideoAsset, VideoAssetProxy, VideoProject } from './types.js';

/**
 * How large a picture the preview plays: `full` (the original), a fraction (0.5 = half size, using
 * the smallest proxy at least that large), or `auto` (what the preview canvas shows).
 */
export type VideoPreviewScale = 'auto' | 'full' | number;
/** The scales a preview-scale control offers, besides `auto` and `full`. */
export const VIDEO_PROXY_SCALES = [0.5, 0.25] as const;

/** The proxy the preview plays at `scale` (0–1]: the smallest at least that large, else `null` (play the original). */
export function videoAssetProxy(asset: Pick<VideoAsset, 'proxies'> | undefined, scale: number): VideoAssetProxy | null {
	if (!asset?.proxies?.length || !(scale > 0) || scale >= 1) return null;
	let best: VideoAssetProxy | null = null;
	for (const p of asset.proxies) if (p.scale >= scale - 1e-9 && p.scale < 1 && (!best || p.scale < best.scale)) best = p;
	return best;
}

/** The `src` the preview plays for an asset at `scale`: a proxy's, or the original's. */
export const videoPreviewSrc = (asset: VideoAsset | undefined, scale: number, fallback = asset?.src ?? ''): string => videoAssetProxy(asset, scale)?.src ?? fallback;

/** A preview scale as a fraction: `full` is 1, `auto` is `shown` (the canvas's resolution, at most 1). */
export function resolveVideoPreviewScale(scale: VideoPreviewScale | undefined, shown: number): number {
	if (scale === undefined || scale === 'auto') return Math.min(1, Math.max(0, shown));
	if (scale === 'full') return 1;
	return Math.min(1, Math.max(0, scale));
}

export interface VideoProxyOptions {
	/** Size of the proxy as a fraction of the original (default 0.5). */
	scale?: number;
	/** Output file (default: the source's name with `.proxy-50.mp4`, for scale 0.5). */
	output?: string;
	/** The path or URL ffmpeg should open (default the asset's `src`). */
	resolve?: (asset: VideoAsset) => string;
	/** Frames between keyframes (default 12): short, so seeking and scrubbing decode little. */
	gop?: number;
	/** x264 quality (default 28: small files; proxies are for editing, not viewing). */
	crf?: number;
}

/** A proxy's file name next to `src`: `clip.mov` at 0.5 → `clip.proxy-50.mp4`. */
export function videoProxyName(src: string, scale = 0.5): string {
	const clean = src.replace(/[?#].*$/, '');
	const base = clean.replace(/\.[^./\\]+$/, '');
	return `${base}.proxy-${Math.round(scale * 100)}.mp4`;
}

/** An ffmpeg command making an asset's proxy, and the proxy entry to add once it exists. */
export interface VideoProxyCommand {
	asset: string;
	args: string[];
	/** One shell line. */
	command: string;
	/** The entry for `VideoAsset.proxies` (its `src` is the output; map it to a URL the preview can load if needed). */
	proxy: VideoAssetProxy;
}

/**
 * The ffmpeg command for a proxy of a video asset: scaled to `scale` (even sizes), H.264 with a
 * short keyframe interval (`gop`) and no B-frames so seeking is cheap, `fastdecode`, the sound
 * kept as AAC, and `faststart` so a browser can play it while it loads.
 */
export function videoProxyFfmpeg(asset: VideoAsset, options: VideoProxyOptions = {}): VideoProxyCommand {
	if (asset.kind !== 'video') throw new Error(`Asset "${asset.id}" is ${asset.kind === 'image' ? 'an image' : 'audio'}; only video assets have proxies.`);
	const scale = options.scale ?? 0.5;
	if (!(scale > 0 && scale < 1)) throw new Error(`A proxy's scale must be between 0 and 1 (not including either), not ${scale}; 0.5 is half size.`);
	const gop = Math.max(1, Math.round(options.gop ?? 12));
	const output = options.output ?? videoProxyName(asset.src, scale);
	const src = options.resolve ? options.resolve(asset) : asset.src;
	const size = `scale=trunc(iw*${scale}/2)*2:trunc(ih*${scale}/2)*2`;
	const args = [
		'-y',
		'-i',
		src,
		'-vf',
		size,
		'-c:v',
		'libx264',
		'-preset',
		'veryfast',
		'-tune',
		'fastdecode',
		'-crf',
		String(options.crf ?? 28),
		'-g',
		String(gop),
		'-keyint_min',
		String(gop),
		'-sc_threshold',
		'0',
		'-bf',
		'0',
		'-pix_fmt',
		'yuv420p',
		...(asset.hasAudio === false ? ['-an'] : ['-c:a', 'aac', '-b:a', '128k']),
		'-movflags',
		'+faststart',
		output
	];
	const proxy: VideoAssetProxy = { scale, src: output, ...(asset.width && asset.height ? { width: Math.trunc((asset.width * scale) / 2) * 2, height: Math.trunc((asset.height * scale) / 2) * 2 } : {}) };
	return { asset: asset.id, args, command: ['ffmpeg', ...args].map(videoShellQuote).join(' '), proxy };
}

/** Commands for every video asset (or those listed) without a proxy at `scale`. */
export function videoProxyPlan(project: VideoProject, options: VideoProxyOptions & { assets?: readonly string[]; output?: never } = {}): VideoProxyCommand[] {
	const scale = options.scale ?? 0.5;
	const wanted = options.assets ? new Set(options.assets) : null;
	if (options.assets) for (const id of options.assets) {
		const a = project.assets.find((x) => x.id === id);
		if (!a) throw new Error(`There is no asset "${id}"; the assets are ${project.assets.map((x) => `"${x.id}"`).join(', ') || 'none'}.`);
		if (a.kind !== 'video') throw new Error(`Asset "${id}" is ${a.kind === 'image' ? 'an image' : 'audio'}; only video assets have proxies.`);
	}
	return project.assets
		.filter((a) => a.kind === 'video' && (!wanted || wanted.has(a.id)) && !a.proxies?.some((p) => Math.abs(p.scale - scale) < 1e-9))
		.map((a) => videoProxyFfmpeg(a, { ...options, scale }));
}

/** The choices a preview-size control offers, with labels: `value` round-trips through `parseVideoPreviewScale`. */
export const VIDEO_PREVIEW_SCALE_OPTIONS: readonly { value: string; label: string; scale: VideoPreviewScale }[] = [
	{ value: 'auto', label: 'Auto', scale: 'auto' },
	{ value: 'full', label: 'Full', scale: 'full' },
	...VIDEO_PROXY_SCALES.map((s) => ({ value: String(s), label: s === 0.5 ? '½' : s === 0.25 ? '¼' : `${s * 100}%`, scale: s }))
];

/** A preview-size control's value back as a scale (`auto` for anything unknown). */
export const parseVideoPreviewScale = (value: string): VideoPreviewScale => (value === 'full' ? 'full' : Number(value) > 0 && Number(value) <= 1 ? Number(value) : 'auto');

/** Whether any asset has proxies (so a preview-size control is worth showing). */
export const videoProjectHasProxies = (project: VideoProject): boolean => project.assets.some((a) => !!a.proxies?.length);
