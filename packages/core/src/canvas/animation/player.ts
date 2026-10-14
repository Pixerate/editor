import { realClock, type Clock } from '../clock.js';
import { wrapAnimationTime, type AnimationLoopMode } from './evaluate.js';

export interface AnimationPlayerState {
	/** Playhead time in ms, inside `[0, duration]`. */
	time: number;
	playing: boolean;
	/** True between `scrub` and `endScrub`. */
	scrubbing: boolean;
	loop: AnimationLoopMode;
	/** Speed multiplier (negative plays backwards). */
	playbackRate: number;
	duration: number;
}

export interface AnimationPlayerOptions {
	/** Time source (default `realClock`: requestAnimationFrame). Pass a `ManualClock` in tests or for rendering. */
	clock?: Clock;
	/** Timeline length in ms, or a getter (e.g. the last keyframe time). Default 1000. */
	duration?: number | (() => number);
	loop?: AnimationLoopMode;
	playbackRate?: number;
	/** Initial playhead time (default 0). */
	time?: number;
	/** Called whenever the playhead moves (playback, seek, scrub). */
	onTime?: (time: number) => void;
	/** Called when non-looping playback reaches the end (or the start, playing backwards). */
	onEnd?: () => void;
}

/**
 * Plays a timeline on an injectable `Clock`: play / pause / seek / scrub with looping,
 * ping-pong and playback rate. It only asks the clock for frames while playing, so a
 * `ManualClock` steps it deterministically and the real clock's requestAnimationFrame is the
 * only place wall time enters.
 *
 * `getState()` returns a cached snapshot replaced on change (usable with `useSyncExternalStore`).
 */
export class AnimationPlayer {
	private readonly clock: Clock;
	private durationSource: number | (() => number);
	private onTime?: (time: number) => void;
	private onEnd?: () => void;
	private time: number;
	private playing = false;
	private scrubbing = false;
	private resumeAfterScrub = false;
	private loop: AnimationLoopMode;
	private rate: number;
	/** Unwrapped time at `anchorAt` (keeps the ping-pong direction across frames). */
	private anchorRaw = 0;
	private anchorAt = 0;
	private generation = 0;
	private cached: AnimationPlayerState;
	private listeners = new Set<(state: AnimationPlayerState) => void>();

	constructor(options: AnimationPlayerOptions = {}) {
		this.clock = options.clock ?? realClock;
		this.durationSource = options.duration ?? 1000;
		this.loop = options.loop ?? 'none';
		this.rate = Number.isFinite(options.playbackRate) && options.playbackRate !== 0 ? options.playbackRate! : 1;
		this.onTime = options.onTime;
		this.onEnd = options.onEnd;
		this.time = this.clamp(options.time ?? 0);
		this.cached = this.snapshot();
	}

	/** Current timeline length (ms). */
	get duration(): number {
		const d = typeof this.durationSource === 'function' ? this.durationSource() : this.durationSource;
		return Number.isFinite(d) && d > 0 ? d : 0;
	}

	get currentTime(): number {
		return this.time;
	}

	get isPlaying(): boolean {
		return this.playing;
	}

	getState(): AnimationPlayerState {
		return this.cached;
	}

	subscribe(listener: (state: AnimationPlayerState) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Replaces the callbacks (hooks keep them current without recreating the player). */
	setCallbacks(callbacks: { onTime?: (time: number) => void; onEnd?: () => void }): void {
		this.onTime = callbacks.onTime;
		this.onEnd = callbacks.onEnd;
	}

	setDuration(duration: number | (() => number)): void {
		this.durationSource = duration;
		this.time = this.clamp(this.time);
		this.emit(false);
	}

	setLoop(loop: AnimationLoopMode): void {
		if (loop === this.loop) return;
		this.reanchor();
		this.loop = loop;
		this.emit(false);
	}

	setPlaybackRate(rate: number): void {
		if (!Number.isFinite(rate) || rate === 0 || rate === this.rate) return;
		this.reanchor();
		this.rate = rate;
		this.emit(false);
	}

	/** Starts playing from the playhead (from the start again when a one-shot play had ended). */
	play(): void {
		if (this.playing) return;
		const d = this.duration;
		if (this.loop === 'none' && d > 0) {
			if (this.rate > 0 && this.time >= d) this.time = 0;
			if (this.rate < 0 && this.time <= 0) this.time = d;
		}
		this.playing = true;
		this.scrubbing = false;
		this.anchorRaw = this.time;
		this.anchorAt = this.clock.now();
		this.emit(false);
		this.schedule();
	}

	pause(): void {
		if (!this.playing) return;
		this.tick(false);
		this.playing = false;
		this.generation++;
		this.emit(true);
	}

	toggle(): void {
		if (this.playing) this.pause();
		else this.play();
	}

	/** Pauses and returns to the start. */
	stop(): void {
		this.playing = false;
		this.generation++;
		this.seek(0);
	}

	/** Moves the playhead (clamped to the timeline); playback continues from there. */
	seek(time: number): void {
		if (!Number.isFinite(time)) return;
		this.time = this.clamp(time);
		this.anchorRaw = this.time;
		this.anchorAt = this.clock.now();
		this.emit(true);
	}

	/** Seeks while dragging the playhead: playback pauses until `endScrub`. */
	scrub(time: number): void {
		if (!this.scrubbing) {
			this.resumeAfterScrub = this.playing;
			if (this.playing) {
				this.playing = false;
				this.generation++;
			}
			this.scrubbing = true;
		}
		this.seek(time);
	}

	/** Ends a scrub, resuming playback if it was playing when the scrub began. */
	endScrub(): void {
		if (!this.scrubbing) return;
		this.scrubbing = false;
		const resume = this.resumeAfterScrub;
		this.resumeAfterScrub = false;
		if (resume) this.play();
		else this.emit(false);
	}

	/** Stops scheduling frames and drops listeners. */
	destroy(): void {
		this.playing = false;
		this.generation++;
		this.listeners.clear();
	}

	private clamp(time: number): number {
		return Math.min(this.duration, Math.max(0, Number.isFinite(time) ? time : 0));
	}

	private reanchor() {
		if (!this.playing) return;
		this.tick(false);
		this.anchorRaw = this.rawNow();
		this.anchorAt = this.clock.now();
	}

	private rawNow(): number {
		return this.anchorRaw + (this.clock.now() - this.anchorAt) * this.rate;
	}

	private schedule() {
		const generation = this.generation;
		this.clock.frame().then(() => {
			if (generation !== this.generation || !this.playing) return;
			this.tick(true);
			if (this.playing) this.schedule();
		});
	}

	/** Advances the playhead to the clock's time; `notify` emits the change. */
	private tick(notify: boolean) {
		if (!this.playing) return;
		const d = this.duration;
		const raw = this.rawNow();
		let ended = false;
		if (this.loop === 'none' || d <= 0) {
			if (this.rate > 0 && raw >= d) {
				this.time = d;
				ended = true;
			} else if (this.rate < 0 && raw <= 0) {
				this.time = 0;
				ended = true;
			} else this.time = this.clamp(raw);
		} else {
			this.time = wrapAnimationTime(raw, d, this.loop);
		}
		if (ended) {
			this.playing = false;
			this.generation++;
		}
		if (notify || ended) this.emit(true);
		if (ended) this.onEnd?.();
	}

	private snapshot(): AnimationPlayerState {
		return {
			time: this.time,
			playing: this.playing,
			scrubbing: this.scrubbing,
			loop: this.loop,
			playbackRate: this.rate,
			duration: this.duration
		};
	}

	private emit(timeChanged: boolean) {
		const next = this.snapshot();
		const prev = this.cached;
		if (
			prev.time === next.time &&
			prev.playing === next.playing &&
			prev.scrubbing === next.scrubbing &&
			prev.loop === next.loop &&
			prev.playbackRate === next.playbackRate &&
			prev.duration === next.duration
		) {
			return;
		}
		this.cached = next;
		if (timeChanged && prev.time !== next.time) this.onTime?.(next.time);
		for (const listener of this.listeners) listener(next);
	}
}

export function createAnimationPlayer(options?: AnimationPlayerOptions): AnimationPlayer {
	return new AnimationPlayer(options);
}
