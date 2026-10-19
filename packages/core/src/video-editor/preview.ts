import { videoFrameAt, type VideoFrame, type VideoLayer } from './evaluate.js';
import { drawVideoFrame, type VideoCanvasContext, type VideoScratchCanvas } from './render.js';
import type { VideoLut, VideoLutCache } from './lut.js';
import type { VideoPreviewPixels, VideoPreviewSnapshot } from './scopes.js';
import { resolveVideoPreviewScale, videoPreviewSrc, type VideoPreviewScale } from './proxy.js';
import type { VideoProject } from './types.js';

/** What a preview follows: a `VideoEditorController` fits. */
export interface VideoPreviewSource {
	getState(): { project: VideoProject; time: number; playing: boolean; previewScale?: VideoPreviewScale };
	subscribe(listener: () => void): () => void;
	/** Where to publish the drawn pixels (a controller has one), for scopes and agents. */
	previewPixels?: VideoPreviewPixels;
	/** Where grades' LUTs load from (a controller has one). */
	luts?: VideoLutCache;
}

/** The parts of a media element the preview drives (so tests can pass fakes). */
export interface VideoPreviewMedia {
	src: string;
	currentTime: number;
	playbackRate: number;
	volume: number;
	muted: boolean;
	paused: boolean;
	/** True while a seek is under way (the element still shows the old frame). */
	seeking?: boolean;
	readyState: number;
	preload: string;
	play(): Promise<void> | void;
	pause(): void;
	addEventListener(type: string, listener: () => void): void;
	removeEventListener(type: string, listener: () => void): void;
	removeAttribute?(name: string): void;
	load?(): void;
}

export interface VideoPreviewImage {
	src: string;
	complete: boolean;
	addEventListener(type: string, listener: () => void): void;
}

export interface VideoPreviewOptions {
	/** Canvas pixels per frame pixel (default: fits the canvas's displayed width at the device pixel ratio, at most 1). */
	resolution?: number;
	/** How large a picture to play, overriding the source's `previewScale` (see `VideoPreviewScale`). */
	previewScale?: VideoPreviewScale;
	/** How far (ms) a playing element may drift from the timeline before it is re-seeked (default 200). */
	tolerance?: number;
	/** Makes media and image elements (default `document.createElement`). */
	createMedia?: (kind: 'video' | 'audio') => VideoPreviewMedia;
	createImage?: () => VideoPreviewImage;
	/** The 2D context to draw on (default `canvas.getContext('2d')`). */
	context?: VideoCanvasContext | null;
	/** Called after each frame is drawn. */
	onFrame?: (frame: VideoFrame) => void;
	/**
	 * Puts an SVG filter (white balance in a grade) where the canvas's `filter: url(#id)` can find
	 * it. Default: a hidden `<svg>` added to `document.body`. `null` leaves white balance out.
	 */
	defineSvgFilter?: ((id: string, markup: string) => void) | null;
	/**
	 * Where to publish the canvas's pixels after each frame, for scopes and the `get_video_scopes`
	 * tool (default: the source's `previewPixels`). `null` publishes nothing.
	 */
	pixels?: VideoPreviewPixels | null;
	/** Where grades' LUTs load from (default: the source's `luts`). Without one, LUTs are left out. */
	luts?: VideoLutCache | null;
	/**
	 * Makes the offscreen canvas LUT-graded layers are drawn on (default: a `<canvas>` with
	 * `willReadFrequently`). LUTs run on the CPU, so a lower `resolution` keeps playback smooth.
	 */
	createScratch?: (width: number, height: number) => VideoScratchCanvas | null;
}

interface Entry {
	clip: string;
	src: string;
	media: VideoPreviewMedia;
	onReady: () => void;
}

/**
 * Plays a project in the browser: keeps one `<video>` or `<audio>` element per playing clip in step
 * with the timeline (seeking when it drifts, matching speed and gain, pausing with the editor), and
 * draws each frame (`videoFrameAt` + `drawVideoFrame`) on a canvas. Framework-free: React and Svelte
 * wrap it in `<VideoPreview>`. Elements for clips that stop playing are paused and released.
 */
export class VideoPreviewEngine {
	private readonly canvas: { width: number; height: number; clientWidth?: number; getContext?: (id: '2d') => unknown };
	private readonly ctx: VideoCanvasContext | null;
	private readonly media = new Map<string, Entry>();
	private readonly images = new Map<string, VideoPreviewImage>();
	private readonly unsubscribe: () => void;
	private scheduled = false;
	private destroyed = false;
	private filterHost: Element | null = null;
	private readonly filters = new Set<string>();
	private readonly detachPixels: () => void;
	private readonly pixelsTarget: VideoPreviewPixels | null;
	private drawn: { time: number; complete: boolean } | null = null;
	private complete = true;
	private readonly lutCache: VideoLutCache | null;
	private readonly unsubscribeLuts: () => void;
	private scratchCanvas: VideoScratchCanvas | null | undefined;

	constructor(
		private readonly source: VideoPreviewSource,
		canvas: { width: number; height: number; clientWidth?: number; getContext?: (id: '2d') => unknown },
		private readonly options: VideoPreviewOptions = {}
	) {
		this.canvas = canvas;
		this.ctx = options.context !== undefined ? options.context : ((canvas.getContext?.('2d') as VideoCanvasContext | null) ?? null);
		this.unsubscribe = source.subscribe(() => this.update());
		this.lutCache = options.luts !== undefined ? options.luts : (source.luts ?? null);
		this.unsubscribeLuts = this.lutCache ? this.lutCache.subscribe(() => this.redraw()) : () => {};
		const pixels = options.pixels !== undefined ? options.pixels : source.previewPixels;
		this.detachPixels = pixels ? pixels.attach(() => this.readPixels()) : () => {};
		this.pixelsTarget = pixels ?? null;
		this.update();
	}

	/** The canvas's pixels and the frame they show, or `null` when its context cannot be read. */
	readPixels(): VideoPreviewSnapshot | null {
		const ctx = this.ctx as (VideoCanvasContext & { getImageData?: (x: number, y: number, w: number, h: number) => ImageData }) | null;
		if (!ctx?.getImageData || !this.drawn) return null;
		return { ...this.drawn, pixels: ctx.getImageData(0, 0, this.canvas.width, this.canvas.height) };
	}

	private createMedia(kind: 'video' | 'audio'): VideoPreviewMedia {
		if (this.options.createMedia) return this.options.createMedia(kind);
		const el = document.createElement(kind);
		el.preload = 'auto';
		el.crossOrigin = 'anonymous';
		if (kind === 'video') (el as HTMLVideoElement).playsInline = true;
		return el as unknown as VideoPreviewMedia;
	}

	private image(src: string): VideoPreviewImage {
		let img = this.images.get(src);
		if (!img) {
			img = this.options.createImage ? this.options.createImage() : (new Image() as unknown as VideoPreviewImage);
			img.addEventListener('load', () => this.redraw());
			img.src = src;
			this.images.set(src, img);
		}
		return img;
	}

	private entry(clip: string, src: string, kind: 'video' | 'audio'): Entry {
		const existing = this.media.get(clip);
		if (existing && existing.src === src) return existing;
		if (existing) this.release(existing);
		const media = this.createMedia(kind);
		const onReady = () => this.redraw();
		media.addEventListener('seeked', onReady);
		media.addEventListener('loadeddata', onReady);
		media.src = src;
		const entry = { clip, src, media, onReady };
		this.media.set(clip, entry);
		return entry;
	}

	private release(entry: Entry) {
		entry.media.pause();
		entry.media.removeEventListener('seeked', entry.onReady);
		entry.media.removeEventListener('loadeddata', entry.onReady);
		entry.media.removeAttribute?.('src');
		entry.media.load?.();
		this.media.delete(entry.clip);
	}

	/** Brings the media elements in step with the editor and draws the frame. */
	update(): void {
		if (this.destroyed) return;
		const state = this.source.getState();
		const { project, time, playing } = state;
		const frame = videoFrameAt(project, time);
		// Video plays from the proxy the preview scale picks; sound-only clips use the original.
		const scale = resolveVideoPreviewScale(this.options.previewScale ?? state.previewScale, this.resolutionFor(project.width));
		const assets = new Map(project.assets.map((a) => [a.id, a]));
		const tolerance = (this.options.tolerance ?? 200) / 1000;
		const active = new Set<string>();
		const sync = (clip: string, src: string, kind: 'video' | 'audio', sourceTime: number, speed: number, gain: number | null) => {
			const { media } = this.entry(clip, src, kind);
			active.add(clip);
			const target = sourceTime / 1000;
			// Browsers refuse rates below about 1/16; slower than that (a freeze) is shown by seeking a paused element.
			const frozen = speed < 0.0625;
			if (!frozen && Math.abs(media.playbackRate - speed) > 1e-6) media.playbackRate = speed;
			if (gain === null) media.muted = true;
			else {
				media.muted = gain <= 0;
				media.volume = Math.min(1, Math.max(0, gain));
			}
			if (playing && !frozen) {
				if (media.paused || Math.abs(media.currentTime - target) > tolerance) media.currentTime = target;
				if (media.paused) void Promise.resolve(media.play()).catch(() => {});
			} else {
				if (!media.paused) media.pause();
				if (Math.abs(media.currentTime - target) > 1 / (2 * project.fps)) media.currentTime = target;
			}
		};
		const sounding = new Map(frame.audio.map((a) => [a.clip, a]));
		for (const layer of frame.layers) {
			if (layer.type !== 'media' || layer.assetKind !== 'video' || !layer.src) continue;
			const sound = sounding.get(layer.clip);
			sync(layer.clip, videoPreviewSrc(assets.get(layer.asset ?? ''), scale, layer.src), 'video', layer.sourceTime ?? 0, sound?.speed ?? 1, sound ? sound.gain : null);
			sounding.delete(layer.clip);
		}
		// Sound with no picture (audio tracks, hidden video tracks): an audio element is enough.
		for (const a of sounding.values()) sync(a.clip, a.src, 'audio', a.sourceTime, a.speed, a.gain);
		for (const entry of [...this.media.values()]) if (!active.has(entry.clip)) this.release(entry);
		this.draw(frame);
	}

	private redraw() {
		if (this.scheduled || this.destroyed) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			if (!this.destroyed) this.draw(videoFrameAt(this.source.getState().project, this.source.getState().time));
		});
	}

	private sourceFor = (layer: VideoLayer): CanvasImageSource | null => {
		if (layer.assetKind === 'image' && layer.src) {
			const img = this.image(layer.src);
			return img.complete ? (img as unknown as CanvasImageSource) : null;
		}
		const entry = this.media.get(layer.clip);
		if (!entry || entry.media.readyState < 2) return null;
		if (entry.media.seeking) this.complete = false;
		return entry.media as unknown as CanvasImageSource;
	};

	/** Canvas pixels per frame pixel: the option, else the displayed width at the device pixel ratio (at most 1). */
	private resolutionFor(frameWidth: number): number {
		if (this.options.resolution !== undefined) return this.options.resolution;
		const shown = this.canvas.clientWidth || frameWidth;
		const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
		return Math.min(1, (shown * dpr) / frameWidth);
	}

	private draw(frame: VideoFrame) {
		if (!this.ctx) return;
		const resolution = this.resolutionFor(frame.width);
		const w = Math.max(1, Math.round(frame.width * resolution));
		const h = Math.max(1, Math.round(frame.height * resolution));
		if (this.canvas.width !== w) this.canvas.width = w;
		if (this.canvas.height !== h) this.canvas.height = h;
		this.complete = true;
		const sourceFor = (layer: VideoLayer) => {
			const source = this.sourceFor(layer);
			if (!source) this.complete = false;
			return source;
		};
		drawVideoFrame(this.ctx, frame, sourceFor, resolution, { defineSvgFilter: this.defineSvgFilter, lutFor: this.lutFor, scratch: this.scratch });
		this.drawn = { time: frame.time, complete: this.complete };
		this.options.onFrame?.(frame);
		this.pixelsTarget?.drawn(frame.time, this.complete);
	}

	/** A grade's LUT once loaded; while it loads (or if it fails) the frame is drawn without it and counts as incomplete. */
	private readonly lutFor = (src: string): VideoLut | undefined => {
		const lut = this.lutCache?.get(src);
		if (!lut) this.complete = false;
		return lut;
	};

	private readonly scratch = (width: number, height: number): VideoScratchCanvas | null => {
		if (this.scratchCanvas === undefined) {
			if (this.options.createScratch) this.scratchCanvas = this.options.createScratch(width, height);
			else if (typeof document !== 'undefined') {
				const canvas = document.createElement('canvas');
				const ctx = canvas.getContext('2d', { willReadFrequently: true });
				this.scratchCanvas = ctx ? { canvas, ctx: ctx as unknown as VideoScratchCanvas['ctx'] } : null;
			} else this.scratchCanvas = null;
		}
		const s = this.scratchCanvas;
		if (!s) return null;
		const c = s.canvas as { width?: number; height?: number };
		if (c.width !== width) c.width = width;
		if (c.height !== height) c.height = height;
		return s;
	};

	private readonly defineSvgFilter = (id: string, markup: string) => {
		if (this.options.defineSvgFilter === null) return;
		if (this.options.defineSvgFilter) return this.options.defineSvgFilter(id, markup);
		if (this.filters.has(id) || typeof document === 'undefined') return;
		if (!this.filterHost) {
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('width', '0');
			svg.setAttribute('height', '0');
			svg.setAttribute('aria-hidden', 'true');
			svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
			document.body.appendChild(svg);
			this.filterHost = svg;
		}
		this.filterHost.insertAdjacentHTML('beforeend', markup);
		this.filters.add(id);
	};

	/** Stops following the editor and releases every media element. */
	destroy(): void {
		this.destroyed = true;
		this.detachPixels();
		this.unsubscribeLuts();
		this.filterHost?.remove();
		this.filterHost = null;
		this.filters.clear();
		this.unsubscribe();
		for (const entry of [...this.media.values()]) this.release(entry);
		this.images.clear();
	}
}
