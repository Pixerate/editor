/**
 * A cache of decoded source frames for the preview, with prefetch ahead of the playhead, after the
 * way Blender's sequencer caches strips: scrubbing and stepping show cached frames at once instead
 * of waiting for a `<video>` to seek. It is host-side and optional: give a `VideoFrameCache` to the
 * controller (`frameCache`) or the preview engine.
 *
 * Frames are keyed by the file the preview plays (the asset's `src`, or the proxy it picks) and the
 * source frame, not by clip: every clip of an asset shares them, and edits never invalidate them.
 * Eviction removes the frames furthest from the playhead, counting frames behind it (against the
 * play direction) as further, and never touches the prefetch window.
 */
import { videoFrameAt, videoFrameLeafLayers, type VideoLayer } from './evaluate.js';
import type { VideoProject } from './types.js';

/** The source frame showing at a source time (ms) on an `fps` grid: a frame shows from its start. */
export const videoSourceFrame = (sourceTime: number, fps: number): number => Math.max(0, Math.floor((sourceTime * fps) / 1000 + 1e-6));

/** The middle of a source frame (ms): where a decoder should seek, away from the frame's edges. */
export const videoSourceFrameTime = (frame: number, fps: number): number => ((frame + 0.5) * 1000) / fps;

/** A cache key: the file and the source frame. */
export const videoFrameCacheKey = (src: string, frame: number): string => `${frame}@${src}`;

/** A frame the preview will need: the file, the source frame and when on the timeline it shows. */
export interface VideoFrameRequest {
	key: string;
	src: string;
	frame: number;
	/** Where to seek in the source (ms): the middle of the frame. */
	sourceTime: number;
	/** When it shows on the timeline (ms). */
	time: number;
}

/** The video layers' source frames at timeline `time`, as the preview would play them. */
export function videoFrameRequestsAt(project: VideoProject, time: number, srcFor: (layer: VideoLayer) => string | undefined = (l) => l.src): VideoFrameRequest[] {
	const out: VideoFrameRequest[] = [];
	// Media inside compound clips is decoded like any other.
	for (const layer of videoFrameLeafLayers(videoFrameAt(project, time).layers)) {
		if (layer.type !== 'media' || layer.assetKind !== 'video') continue;
		const src = srcFor(layer);
		if (!src) continue;
		const frame = videoSourceFrame(layer.sourceTime ?? 0, project.fps);
		out.push({ key: videoFrameCacheKey(src, frame), src, frame, sourceTime: videoSourceFrameTime(frame, project.fps), time });
	}
	return out;
}

/**
 * The frames to have ready from `time` over the next `window` ms (backwards with `direction` -1),
 * a frame apart, nearest first, each key once.
 */
export function planVideoPrefetch(project: VideoProject, time: number, options: { window?: number; direction?: 1 | -1; srcFor?: (layer: VideoLayer) => string | undefined } = {}): VideoFrameRequest[] {
	const window = options.window ?? 2000;
	const dir = options.direction ?? 1;
	const step = 1000 / project.fps;
	const seen = new Set<string>();
	const out: VideoFrameRequest[] = [];
	for (let i = 0; i * step <= window + 1e-6; i++) {
		const t = time + dir * i * step;
		if (t < 0) break;
		for (const r of videoFrameRequestsAt(project, t, options.srcFor)) {
			if (seen.has(r.key)) continue;
			seen.add(r.key);
			out.push(r);
		}
	}
	return out;
}

/** A cached frame's bookkeeping for eviction. */
export interface VideoCacheEntryInfo {
	key: string;
	/** When it last showed (or will show) on the timeline (ms). */
	time: number;
	bytes: number;
}

/**
 * Which entries to drop to get under `maxBytes`: never those in the prefetch window
 * (`protect`), then the furthest from the playhead first, with frames behind it (against
 * `direction`) counted `behind` times as far (default 2), so the way you are going is kept.
 */
export function videoCacheEvictions(entries: readonly VideoCacheEntryInfo[], options: { playhead: number; maxBytes: number; direction?: 1 | -1; behind?: number; protect?: ReadonlySet<string> }): string[] {
	let total = entries.reduce((n, e) => n + e.bytes, 0);
	if (total <= options.maxBytes) return [];
	const dir = options.direction ?? 1;
	const behind = options.behind ?? 2;
	const cost = (e: VideoCacheEntryInfo) => {
		const d = (e.time - options.playhead) * dir;
		return d >= 0 ? d : -d * behind;
	};
	const out: string[] = [];
	for (const e of entries.filter((x) => !options.protect?.has(x.key)).sort((a, b) => cost(b) - cost(a))) {
		if (total <= options.maxBytes) break;
		out.push(e.key);
		total -= e.bytes;
	}
	return out;
}

/** A decoded frame: anything `drawImage` takes, with its size (`close` is called when it is evicted). */
export interface VideoDecodedFrame {
	image: CanvasImageSource & { close?: () => void };
	width: number;
	height: number;
}

/** Decodes the frame of `src` at a source time (ms). */
export type VideoFrameDecoder = (src: string, sourceTime: number) => Promise<VideoDecodedFrame>;

export interface VideoFrameCacheOptions {
	/** How frames are decoded for prefetch (default in a browser: `createVideoElementDecoder()`; elsewhere none, so only frames the preview hands over are kept). */
	decode?: VideoFrameDecoder | null;
	/** Memory budget in bytes (4 a pixel; default 512 MB). */
	maxBytes?: number;
	/** How far ahead of the playhead to prefetch (ms, default 2000; 0 turns prefetch off). */
	prefetch?: number;
	/** How much further frames behind the playhead count when evicting (default 2). */
	behind?: number;
	/** Frames decoded at once (default 2). */
	concurrency?: number;
	/** Copies a ready media element's current picture (default `createImageBitmap`), to keep frames the preview has shown. */
	capture?: (source: CanvasImageSource) => Promise<VideoDecodedFrame | null>;
}

/** The cache's state, for a status line and agents. */
export interface VideoFrameCacheStats {
	frames: number;
	bytes: number;
	maxBytes: number;
	hits: number;
	misses: number;
	/** Frames being decoded or waiting to be. */
	pending: number;
	prefetch: number;
}

interface Entry extends VideoCacheEntryInfo {
	frame: VideoDecodedFrame;
}

const defaultCapture = async (source: CanvasImageSource): Promise<VideoDecodedFrame | null> => {
	if (typeof createImageBitmap !== 'function') return null;
	const image = await createImageBitmap(source as ImageBitmapSource);
	return { image, width: image.width, height: image.height };
};

/**
 * Decoded source frames for the preview, filled ahead of the playhead and evicted by distance from
 * it (see the module notes). `VideoPreviewEngine` calls `update` as the playhead moves, draws hits
 * from `get` while paused or while an element seeks, and hands over frames it has shown.
 */
export class VideoFrameCache {
	private readonly entries = new Map<string, Entry>();
	private readonly inFlight = new Set<string>();
	private queue: VideoFrameRequest[] = [];
	private protect = new Set<string>();
	private readonly listeners = new Set<() => void>();
	private playhead = 0;
	private direction: 1 | -1 = 1;
	private hits = 0;
	private misses = 0;
	private bytes = 0;
	private generation = 0;
	private destroyed = false;
	private srcFor: ((layer: VideoLayer) => string | undefined) | undefined;
	readonly maxBytes: number;
	readonly prefetch: number;
	private readonly decode: VideoFrameDecoder | null;

	constructor(private readonly options: VideoFrameCacheOptions = {}) {
		this.maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
		this.prefetch = options.prefetch ?? 2000;
		this.decode = options.decode !== undefined ? options.decode : typeof document !== 'undefined' ? createVideoElementDecoder() : null;
	}

	/** The cached frame of `src` showing at a source time (ms), on the project's `fps` grid. Counts a hit or a miss. */
	get(src: string, sourceTime: number, fps: number): CanvasImageSource | undefined {
		const entry = this.entries.get(videoFrameCacheKey(src, videoSourceFrame(sourceTime, fps)));
		if (entry) this.hits++;
		else this.misses++;
		return entry?.frame.image;
	}

	/** Whether a frame is cached, without counting it. */
	has(src: string, sourceTime: number, fps: number): boolean {
		return this.entries.has(videoFrameCacheKey(src, videoSourceFrame(sourceTime, fps)));
	}

	/** Keeps a decoded frame (replacing any with the same key), then evicts to the budget. */
	put(request: Pick<VideoFrameRequest, 'key' | 'time'>, frame: VideoDecodedFrame): void {
		if (this.destroyed) return void frame.image.close?.();
		const old = this.entries.get(request.key);
		if (old) this.drop(old);
		const bytes = Math.max(1, frame.width * frame.height * 4);
		this.entries.set(request.key, { key: request.key, time: request.time, bytes, frame });
		this.bytes += bytes;
		this.evict();
		this.emit();
	}

	/** Keeps what a ready media element shows now as the frame of `src` at `sourceTime` (async; does nothing if it is cached). */
	capture(src: string, sourceTime: number, fps: number, time: number, source: CanvasImageSource): void {
		const frame = videoSourceFrame(sourceTime, fps);
		const key = videoFrameCacheKey(src, frame);
		if (this.entries.has(key) || this.inFlight.has(key)) return;
		this.inFlight.add(key);
		void (this.options.capture ?? defaultCapture)(source)
			.then((f) => {
				if (f) this.put({ key, time }, f);
			})
			.catch(() => {})
			.finally(() => this.inFlight.delete(key));
	}

	/**
	 * Follows the playhead: protects the prefetch window, evicts to the budget, and queues the
	 * window's missing frames for decoding (nearest first). `srcFor` gives the file a layer plays.
	 */
	update(project: VideoProject, time: number, options: { playing?: boolean; direction?: 1 | -1; srcFor?: (layer: VideoLayer) => string | undefined } = {}): void {
		if (this.destroyed) return;
		this.direction = options.direction ?? (time < this.playhead && !options.playing ? -1 : 1);
		this.playhead = time;
		this.srcFor = options.srcFor;
		const plan = this.prefetch > 0 ? planVideoPrefetch(project, time, { window: this.prefetch, direction: this.direction, srcFor: options.srcFor }) : videoFrameRequestsAt(project, time, options.srcFor);
		this.protect = new Set(plan.map((r) => r.key));
		// Frames in the window show soon: their timeline time is now where they will be needed.
		for (const r of plan) {
			const e = this.entries.get(r.key);
			if (e) e.time = r.time;
		}
		this.evict();
		this.generation++;
		this.queue = this.decode ? plan.filter((r) => !this.entries.has(r.key) && !this.inFlight.has(r.key)) : [];
		this.pump();
	}

	/**
	 * The stretches of the timeline whose video frames are all cached, between `from` and `to` (ms),
	 * for the files the preview last played (its `srcFor`, e.g. proxies) unless `srcFor` is given.
	 * `step` (ms, at least a frame) samples more coarsely.
	 */
	cachedRanges(project: VideoProject, options: { from?: number; to?: number; srcFor?: (layer: VideoLayer) => string | undefined; step?: number } = {}): { start: number; end: number }[] {
		// One check a frame by default; a coarser `step` (ms) suits drawing a long timeline.
		const step = Math.max(1000 / project.fps, options.step ?? 0);
		const from = Math.max(0, options.from ?? 0);
		const to = options.to ?? Math.max(...project.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)), 0);
		const out: { start: number; end: number }[] = [];
		for (let t = from; t < to - 1e-6; t += step) {
			const requests = videoFrameRequestsAt(project, t, options.srcFor ?? this.srcFor);
			const cached = requests.length > 0 && requests.every((r) => this.entries.has(r.key));
			const last = out[out.length - 1];
			if (!cached) continue;
			const end = Math.min(to, t + step);
			if (last && Math.abs(last.end - t) < 1e-6) last.end = end;
			else out.push({ start: t, end });
		}
		return out.map((r) => ({ start: Math.round(r.start * 10) / 10, end: Math.round(r.end * 10) / 10 }));
	}

	stats(): VideoFrameCacheStats {
		return { frames: this.entries.size, bytes: this.bytes, maxBytes: this.maxBytes, hits: this.hits, misses: this.misses, pending: this.inFlight.size + this.queue.length, prefetch: this.prefetch };
	}

	/** Called when frames arrive or leave. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Drops every frame (closing them) and the queue. */
	clear(): void {
		for (const e of [...this.entries.values()]) this.drop(e);
		this.queue = [];
		this.generation++;
		this.emit();
	}

	/** Clears and stops decoding for good. */
	destroy(): void {
		this.clear();
		this.destroyed = true;
		this.listeners.clear();
	}

	private pump() {
		const limit = Math.max(1, this.options.concurrency ?? 2);
		while (this.decode && this.inFlight.size < limit && this.queue.length) {
			const r = this.queue.shift()!;
			if (this.entries.has(r.key) || this.inFlight.has(r.key)) continue;
			// Stop filling once the window alone is at the budget: decoding more would only evict it.
			if (this.bytes >= this.maxBytes && [...this.entries.keys()].every((k) => this.protect.has(k))) {
				this.queue = [];
				break;
			}
			const generation = this.generation;
			this.inFlight.add(r.key);
			this.decode(r.src, r.sourceTime)
				.then(
					(frame) => {
						this.inFlight.delete(r.key);
						// A frame that left the window while it decoded is still worth keeping if there is room.
						if (generation === this.generation || this.bytes + frame.width * frame.height * 4 <= this.maxBytes) this.put(r, frame);
						else frame.image.close?.();
					},
					() => this.inFlight.delete(r.key)
				)
				.finally(() => this.pump());
		}
	}

	private evict() {
		const drop = videoCacheEvictions([...this.entries.values()], { playhead: this.playhead, maxBytes: this.maxBytes, direction: this.direction, behind: this.options.behind, protect: this.protect });
		for (const key of drop) this.drop(this.entries.get(key)!);
	}

	private drop(e: Entry) {
		this.entries.delete(e.key);
		this.bytes -= e.bytes;
		e.frame.image.close?.();
	}

	private emit() {
		for (const l of [...this.listeners]) l();
	}
}

/**
 * A browser decoder for prefetch: one hidden, muted `<video>` per file, seeking to each requested
 * time in turn and copying the picture with `createImageBitmap` once it is presented
 * (`requestVideoFrameCallback` where the browser has it, else `seeked`). Media from another origin
 * needs CORS, as for scopes.
 */
export function createVideoElementDecoder(options: { createVideo?: () => HTMLVideoElement; timeout?: number } = {}): VideoFrameDecoder {
	const videos = new Map<string, { el: HTMLVideoElement; chain: Promise<unknown> }>();
	const make =
		options.createVideo ??
		(() => {
			const el = document.createElement('video');
			el.muted = true;
			el.preload = 'auto';
			el.crossOrigin = 'anonymous';
			el.playsInline = true;
			return el;
		});
	const timeout = options.timeout ?? 5000;
	const once = (el: HTMLVideoElement, type: string) =>
		new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`The video did not ${type} within ${timeout} ms.`)), timeout);
			el.addEventListener(type, () => (clearTimeout(timer), resolve()), { once: true });
			el.addEventListener('error', () => (clearTimeout(timer), reject(new Error('The video could not be loaded.'))), { once: true });
		});
	return (src, sourceTime) => {
		let v = videos.get(src);
		if (!v) {
			const el = make();
			el.src = src;
			v = { el, chain: el.readyState >= 1 ? Promise.resolve() : once(el, 'loadedmetadata') };
			videos.set(src, v);
		}
		const { el } = v;
		const next = v.chain.then(async () => {
			const presented = 'requestVideoFrameCallback' in el ? new Promise<void>((r) => (el as any).requestVideoFrameCallback(() => r())) : null;
			const seeked = once(el, 'seeked');
			el.currentTime = sourceTime / 1000;
			await seeked;
			if (presented) await Promise.race([presented, new Promise((r) => setTimeout(r, 100))]);
			const image = await createImageBitmap(el);
			return { image, width: image.width, height: image.height };
		});
		v.chain = next.catch(() => {});
		return next;
	};
}
