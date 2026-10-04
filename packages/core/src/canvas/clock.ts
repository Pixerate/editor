/**
 * The time source that canvas animations and agent performances play on.
 *
 * Defaults to `realClock` (requestAnimationFrame and setTimeout).
 * A `ManualClock` moves only when told to via `advance(ms)` or `tick(fps)`,
 * enabling deterministic frame-by-frame stepping for testing, video generation,
 * or headless server environments.
 */

export interface Clock {
	/** Current time in milliseconds. */
	now(): number;
	/** Resolves on the next animation frame. */
	frame(): Promise<void>;
	/** Resolves after `ms` milliseconds of this clock's time. */
	sleep(ms: number): Promise<void>;
	/**
	 * Whether the clock follows wall time. Live clocks stop or degrade when the
	 * tab is in the background (browsers pause animation frames), so transitions
	 * can commit immediately rather than leaving operations hanging.
	 */
	readonly live: boolean;
}

/** Whether the browser tab is hidden (where RAF pauses). */
export const pageHidden = (): boolean =>
	typeof document !== 'undefined' && document.hidden;

/** Real-time clock using requestAnimationFrame and setTimeout. */
export const realClock: Clock = {
	live: true,
	now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
	frame: () =>
		new Promise<void>((resolve) => {
			if (typeof requestAnimationFrame === 'function' && !pageHidden()) {
				requestAnimationFrame(() => resolve());
			} else {
				setTimeout(resolve, 16);
			}
		}),
	sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)))
};

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * A deterministic clock that only moves forward when `advance` or `tick` is called.
 * Allows step-by-step frame testing and video rendering without waiting for real time.
 */
export class ManualClock implements Clock {
	readonly live = false;
	private time: number;
	private frames: (() => void)[] = [];
	private sleepers: { at: number; seq: number; resolve: () => void }[] = [];
	private seq = 0;

	constructor(start = 0) {
		this.time = start;
	}

	public now(): number {
		return this.time;
	}

	public frame(): Promise<void> {
		return new Promise<void>((resolve) => this.frames.push(resolve));
	}

	public sleep(ms: number): Promise<void> {
		return new Promise<void>((resolve) =>
			this.sleepers.push({
				at: this.time + Math.max(0, ms),
				seq: this.seq++,
				resolve
			})
		);
	}

	/** Whether any frames or sleep timers are currently pending. */
	public get pending(): boolean {
		return this.frames.length > 0 || this.sleepers.length > 0;
	}

	/** Advances time by `ms`, resolving due sleep timers in order, followed by queued frames. */
	public async advance(ms: number): Promise<void> {
		const end = this.time + Math.max(0, ms);
		await settle();

		while (true) {
			let next: (typeof this.sleepers)[number] | undefined;
			for (const s of this.sleepers) {
				if (s.at <= end && (!next || s.at < next.at || (s.at === next.at && s.seq < next.seq))) {
					next = s;
				}
			}
			if (!next) break;

			this.sleepers.splice(this.sleepers.indexOf(next), 1);
			this.time = Math.max(this.time, next.at);
			next.resolve();
			await settle();
		}

		this.time = end;
		const dueFrames = this.frames.splice(0, this.frames.length);
		for (const resolveFrame of dueFrames) {
			resolveFrame();
		}
		await settle();
	}

	/** Convenience method to advance by 1 frame at a given fps (default: 60fps = 16.67ms). */
	public async tick(fps = 60): Promise<void> {
		await this.advance(Math.round(1000 / fps));
	}
}
