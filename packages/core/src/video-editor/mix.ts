import { videoAudioPeakSpans, type VideoAudioPeaks } from './audio.js';
import type { VideoKey } from './keyframes.js';
import { mergeVideoRanges, type VideoTimelineWord } from './transcript.js';
import { videoClipEnd } from './timeline.js';
import type { VideoClip } from './types.js';

/**
 * The sound mix as data: loudness measured the way streaming services and broadcasters measure it
 * (ITU-R BS.1770, gated, in LUFS), the gain that brings a clip to a target, ducking keyframes that
 * dip music under speech, and the beats of a music track. Pure functions over samples, peaks and
 * ranges, so an agent and the inspector get the same numbers, and tests need no decoder.
 */

// ---------------------------------------------------------------------------------------------
// Loudness (ITU-R BS.1770)
// ---------------------------------------------------------------------------------------------

/** Length of one loudness hop (ms): a gating block is four hops (400 ms) moving one hop at a time. */
export const VIDEO_LOUDNESS_HOP = 100;

/** The two K-weighting biquads (a high shelf, then a high pass) for a sample rate, as libebur128 derives them. */
function kWeighting(sampleRate: number): { b: [number, number, number]; a: [number, number] }[] {
	let K = Math.tan((Math.PI * 1681.974450955533) / sampleRate);
	const Vh = 10 ** (3.999843853973347 / 20);
	const Vb = Vh ** 0.4996667741545416;
	let Q = 0.7071752369554196;
	let a0 = 1 + K / Q + K * K;
	const shelf = { b: [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0] as [number, number, number], a: [(2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0] as [number, number] };
	K = Math.tan((Math.PI * 38.13547087602444) / sampleRate);
	Q = 0.5003270373238773;
	a0 = 1 + K / Q + K * K;
	const highPass = { b: [1, -2, 1] as [number, number, number], a: [(2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0] as [number, number] };
	return [shelf, highPass];
}

/**
 * The K-weighted mean square of decoded audio per 100 ms hop, channels summed (each weighted 1, as
 * for left, right and centre). What `VideoAudioPeaks.loudness` holds.
 */
export function videoLoudnessEnergy(channels: readonly Float32Array[], sampleRate: number): { hop: number; energy: Float32Array } {
	const length = channels.reduce((n, c) => Math.max(n, c.length), 0);
	const hopSamples = Math.max(1, Math.round((sampleRate * VIDEO_LOUDNESS_HOP) / 1000));
	const hops = Math.max(1, Math.ceil(length / hopSamples));
	const energy = new Float32Array(hops);
	const filters = kWeighting(sampleRate);
	for (const channel of channels) {
		// Direct form I state per biquad.
		const x1 = [0, 0];
		const x2 = [0, 0];
		const y1 = [0, 0];
		const y2 = [0, 0];
		for (let i = 0; i < channel.length; i++) {
			let v = Number.isFinite(channel[i]) ? channel[i] : 0;
			for (let f = 0; f < 2; f++) {
				const { b, a } = filters[f];
				const y = b[0] * v + b[1] * x1[f] + b[2] * x2[f] - a[0] * y1[f] - a[1] * y2[f];
				x2[f] = x1[f];
				x1[f] = v;
				y2[f] = y1[f];
				y1[f] = y;
				v = y;
			}
			energy[Math.floor(i / hopSamples)] += v * v;
		}
	}
	for (let h = 0; h < hops; h++) energy[h] /= Math.min(hopSamples, length - h * hopSamples) || 1;
	return { hop: VIDEO_LOUDNESS_HOP, energy };
}

const lufs = (meanSquare: number) => -0.691 + 10 * Math.log10(meanSquare);

/**
 * Integrated loudness (LUFS) of hop energies between two source times (ms): 400 ms blocks every
 * 100 ms, gated at -70 LUFS and then 10 LU below the ungated level, as BS.1770-4 does. A stretch
 * shorter than a block is measured as one block. `null` when everything is gated out (silence).
 */
export function videoLoudnessOf(loudness: { hop: number; energy: Float32Array }, from = 0, to = Infinity): number | null {
	const { hop, energy } = loudness;
	const a = Math.max(0, Math.floor(from / hop));
	const b = Math.min(energy.length, Math.ceil(to / hop));
	if (b <= a) return null;
	const blocks: number[] = [];
	if (b - a < 4) {
		let sum = 0;
		for (let h = a; h < b; h++) sum += energy[h];
		blocks.push(sum / (b - a));
	} else
		for (let h = a; h + 4 <= b; h++) blocks.push((energy[h] + energy[h + 1] + energy[h + 2] + energy[h + 3]) / 4);
	const absolute = blocks.filter((z) => z > 0 && lufs(z) > -70);
	if (!absolute.length) return null;
	const threshold = lufs(absolute.reduce((s, z) => s + z, 0) / absolute.length) - 10;
	const gated = absolute.filter((z) => lufs(z) > threshold);
	if (!gated.length) return null;
	return Math.round(lufs(gated.reduce((s, z) => s + z, 0) / gated.length) * 10) / 10;
}

/** Integrated loudness (LUFS) of decoded audio. `null` for silence. */
export function measureVideoLoudness(channels: readonly Float32Array[], sampleRate: number): number | null {
	return videoLoudnessOf(videoLoudnessEnergy(channels, sampleRate));
}

/** Integrated loudness (LUFS) of a stretch of an asset's sound from its peaks, `null` for silence; throws for peaks without loudness. */
export function videoAudioLoudness(peaks: VideoAudioPeaks, from = 0, to = Infinity): number | null {
	if (!peaks.loudness) throw new Error('These peaks have no loudness data; build them again with buildVideoAudioPeaks (or decodeVideoAudioPeaks), which measures it.');
	return videoLoudnessOf(peaks.loudness, from, to);
}

export interface VideoLoudnessGainOptions {
	/** Most gain allowed (linear, default 4, the highest clip volume). */
	maxGain?: number;
	/** The sound's sample peak (dBFS); with it the gain is held so the peak stays under `ceiling`. */
	peakDb?: number;
	/** Highest peak allowed after the gain (dBFS, default -1). */
	ceiling?: number;
}

/**
 * The linear gain that brings a sound measured at `measured` LUFS to `target` LUFS (default -14,
 * what streaming services play at), capped by `maxGain` and by the peak ceiling when `peakDb` is
 * known. `limitedBy` says when a cap kept it short of the target.
 */
export function videoLoudnessGain(measured: number, target = -14, options: VideoLoudnessGainOptions = {}): { gain: number; gainDb: number; limitedBy?: 'max-gain' | 'peak' } {
	let db = target - measured;
	let limitedBy: 'max-gain' | 'peak' | undefined;
	const maxDb = 20 * Math.log10(options.maxGain ?? 4);
	if (db > maxDb) {
		db = maxDb;
		limitedBy = 'max-gain';
	}
	if (options.peakDb !== undefined && options.peakDb > -100) {
		const room = (options.ceiling ?? -1) - options.peakDb;
		if (db > room) {
			db = room;
			limitedBy = 'peak';
		}
	}
	return { gain: Math.round(10 ** (db / 20) * 1000) / 1000, gainDb: Math.round(db * 10) / 10, ...(limitedBy ? { limitedBy } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Ducking
// ---------------------------------------------------------------------------------------------

/** Timeline stretches where words are spoken, merged across gaps shorter than `mergeGap` ms (default 500). */
export function videoSpeechRanges(words: readonly Pick<VideoTimelineWord, 'start' | 'end'>[], mergeGap = 500): { from: number; to: number }[] {
	const merged: { from: number; to: number }[] = [];
	for (const r of mergeVideoRanges(words.map((w) => ({ from: w.start, to: w.end })))) {
		const last = merged[merged.length - 1];
		if (last && r.from - last.to < mergeGap) last.to = Math.max(last.to, r.to);
		else merged.push({ ...r });
	}
	return merged;
}

export interface VideoDuckingOptions {
	/** How far to dip under speech, in dB (default -14; -12 to -18 is usual). */
	duckDb?: number;
	/** How long the dip takes to come in before speech starts (ms, default 200). */
	attack?: number;
	/** How long the music takes to come back after speech ends (ms, default 400). */
	release?: number;
	/** Speech gaps shorter than this stay ducked (ms, default 600, never less than attack + release). */
	mergeGap?: number;
	/** The level the music sits at between dips (linear gain, default the clip's own volume or 1). */
	base?: number;
}

/**
 * Volume keyframes (clip time) that dip a music clip under speech: for each stretch of speech that
 * overlaps it, the level eases down over `attack` ms before the speech, holds at `duckDb` and eases
 * back over `release` ms after it. Stretches closer than the merge gap stay ducked between them.
 * `[]` when no speech overlaps the clip. Keys are on whole ms and in time order.
 */
export function videoDuckingKeys(clip: Pick<VideoClip, 'start' | 'duration'>, speech: readonly { from: number; to: number }[], options: VideoDuckingOptions = {}): VideoKey[] {
	const duckDb = options.duckDb ?? -14;
	const attack = Math.max(0, options.attack ?? 200);
	const release = Math.max(0, options.release ?? 400);
	const gap = Math.max(options.mergeGap ?? 600, attack + release);
	const base = options.base ?? 1;
	const low = Math.round(base * 10 ** (duckDb / 20) * 10000) / 10000;
	const end = videoClipEnd(clip as VideoClip);
	const ranges: { from: number; to: number }[] = [];
	for (const r of mergeVideoRanges(speech)) {
		if (r.to <= clip.start - release || r.from >= end + attack) continue;
		const last = ranges[ranges.length - 1];
		if (last && r.from - last.to < gap) last.to = Math.max(last.to, r.to);
		else ranges.push({ ...r });
	}
	if (!ranges.length) return [];
	const keys: VideoKey[] = [];
	const at = (t: number) => Math.round(Math.min(clip.duration, Math.max(0, t - clip.start)));
	const push = (t: number, v: number, ease?: VideoKey['ease']) => {
		const last = keys[keys.length - 1];
		if (last && t <= last.t) {
			// Two keys on one ms: the later one wins.
			last.v = v;
			if (ease) last.ease = ease;
			else delete last.ease;
			return;
		}
		keys.push({ t, v, ...(ease ? { ease } : {}) });
	};
	for (const r of ranges) {
		const down = at(r.from - attack);
		const held = at(r.from);
		if (held > down) push(down, base, 'ease-in-out');
		push(held, low);
		const hold = at(r.to);
		const up = at(r.to + release);
		if (up > hold) {
			push(hold, low, 'ease-in-out');
			push(up, base);
		}
	}
	return keys;
}

// ---------------------------------------------------------------------------------------------
// Beats
// ---------------------------------------------------------------------------------------------

export interface VideoBeatOptions {
	/** Resolution of the onset scan (ms, default 10). */
	resolution?: number;
	/** Closest two onsets may be (ms, default 250). */
	minInterval?: number;
	/** How far above the local average an onset must rise, in standard deviations (default 1.5). */
	sensitivity?: number;
	/** Slowest and fastest tempo to consider (BPM, default 60 and 200). */
	minBpm?: number;
	maxBpm?: number;
}

export interface VideoBeats {
	/** Times of sharp rises in level (ms, in the clock asked in): hits, plucks, kicks. */
	onsets: number[];
	/** The tempo the onsets repeat at, or `null` when they do not repeat. */
	bpm: number | null;
	/** A steady beat grid at `bpm`, through the strongest onsets (ms); empty without a tempo. */
	beats: number[];
}

/**
 * The beats of a stretch of sound (source ms) from its peaks: an onset envelope (rises of the peak
 * level), onsets where it rises well above its local average, the tempo from the envelope's
 * autocorrelation and a beat grid at that tempo, phased to fit the onsets best. Works on peaks, so
 * it is quick and needs no decoding beyond what waveforms already have; it finds the pulse of
 * percussive music well and of ambient music poorly.
 */
export function findVideoAudioBeats(peaks: VideoAudioPeaks, from: number, to: number, options: VideoBeatOptions = {}): VideoBeats {
	const res = Math.max(1, options.resolution ?? 10);
	const n = Math.max(2, Math.ceil((to - from) / res));
	const spans = videoAudioPeakSpans(peaks, from, to, n);
	const env = new Float32Array(n);
	for (let i = 0; i < n; i++) env[i] = Math.max(Math.abs(spans[2 * i]), Math.abs(spans[2 * i + 1]));
	const onset = new Float32Array(n);
	for (let i = 1; i < n; i++) onset[i] = Math.max(0, env[i] - env[i - 1]);
	// Onsets: local maxima well above the average of the second around them.
	const win = Math.max(1, Math.round(500 / res));
	const k = options.sensitivity ?? 1.5;
	const minGap = Math.max(1, Math.round((options.minInterval ?? 250) / res));
	const onsets: number[] = [];
	const strength: number[] = [];
	let lastAt = -Infinity;
	for (let i = 1; i < n - 1; i++) {
		if (!(onset[i] > 0 && onset[i] >= onset[i - 1] && onset[i] >= onset[i + 1])) continue;
		let sum = 0;
		let sq = 0;
		let count = 0;
		for (let j = Math.max(0, i - win); j < Math.min(n, i + win + 1); j++) {
			sum += onset[j];
			sq += onset[j] * onset[j];
			count++;
		}
		const mean = sum / count;
		const sd = Math.sqrt(Math.max(0, sq / count - mean * mean));
		if (onset[i] < mean + k * sd || onset[i] < 0.02) continue;
		if (i - lastAt < minGap) {
			// Keep the stronger of two onsets too close together.
			if (onset[i] > strength[strength.length - 1]) {
				onsets[onsets.length - 1] = from + i * res;
				strength[strength.length - 1] = onset[i];
				lastAt = i;
			}
			continue;
		}
		onsets.push(from + i * res);
		strength.push(onset[i]);
		lastAt = i;
	}
	// Tempo: the lag (within the BPM range) where the onset envelope best matches itself.
	const minLag = Math.max(1, Math.round(60000 / (options.maxBpm ?? 200) / res));
	const maxLag = Math.min(n - 1, Math.round(60000 / (options.minBpm ?? 60) / res));
	let bestLag = 0;
	let best = 0;
	let total = 0;
	for (let i = 0; i < n; i++) total += onset[i] * onset[i];
	for (let lag = minLag; lag <= maxLag; lag++) {
		let s = 0;
		for (let i = 0; i + lag < n; i++) s += onset[i] * onset[i + lag];
		s /= n - lag;
		if (s > best * 1.0001) {
			best = s;
			bestLag = lag;
		}
	}
	const repeats = onsets.length >= 3 && bestLag > 0 && best * n > 0.2 * total;
	if (!repeats) return { onsets, bpm: null, beats: [] };
	const period = bestLag * res;
	const bpm = Math.round((60000 / period) * 10) / 10;
	// Phase the grid on the onset that most other onsets agree with.
	let phase = onsets[0];
	let agree = -1;
	for (const o of onsets) {
		let a = 0;
		for (const p of onsets) {
			const d = Math.abs((((p - o) % period) + period) % period);
			if (Math.min(d, period - d) <= res * 2) a++;
		}
		if (a > agree) {
			agree = a;
			phase = o;
		}
	}
	const beats: number[] = [];
	for (let t = phase - Math.floor((phase - from) / period) * period; t <= to + 1e-6; t += period) if (t >= from - 1e-6) beats.push(Math.round(t * 10) / 10);
	return { onsets, bpm, beats };
}

/** The nearest time in a sorted list to `time`, or `null` when none is within `tolerance` ms. */
export function nearestVideoBeat(beats: readonly number[], time: number, tolerance = Infinity): number | null {
	let best: number | null = null;
	for (const b of beats) if (Math.abs(b - time) <= tolerance && (best === null || Math.abs(b - time) < Math.abs(best - time))) best = b;
	return best;
}
