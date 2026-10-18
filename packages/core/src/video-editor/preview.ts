import { videoFrameAt, type VideoFrame, type VideoLayer } from './evaluate.js';
import { drawVideoFrame, type VideoCanvasContext } from './render.js';
import type { VideoProject } from './types.js';

/** What a preview follows: a `VideoEditorController` fits. */
export interface VideoPreviewSource {
	getState(): { project: VideoProject; time: number; playing: boolean };
	subscribe(listener: () => void): () => void;
}

/** The parts of a media element the preview drives (so tests can pass fakes). */
export interface VideoPreviewMedia {
	src: string;
	currentTime: number;
	playbackRate: number;
	volume: number;
	muted: boolean;
	paused: boolean;
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
	/** How far (ms) a playing element may drift from the timeline before it is re-seeked (default 200). */
	tolerance?: number;
	/** Makes media and image elements (default `document.createElement`). */
	createMedia?: (kind: 'video' | 'audio') => VideoPreviewMedia;
	createImage?: () => VideoPreviewImage;
	/** The 2D context to draw on (default `canvas.getContext('2d')`). */
	context?: VideoCanvasContext | null;
	/** Called after each frame is drawn. */
	onFrame?: (frame: VideoFrame) => void;
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

	constructor(
		private readonly source: VideoPreviewSource,
		canvas: { width: number; height: number; clientWidth?: number; getContext?: (id: '2d') => unknown },
		private readonly options: VideoPreviewOptions = {}
	) {
		this.canvas = canvas;
		this.ctx = options.context !== undefined ? options.context : ((canvas.getContext?.('2d') as VideoCanvasContext | null) ?? null);
		this.unsubscribe = source.subscribe(() => this.update());
		this.update();
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
		const { project, time, playing } = this.source.getState();
		const frame = videoFrameAt(project, time);
		const tolerance = (this.options.tolerance ?? 200) / 1000;
		const active = new Set<string>();
		const sync = (clip: string, src: string, kind: 'video' | 'audio', sourceTime: number, speed: number, gain: number | null) => {
			const { media } = this.entry(clip, src, kind);
			active.add(clip);
			const target = sourceTime / 1000;
			if (Math.abs(media.playbackRate - speed) > 1e-6) media.playbackRate = speed;
			if (gain === null) media.muted = true;
			else {
				media.muted = gain <= 0;
				media.volume = Math.min(1, Math.max(0, gain));
			}
			if (playing) {
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
			sync(layer.clip, layer.src, 'video', layer.sourceTime ?? 0, sound?.speed ?? 1, sound ? sound.gain : null);
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
		return entry && entry.media.readyState >= 2 ? (entry.media as unknown as CanvasImageSource) : null;
	};

	private draw(frame: VideoFrame) {
		if (!this.ctx) return;
		const shown = this.canvas.clientWidth || frame.width;
		const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
		const resolution = this.options.resolution ?? Math.min(1, (shown * dpr) / frame.width);
		const w = Math.max(1, Math.round(frame.width * resolution));
		const h = Math.max(1, Math.round(frame.height * resolution));
		if (this.canvas.width !== w) this.canvas.width = w;
		if (this.canvas.height !== h) this.canvas.height = h;
		drawVideoFrame(this.ctx, frame, this.sourceFor, resolution);
		this.options.onFrame?.(frame);
	}

	/** Stops following the editor and releases every media element. */
	destroy(): void {
		this.destroyed = true;
		this.unsubscribe();
		for (const entry of [...this.media.values()]) this.release(entry);
		this.images.clear();
	}
}
