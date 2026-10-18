// Protected regions adapted from effectcraft-main/crates/render/src/eval.rs (`responsive_source_time`), MIT OR Apache-2.0, © ArtCraft Team and contributors.
import { compileMotionScene } from './compile.js';
import { namedWithSuggestion } from './issues.js';
import type { MotionScene } from './types.js';

export interface MotionFitOptions {
	/** Shot ids that keep their pace (a logo hold, a line of narration); the others absorb the change. */
	keep?: readonly string[];
}

export interface MotionFit {
	scene: MotionScene;
	/** The length after fitting, ms (within a few ms of the target: speeds are rounded). */
	duration: number;
	/** The new `speed` of every shot that changed. */
	speeds: Record<string, number>;
}

/** Speeds are kept within this range. */
export const MOTION_SPEED_RANGE: readonly [number, number] = [0.05, 20];

/**
 * Fits a scene to `ms` by setting its shots' `speed`: the shots in `keep` play as they are and
 * the rest stretch or squeeze by the same factor, so their timing keeps its proportions (the
 * responsive time of After Effects' protected regions). Throws, changing nothing, when the
 * kept shots alone outlast the target or a speed would leave `MOTION_SPEED_RANGE`.
 */
export function fitMotionScene(scene: MotionScene, ms: number, options: MotionFitOptions = {}): MotionFit {
	if (!(Number.isFinite(ms) && ms > 0)) throw new Error('Give the length to fit as a number of milliseconds above 0.');
	const ids = scene.shots.map((s) => s.id);
	const keep = new Set(options.keep ?? []);
	for (const id of keep) if (!ids.includes(id)) throw new Error(`There is no shot ${namedWithSuggestion(id, ids)} to keep.`);
	const timeline = compileMotionScene(scene);
	let kept = 0;
	let rest = 0;
	timeline.shots.forEach((t) => (keep.has(t.id) ? (kept += t.end - t.start) : (rest += t.end - t.start)));
	if (rest <= 0) throw new Error(keep.size ? 'Every shot is kept, so nothing can change pace; keep fewer shots.' : 'The scene has no length to fit; add shots first.');
	if (ms <= kept) throw new Error(`The kept shots alone last ${Math.round(kept)} ms, so the scene cannot fit ${Math.round(ms)} ms; keep fewer shots or give at least ${Math.ceil(kept) + 1} ms.`);
	const k = (ms - kept) / rest;
	const speeds: Record<string, number> = {};
	const shots = scene.shots.map((shot) => {
		if (keep.has(shot.id)) return shot;
		const speed = Math.round(((shot.speed ?? 1) / k) * 10000) / 10000;
		if (speed < MOTION_SPEED_RANGE[0] || speed > MOTION_SPEED_RANGE[1])
			throw new Error(`Fitting ${Math.round(ms)} ms would play shot "${shot.id}" at ${speed}× (speeds run ${MOTION_SPEED_RANGE[0]}–${MOTION_SPEED_RANGE[1]}); aim nearer the current ${Math.round(timeline.duration)} ms.`);
		speeds[shot.id] = speed;
		const { speed: _old, ...rest } = shot;
		return speed === 1 ? rest : { ...rest, speed };
	});
	const fitted: MotionScene = { ...scene, shots };
	return { scene: fitted, duration: compileMotionScene(fitted).duration, speeds };
}
