import { videoClipSoundGain } from './evaluate.js';
import type { VideoAsset, VideoMediaClip } from './types.js';

/**
 * Sound levels of a piece of audio, small enough to keep for every asset: a pyramid of min / max
 * sample values. Level 0 holds one min / max pair per `blockSize` samples; each level above merges
 * four blocks of the one below, so the min / max of any stretch costs a handful of reads at any
 * zoom. Channels are folded together (the loudest of them counts). Plain data: hosts can compute
 * it once (`buildVideoAudioPeaks`) and store it.
 */
export interface VideoAudioPeaks {
	/** Samples per second of the decoded audio. */
	sampleRate: number;
	/** Samples in the audio (per channel). */
	length: number;
	/** Samples per level-0 block. */
	blockSize: number;
	/** `levels[k]` is `[min, max, min, max, …]`, one pair per block of `blockSize × 4^k` samples. */
	levels: Float32Array[];
}

/** Samples per level-0 block (well under a millisecond at common rates). */
export const VIDEO_PEAK_BLOCK = 32;

/** Builds the peak pyramid for decoded audio (one `Float32Array` of samples per channel). */
export function buildVideoAudioPeaks(channels: readonly Float32Array[], sampleRate: number, blockSize = VIDEO_PEAK_BLOCK): VideoAudioPeaks {
	if (!(sampleRate > 0)) throw new Error('The sample rate must be above 0.');
	const length = channels.reduce((n, c) => Math.max(n, c.length), 0);
	const blocks = Math.max(1, Math.ceil(length / blockSize));
	const level0 = new Float32Array(blocks * 2);
	for (let b = 0; b < blocks; b++) {
		let lo = Infinity;
		let hi = -Infinity;
		const end = Math.min(length, (b + 1) * blockSize);
		for (const channel of channels) {
			for (let i = b * blockSize; i < Math.min(end, channel.length); i++) {
				const v = channel[i];
				if (!Number.isFinite(v)) continue;
				if (v < lo) lo = v;
				if (v > hi) hi = v;
			}
		}
		level0[2 * b] = lo === Infinity ? 0 : lo;
		level0[2 * b + 1] = hi === -Infinity ? 0 : hi;
	}
	const levels = [level0];
	while (levels[levels.length - 1].length > 2) {
		const below = levels[levels.length - 1];
		const n = below.length / 2;
		const up = new Float32Array(Math.ceil(n / 4) * 2);
		for (let j = 0; j < up.length / 2; j++) {
			let lo = Infinity;
			let hi = -Infinity;
			for (let i = 4 * j; i < Math.min(n, 4 * j + 4); i++) {
				lo = Math.min(lo, below[2 * i]);
				hi = Math.max(hi, below[2 * i + 1]);
			}
			up[2 * j] = lo;
			up[2 * j + 1] = hi;
		}
		levels.push(up);
	}
	return { sampleRate, length, blockSize, levels };
}

/** Length of the audio (ms). */
export const videoAudioPeaksDuration = (peaks: VideoAudioPeaks): number => (peaks.length * 1000) / peaks.sampleRate;

/**
 * The lowest and highest sample between two times (ms) in the audio, to the nearest block (so a
 * stretch can read up to a block wider). `{ min: 0, max: 0 }` outside the audio.
 */
export function videoAudioPeakRange(peaks: VideoAudioPeaks, from: number, to: number): { min: number; max: number } {
	const blocks = peaks.levels[0].length / 2;
	let a = Math.max(0, Math.floor((from * peaks.sampleRate) / 1000 / peaks.blockSize));
	let b = Math.min(blocks, Math.ceil((to * peaks.sampleRate) / 1000 / peaks.blockSize));
	if (b <= a) {
		// Narrower than a block: the block it falls in.
		if (a >= blocks || to < 0) return { min: 0, max: 0 };
		b = a + 1;
	}
	let min = Infinity;
	let max = -Infinity;
	const take = (level: Float32Array, i: number) => {
		if (2 * i + 1 >= level.length) return;
		if (level[2 * i] < min) min = level[2 * i];
		if (level[2 * i + 1] > max) max = level[2 * i + 1];
	};
	// Whole blocks at the edges of each level, then up a level for the aligned middle.
	for (let k = 0; a < b; k++) {
		const level = peaks.levels[k];
		if (k === peaks.levels.length - 1) {
			for (let i = a; i < b; i++) take(level, i);
			break;
		}
		while (a < b && a % 4) take(level, a++);
		while (a < b && b % 4) take(level, --b);
		a /= 4;
		b /= 4;
	}
	return min === Infinity ? { min: 0, max: 0 } : { min, max };
}

/** `columns` min / max pairs (`[min, max, …]`) evenly across `from`..`to` ms, e.g. one per pixel. */
export function videoAudioPeakSpans(peaks: VideoAudioPeaks, from: number, to: number, columns: number): Float32Array {
	const n = Math.max(0, Math.floor(columns));
	const out = new Float32Array(n * 2);
	const step = (to - from) / Math.max(1, n);
	for (let c = 0; c < n; c++) {
		const { min, max } = videoAudioPeakRange(peaks, from + c * step, from + (c + 1) * step);
		out[2 * c] = min;
		out[2 * c + 1] = max;
	}
	return out;
}

/**
 * What a media clip plays as `columns` min / max pairs across its length: each column reads the
 * stretch of source under it (through the in point and speed) and is scaled by the clip's volume and
 * fades, so the waveform shows what is heard.
 */
export function videoClipWaveform(clip: VideoMediaClip, peaks: VideoAudioPeaks, columns: number): Float32Array {
	const n = Math.max(0, Math.floor(columns));
	const out = new Float32Array(n * 2);
	const speed = clip.speed ?? 1;
	const start = clip.in ?? 0;
	const step = clip.duration / Math.max(1, n);
	for (let c = 0; c < n; c++) {
		const { min, max } = videoAudioPeakRange(peaks, start + c * step * speed, start + (c + 1) * step * speed);
		const gain = videoClipSoundGain(clip, (c + 0.5) * step);
		out[2 * c] = min * gain;
		out[2 * c + 1] = max * gain;
	}
	return out;
}

/**
 * An SVG path (`d`) of a waveform filling `width` × `height`: the top edge along the maxima, back
 * along the minima. Values are clamped to ±1, so anything louder than full scale touches the edge.
 */
export function videoWaveformPath(spans: Float32Array, width: number, height: number): string {
	const n = spans.length / 2;
	if (!n || width <= 0 || height <= 0) return '';
	const mid = height / 2;
	const y = (v: number) => (mid - Math.max(-1, Math.min(1, v)) * mid).toFixed(1);
	const x = (i: number) => ((i + 0.5) * (width / n)).toFixed(1);
	// Keep at least a hairline where it is silent.
	const floor = 0.5 / mid;
	const top: string[] = [];
	const bottom: string[] = [];
	for (let i = 0; i < n; i++) top.push(`${i ? 'L' : 'M'}${x(i)} ${y(Math.max(spans[2 * i + 1], floor))}`);
	for (let i = n - 1; i >= 0; i--) bottom.push(`L${x(i)} ${y(Math.min(spans[2 * i], -floor))}`);
	return `${top.join('')}${bottom.join('')}Z`;
}

/**
 * The SVG path of a media clip's waveform drawn `width` × `height` pixels (one column per 2 px), as
 * `videoClipWaveform` reads it: what timelines draw inside an audio clip.
 */
export function videoClipWaveformPath(clip: VideoMediaClip, peaks: VideoAudioPeaks, width: number, height: number): string {
	const columns = Math.max(1, Math.min(2000, Math.ceil(width / 2)));
	return videoWaveformPath(videoClipWaveform(clip, peaks, columns), width, height);
}

/** A sample value as dBFS, floored at -100 (silence). */
export const videoPeakDb = (value: number): number => (Math.abs(value) > 1e-5 ? Math.max(-100, Math.round(200 * Math.log10(Math.abs(value))) / 10) : -100);

export interface VideoAudioLevel {
	/** Start of the bucket (ms, in the clock the caller asked in). */
	start: number;
	end: number;
	/** Peak level in dBFS (0 = full scale, -100 = silence). */
	peakDb: number;
}

/** Peak level in `buckets` equal stretches of `from`..`to` ms of the audio. */
export function videoAudioLevels(peaks: VideoAudioPeaks, from: number, to: number, buckets: number): VideoAudioLevel[] {
	const spans = videoAudioPeakSpans(peaks, from, to, buckets);
	const step = (to - from) / Math.max(1, buckets);
	return Array.from({ length: spans.length / 2 }, (_, i) => ({ start: from + i * step, end: from + (i + 1) * step, peakDb: videoPeakDb(Math.max(Math.abs(spans[2 * i]), Math.abs(spans[2 * i + 1]))) }));
}

export interface VideoSilenceOptions {
	/** Quieter than this peak level counts as silence (dBFS, default -40). */
	thresholdDb?: number;
	/** Shortest silence to report (ms, default 300). */
	minDuration?: number;
	/** Resolution of the scan (ms, default 10). */
	resolution?: number;
}

/** Stretches of `from`..`to` ms of the audio that stay below a level, at least `minDuration` long. */
export function findVideoAudioSilences(peaks: VideoAudioPeaks, from: number, to: number, options: VideoSilenceOptions = {}): { start: number; end: number }[] {
	const threshold = options.thresholdDb ?? -40;
	const minDuration = options.minDuration ?? 300;
	const resolution = Math.max(1, options.resolution ?? 10);
	const buckets = Math.max(1, Math.ceil((to - from) / resolution));
	const out: { start: number; end: number }[] = [];
	let run: number | null = null;
	const levels = videoAudioLevels(peaks, from, to, buckets);
	levels.forEach((l, i) => {
		const quiet = l.peakDb < threshold;
		if (quiet && run === null) run = l.start;
		if ((!quiet || i === levels.length - 1) && run !== null) {
			const end = quiet ? l.end : l.start;
			if (end - run >= minDuration) out.push({ start: run, end });
			run = null;
		}
	});
	return out;
}

/** Fetches and decodes a media file's sound into peaks, in a browser (Web Audio). */
export async function decodeVideoAudioPeaks(src: string, options: { signal?: AbortSignal } = {}): Promise<VideoAudioPeaks> {
	const Offline = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
	if (!Offline || typeof fetch === 'undefined') throw new Error('Audio can only be decoded in a browser with Web Audio.');
	const response = await fetch(src, options.signal ? { signal: options.signal } : {});
	if (!response.ok) throw new Error(`"${src}" could not be loaded (${response.status}).`);
	const data = await response.arrayBuffer();
	let buffer: AudioBuffer;
	try {
		buffer = await new Offline(1, 1, 44100).decodeAudioData(data);
	} catch {
		throw new Error(`"${src}" has no sound this browser can decode.`);
	}
	return buildVideoAudioPeaks(Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)), buffer.sampleRate);
}

/** Loads the peaks of an asset's sound. */
export type VideoAudioPeaksLoader = (asset: VideoAsset) => Promise<VideoAudioPeaks>;

/**
 * Peaks per asset, loaded once each (by `src`) and shared by the timeline and agent tools.
 * `get` returns what is ready and starts loading the rest; `subscribe` hears when more is ready.
 */
export class VideoAudioPeaksCache {
	private readonly ready = new Map<string, VideoAudioPeaks>();
	private readonly pending = new Map<string, Promise<VideoAudioPeaks>>();
	private readonly failed = new Map<string, string>();
	private readonly listeners = new Set<() => void>();

	constructor(private readonly loader: VideoAudioPeaksLoader = (asset) => decodeVideoAudioPeaks(asset.src)) {}

	/** The peaks if ready, without starting to load them. */
	peek(asset: VideoAsset): VideoAudioPeaks | undefined {
		return this.ready.get(asset.src);
	}

	/** The peaks if ready; otherwise `undefined`, and loading starts (once) unless it failed. */
	get(asset: VideoAsset): VideoAudioPeaks | undefined {
		const peaks = this.ready.get(asset.src);
		if (!peaks && !this.failed.has(asset.src)) void this.load(asset).catch(() => {});
		return peaks;
	}

	/** Why loading an asset's peaks failed, if it did. */
	error(asset: VideoAsset): string | undefined {
		return this.failed.get(asset.src);
	}

	/** The peaks, loading them if needed. Rejects with a readable error. */
	load(asset: VideoAsset): Promise<VideoAudioPeaks> {
		const ready = this.ready.get(asset.src);
		if (ready) return Promise.resolve(ready);
		const failed = this.failed.get(asset.src);
		if (failed) return Promise.reject(new Error(failed));
		let pending = this.pending.get(asset.src);
		if (!pending) {
			pending = this.loader(asset).then(
				(peaks) => {
					this.pending.delete(asset.src);
					this.ready.set(asset.src, peaks);
					this.emit();
					return peaks;
				},
				(e: unknown) => {
					this.pending.delete(asset.src);
					const message = `The sound of "${asset.id}" could not be read: ${e instanceof Error ? e.message : String(e)}`;
					this.failed.set(asset.src, message);
					this.emit();
					throw new Error(message);
				}
			);
			this.pending.set(asset.src, pending);
		}
		return pending;
	}

	/** Uses peaks the host already has (computed earlier or stored). */
	set(src: string, peaks: VideoAudioPeaks): void {
		this.ready.set(src, peaks);
		this.failed.delete(src);
		this.emit();
	}

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit() {
		for (const fn of this.listeners) fn();
	}
}
