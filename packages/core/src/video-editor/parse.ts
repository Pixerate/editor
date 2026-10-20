import { VIDEO_GRADE_CONTROLS } from './grade.js';
import { checkVideoTimeRemap } from './remap.js';
import { VIDEO_EASE_NAMES, type VideoAnimatable, type VideoEase, type VideoKey, type VideoKeyframes } from './keyframes.js';
import { VIDEO_BLEND_MODES, VIDEO_CLIP_ANIMATION_EFFECTS, VIDEO_CLIP_TYPES, VIDEO_FADE_CURVES, VIDEO_FITS, VIDEO_TRANSITION_TYPES, VIDEO_WIPE_DIRECTIONS, type VideoAsset, type VideoAssetProxy, type VideoClip, type VideoClipEffect, type VideoEffectRef, type VideoEffectValues, type VideoClipAnimation, type VideoGrade, type VideoGradeLut, type VideoMarker, type VideoProject, type VideoSequence, type VideoTrack, type VideoTranscriptWord, type VideoTransform, type VideoTransition } from './types.js';

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (path: string, what: string): never => {
	throw new Error(`${path} ${what}.`);
};
const str = (v: unknown, path: string, optional = false): string | undefined => {
	if (v === undefined && optional) return undefined;
	if (typeof v !== 'string' || (!optional && !v.length)) fail(path, 'must be a non-empty string');
	return v as string;
};
const num = (v: unknown, path: string, { min, positive, optional, max }: { min?: number; positive?: boolean; optional?: boolean; max?: number } = {}): number | undefined => {
	if (v === undefined && optional) return undefined;
	if (typeof v !== 'number' || !Number.isFinite(v)) return fail(path, 'must be a number');
	if (positive && !(v > 0)) fail(path, 'must be greater than 0');
	if (min !== undefined && v < min) fail(path, `must be at least ${min}`);
	if (max !== undefined && v > max) fail(path, `must be at most ${max}`);
	return v;
};
const bool = (v: unknown, path: string): boolean | undefined => {
	if (v === undefined) return undefined;
	if (typeof v !== 'boolean') fail(path, 'must be true or false');
	return v as boolean;
};
const oneOf = <T extends string>(v: unknown, options: readonly T[], path: string, optional = true): T | undefined => {
	if (v === undefined && optional) return undefined;
	if (!options.includes(v as T)) fail(path, `must be one of ${options.map((o) => `"${o}"`).join(', ')}`);
	return v as T;
};
/** Copies only the defined keys, so parsed objects carry no `undefined` fields. */
const compact = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function parseVideoEase(v: unknown, path: string): VideoEase | undefined {
	if (v === undefined) return undefined;
	if (Array.isArray(v)) {
		if (v.length !== 4 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) fail(path, 'must be four numbers [x1, y1, x2, y2] (CSS cubic-bezier)');
		if (v[0] < 0 || v[0] > 1 || v[2] < 0 || v[2] > 1) fail(path, 'must have x1 and x2 between 0 and 1');
		return [v[0], v[1], v[2], v[3]];
	}
	return oneOf(v, VIDEO_EASE_NAMES, path)! as VideoEase;
}

/**
 * Keyframes `{ keys: [{ t, v, ease }] }`: at least one key, in strictly increasing time (clip-relative
 * ms), each value within `range`.
 */
export function parseVideoKeyframes(v: unknown, path: string, { min, max }: { min?: number; max?: number } = {}): VideoKeyframes {
	if (!isObject(v)) return fail(path, 'must be a number or keyframes { keys: [{ t, v, ease }] }');
	for (const key of Object.keys(v)) if (key !== 'keys') fail(`${path}.${key}`, 'is not a keyframes field (keys)');
	if (!Array.isArray(v.keys) || !v.keys.length) fail(`${path}.keys`, 'must be an array of at least one key { t, v, ease }');
	const keys = (v.keys as unknown[]).map((k, i): VideoKey => {
		const at = `${path}.keys[${i}]`;
		if (!isObject(k)) return fail(at, 'must be an object { t, v, ease }');
		for (const key of Object.keys(k)) if (!['t', 'v', 'ease'].includes(key)) fail(`${at}.${key}`, 'is not a key field (t, v, ease)');
		return compact({ t: num(k.t, `${at}.t`)!, v: num(k.v, `${at}.v`, { min, max })!, ease: parseVideoEase(k.ease, `${at}.ease`) });
	});
	for (let i = 1; i < keys.length; i++) if (!(keys[i].t > keys[i - 1].t)) fail(`${path}.keys[${i}].t`, `must be later than the key before (${keys[i - 1].t} ms); keys go in time order, one per time`);
	return { keys };
}

/** A number within `range`, or keyframes for one. */
export function parseVideoAnimatable(v: unknown, path: string, range: { min?: number; max?: number; optional?: boolean } = {}): VideoAnimatable | undefined {
	if (v === undefined && range.optional) return undefined;
	const { min, max } = range;
	if (isObject(v)) return parseVideoKeyframes(v, path, { min, max });
	return num(v, path, { min, max });
}

export function parseVideoTransform(v: unknown, path: string): VideoTransform | undefined {
	if (v === undefined) return undefined;
	if (!isObject(v)) return fail(path, 'must be an object { x, y, scale, rotation }');
	for (const key of Object.keys(v)) if (!['x', 'y', 'scale', 'rotation'].includes(key)) fail(`${path}.${key}`, 'is not a transform field (x, y, scale, rotation)');
	return compact({
		x: parseVideoAnimatable(v.x, `${path}.x`, { optional: true }),
		y: parseVideoAnimatable(v.y, `${path}.y`, { optional: true }),
		scale: parseVideoAnimatable(v.scale, `${path}.scale`, { optional: true, min: 0 }),
		rotation: parseVideoAnimatable(v.rotation, `${path}.rotation`, { optional: true })
	});
}

export function parseVideoTimeRemap(v: unknown, speed: unknown, path: string): VideoKeyframes | undefined {
	if (v === undefined) return undefined;
	const remap = parseVideoAnimatable(v, path, { optional: true, min: 0 });
	if (typeof remap === 'number' || remap === undefined) return fail(path, 'must be keyframes { keys: [{ t, v, ease }] } (v: ms of source after the in point)');
	if (speed !== undefined && speed !== 1) fail(path, 'cannot be used with a speed; a ramp sets the speed itself (remove "speed")');
	try {
		checkVideoTimeRemap(remap, path);
	} catch (e) {
		throw new Error((e as Error).message.replace(/\.?$/, '.'));
	}
	return remap;
}

export function parseVideoClipAnimation(v: unknown, path: string): VideoClipAnimation | undefined {
	if (v === undefined) return undefined;
	if (!isObject(v)) return fail(path, 'must be an object { effect, duration }');
	return compact({
		effect: oneOf(v.effect, VIDEO_CLIP_ANIMATION_EFFECTS, `${path}.effect`, false)!,
		duration: num(v.duration, `${path}.duration`, { optional: true, positive: true })
	});
}

export function parseVideoGrade(v: unknown, path: string): VideoGrade | undefined {
	if (v === undefined) return undefined;
	if (!isObject(v)) return fail(path, 'must be an object such as { exposure, contrast, saturation }');
	const known = new Set([...VIDEO_GRADE_CONTROLS.map((c) => c.key as string), 'lut']);
	const unknown = Object.keys(v).find((k) => !known.has(k));
	if (unknown) fail(`${path}.${unknown}`, `is not a grade setting; use ${[...known].join(', ')}`);
	return compact({ ...Object.fromEntries(VIDEO_GRADE_CONTROLS.map((c) => [c.key, num(v[c.key], `${path}.${c.key}`, { optional: true, min: c.min, max: c.max })])), lut: parseVideoGradeLut(v.lut, `${path}.lut`) }) as VideoGrade;
}

export function parseVideoGradeLut(v: unknown, path: string): VideoGradeLut | undefined {
	if (v === undefined) return undefined;
	if (!isObject(v)) return fail(path, 'must be an object { src, strength } naming a .cube file');
	const unknown = Object.keys(v).find((k) => !['src', 'strength', 'name'].includes(k));
	if (unknown) fail(`${path}.${unknown}`, 'is not a LUT setting; use src, strength, name');
	return compact({ src: str(v.src, `${path}.src`)!, strength: num(v.strength, `${path}.strength`, { optional: true, min: 0, max: 1 }), name: str(v.name, `${path}.name`, true) });
}

export function parseVideoTransition(v: unknown, path: string): VideoTransition | undefined {
	if (v === undefined) return undefined;
	if (!isObject(v)) return fail(path, 'must be an object { type, duration }');
	const type = oneOf(v.type, VIDEO_TRANSITION_TYPES, `${path}.type`, false)!;
	if (type === 'effect' && v.effect === undefined) fail(`${path}.effect`, 'is required for an effect transition: { effect: "<effect id>", values }');
	if (type !== 'effect' && v.effect !== undefined) fail(`${path}.effect`, 'is only for transitions of type "effect"');
	return compact({
		type,
		duration: num(v.duration, `${path}.duration`, { positive: true })!,
		color: str(v.color, `${path}.color`, true),
		direction: oneOf(v.direction, VIDEO_WIPE_DIRECTIONS, `${path}.direction`),
		audioCurve: oneOf(v.audioCurve, VIDEO_FADE_CURVES, `${path}.audioCurve`),
		effect: v.effect === undefined ? undefined : parseVideoEffectRef(v.effect, `${path}.effect`, false)
	});
}

const isEffectValue = (x: unknown) =>
	typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x)) || (Array.isArray(x) && x.every((n) => typeof n === 'number' && Number.isFinite(n)));

/**
 * Effect control values: plain values (numbers, strings, switches, number lists) or, when
 * `keyframes` is allowed, keyframes for numbers. Only their shape is checked here; the effect's
 * control schema needs the provider (`resolveEffectValues`).
 */
export function parseVideoEffectValues(v: unknown, path: string, keyframes = true): VideoEffectValues | undefined {
	if (v === undefined) return undefined;
	if (!isObject(v)) return fail(path, 'must be an object of control values from describe_effect');
	const out: VideoEffectValues = {};
	for (const [k, x] of Object.entries(v)) {
		if (isEffectValue(x)) out[k] = Array.isArray(x) ? [...x] : x;
		else if (keyframes && isObject(x)) out[k] = parseVideoKeyframes(x, `${path}.${k}`);
		else fail(`${path}.${k}`, keyframes ? 'must be a number, string, true / false, a list of numbers, or keyframes { keys }' : 'must be a number, string, true / false or a list of numbers');
	}
	return out;
}

/** `{ effect, provider, name, values }`. */
export function parseVideoEffectRef(v: unknown, path: string, keyframes = true): VideoEffectRef {
	if (!isObject(v)) return fail(path, 'must be an object { effect, values }');
	const unknown = Object.keys(v).find((k) => !['effect', 'provider', 'name', 'values'].includes(k));
	if (unknown) fail(`${path}.${unknown}`, 'is not an effect field; use effect, provider, name, values');
	return compact({ effect: str(v.effect, `${path}.effect`)!, provider: str(v.provider, `${path}.provider`, true), name: str(v.name, `${path}.name`, true), values: parseVideoEffectValues(v.values, `${path}.values`, keyframes) });
}

/** A clip's effect stack: unique ids, each `{ id, effect, provider, name, enabled, opacity, values }`. */
export function parseVideoClipEffects(v: unknown, path: string): VideoClipEffect[] | undefined {
	if (v === undefined) return undefined;
	if (!Array.isArray(v)) return fail(path, 'must be a list of effects { id, effect, values }');
	const ids = new Set<string>();
	const out = v.map((e, i): VideoClipEffect => {
		const at = `${path}[${i}]`;
		if (!isObject(e)) return fail(at, 'must be an object { id, effect, values }');
		const unknown = Object.keys(e).find((k) => !['id', 'effect', 'provider', 'name', 'values', 'enabled', 'opacity'].includes(k));
		if (unknown) fail(`${at}.${unknown}`, 'is not a clip effect field; use id, effect, provider, name, values, enabled, opacity');
		const id = str(e.id, `${at}.id`)!;
		if (ids.has(id)) fail(`${at}.id`, `repeats "${id}"; each effect on a clip needs its own id`);
		ids.add(id);
		const { effect, provider, name, values } = parseVideoEffectRef({ effect: e.effect, provider: e.provider, name: e.name, values: e.values }, at);
		return compact({ id, effect, provider, name, values, enabled: bool(e.enabled, `${at}.enabled`), opacity: parseVideoAnimatable(e.opacity, `${at}.opacity`, { optional: true, min: 0, max: 1 }) });
	});
	return out.length ? out : undefined;
}

export function parseVideoTranscriptWords(v: unknown, path: string): VideoTranscriptWord[] | undefined {
	if (v === undefined) return undefined;
	if (!Array.isArray(v)) return fail(path, 'must be an array of { word, start, end } (ms in the source)');
	const words = v.map((w, i) => {
		if (!isObject(w)) return fail(`${path}[${i}]`, 'must be an object { word, start, end }');
		const word = str(w.word, `${path}[${i}].word`)!;
		const start = num(w.start, `${path}[${i}].start`, { min: 0 })!;
		const end = num(w.end, `${path}[${i}].end`, { min: start })!;
		return { word, start, end };
	});
	return words.sort((a, b) => a.start - b.start);
}

export function parseVideoAsset(v: unknown, path = 'asset'): VideoAsset {
	if (!isObject(v)) return fail(path, 'must be an object');
	const kind = oneOf(v.kind, ['video', 'audio', 'image'] as const, `${path}.kind`, false)!;
	const asset: VideoAsset = compact({
		id: str(v.id, `${path}.id`)!,
		kind,
		src: str(v.src, `${path}.src`)!,
		name: str(v.name, `${path}.name`, true),
		duration: num(v.duration, `${path}.duration`, { optional: true, positive: true }),
		width: num(v.width, `${path}.width`, { optional: true, positive: true }),
		height: num(v.height, `${path}.height`, { optional: true, positive: true }),
		hasAudio: bool(v.hasAudio, `${path}.hasAudio`),
		poster: str(v.poster, `${path}.poster`, true),
		transcript: parseVideoTranscriptWords(v.transcript, `${path}.transcript`),
		proxies: parseVideoAssetProxies(v.proxies, `${path}.proxies`)
	});
	if (kind !== 'video' && asset.proxies) fail(`${path}.proxies`, 'are only for video assets');
	if (kind === 'image' && asset.transcript) fail(`${path}.transcript`, 'is only for video and audio assets');
	if (kind === 'image' && asset.duration !== undefined) fail(`${path}.duration`, 'is only for video and audio assets');
	return asset;
}

export function parseVideoAssetProxies(v: unknown, path: string): VideoAssetProxy[] | undefined {
	if (v === undefined) return undefined;
	if (!Array.isArray(v)) return fail(path, 'must be a list of { scale, src }');
	const out = v.map((p, i) => {
		const at = `${path}[${i}]`;
		if (!isObject(p)) return fail(at, 'must be an object { scale, src }');
		const unknown = Object.keys(p).find((k) => !['scale', 'src', 'width', 'height'].includes(k));
		if (unknown) fail(`${at}.${unknown}`, 'is not a proxy setting; use scale, src, width, height');
		const scale = num(p.scale, `${at}.scale`, { positive: true })!;
		if (scale >= 1) fail(`${at}.scale`, 'must be less than 1 (0.5 is half size)');
		return compact({ scale, src: str(p.src, `${at}.src`)!, width: num(p.width, `${at}.width`, { optional: true, positive: true }), height: num(p.height, `${at}.height`, { optional: true, positive: true }) });
	});
	const scales = new Set<number>();
	for (const [i, p] of out.entries()) {
		if (scales.has(p.scale)) fail(`${path}[${i}].scale`, `repeats ${p.scale}; give each proxy its own scale`);
		scales.add(p.scale);
	}
	return out.length ? out : undefined;
}

export function parseVideoClip(v: unknown, path = 'clip'): VideoClip {
	if (!isObject(v)) return fail(path, 'must be an object');
	const type = oneOf(v.type ?? 'media', VIDEO_CLIP_TYPES, `${path}.type`, false)!;
	const base = {
		id: str(v.id, `${path}.id`)!,
		name: str(v.name, `${path}.name`, true),
		start: num(v.start, `${path}.start`, { min: 0 })!,
		duration: num(v.duration, `${path}.duration`, { positive: true })!,
		opacity: parseVideoAnimatable(v.opacity, `${path}.opacity`, { optional: true, min: 0, max: 1 }),
		transform: parseVideoTransform(v.transform, `${path}.transform`),
		fit: oneOf(v.fit, VIDEO_FITS, `${path}.fit`),
		blend: oneOf(v.blend, VIDEO_BLEND_MODES, `${path}.blend`),
		grade: parseVideoGrade(v.grade, `${path}.grade`),
		animateIn: parseVideoClipAnimation(v.animateIn, `${path}.animateIn`),
		animateOut: parseVideoClipAnimation(v.animateOut, `${path}.animateOut`),
		fadeIn: num(v.fadeIn, `${path}.fadeIn`, { optional: true, min: 0 }),
		fadeOut: num(v.fadeOut, `${path}.fadeOut`, { optional: true, min: 0 }),
		transition: parseVideoTransition(v.transition, `${path}.transition`),
		effects: parseVideoClipEffects(v.effects, `${path}.effects`)
	};
	if (type === 'media')
		return compact({
			type,
			...base,
			asset: str(v.asset, `${path}.asset`)!,
			in: num(v.in, `${path}.in`, { optional: true, min: 0 }),
			speed: num(v.speed, `${path}.speed`, { optional: true, min: 0.05, max: 20 }),
			volume: parseVideoAnimatable(v.volume, `${path}.volume`, { optional: true, min: 0, max: 4 }),
			muted: bool(v.muted, `${path}.muted`),
			timeRemap: parseVideoTimeRemap(v.timeRemap, v.speed, `${path}.timeRemap`),
			fadeInCurve: oneOf(v.fadeInCurve, VIDEO_FADE_CURVES, `${path}.fadeInCurve`),
			fadeOutCurve: oneOf(v.fadeOutCurve, VIDEO_FADE_CURVES, `${path}.fadeOutCurve`)
		});
	if (type === 'sequence') {
		// The sound and pictures of a sequence are not re-timed yet, so a compound plays at normal speed.
		for (const key of ['speed', 'timeRemap'])
			if (v[key] !== undefined && !(key === 'speed' && v[key] === 1)) fail(`${path}.${key}`, 'is not supported on a compound clip (type "sequence"), which plays its sequence at normal speed; remove it, or change the speed of the clips inside the sequence');
		return compact({
			type,
			...base,
			sequence: str(v.sequence, `${path}.sequence`)!,
			in: num(v.in, `${path}.in`, { optional: true, min: 0 }),
			volume: parseVideoAnimatable(v.volume, `${path}.volume`, { optional: true, min: 0, max: 4 }),
			muted: bool(v.muted, `${path}.muted`),
			fadeInCurve: oneOf(v.fadeInCurve, VIDEO_FADE_CURVES, `${path}.fadeInCurve`),
			fadeOutCurve: oneOf(v.fadeOutCurve, VIDEO_FADE_CURVES, `${path}.fadeOutCurve`)
		});
	}
	if (type === 'text')
		return compact({
			type,
			...base,
			text: str(v.text, `${path}.text`)!,
			color: str(v.color, `${path}.color`, true),
			fontSize: num(v.fontSize, `${path}.fontSize`, { optional: true, positive: true }),
			fontFamily: str(v.fontFamily, `${path}.fontFamily`, true),
			fontWeight: num(v.fontWeight, `${path}.fontWeight`, { optional: true, min: 100, max: 1000 }),
			background: str(v.background, `${path}.background`, true)
		});
	if (type === 'effect') {
		const ref = parseVideoEffectRef({ effect: v.effect, provider: v.provider, name: v.name === undefined ? undefined : v.name, values: v.values }, path);
		return compact({ type, ...base, ...ref, name: base.name });
	}
	return compact({ type, ...base, color: str(v.color, `${path}.color`)! });
}

export function parseVideoTrack(v: unknown, path = 'track'): VideoTrack {
	if (!isObject(v)) return fail(path, 'must be an object');
	if (v.clips !== undefined && !Array.isArray(v.clips)) fail(`${path}.clips`, 'must be an array');
	return compact({
		id: str(v.id, `${path}.id`)!,
		kind: oneOf(v.kind, ['video', 'audio'] as const, `${path}.kind`, false)!,
		name: str(v.name, `${path}.name`, true),
		muted: bool(v.muted, `${path}.muted`),
		hidden: bool(v.hidden, `${path}.hidden`),
		locked: bool(v.locked, `${path}.locked`),
		syncLocked: bool(v.syncLocked, `${path}.syncLocked`),
		volume: num(v.volume, `${path}.volume`, { optional: true, min: 0, max: 4 }),
		clips: ((v.clips ?? []) as unknown[]).map((c, i) => parseVideoClip(c, `${path}.clips[${i}]`))
	});
}

/** A nested sequence `{ id, name, tracks }` (see `VideoSequence`). */
export function parseVideoSequence(v: unknown, path = 'sequence'): VideoSequence {
	if (!isObject(v)) return fail(path, 'must be an object { id, name, tracks }');
	if (v.tracks !== undefined && !Array.isArray(v.tracks)) fail(`${path}.tracks`, 'must be an array');
	const sequence: VideoSequence = compact({
		id: str(v.id, `${path}.id`)!,
		name: str(v.name, `${path}.name`, true),
		tracks: ((v.tracks ?? []) as unknown[]).map((t, i) => parseVideoTrack(t, `${path}.tracks[${i}]`))
	});
	const seen = new Set<string>();
	for (const t of sequence.tracks) {
		if (seen.has(t.id)) throw new Error(`Two tracks in sequence "${sequence.id}" share the id "${t.id}"; ids must be unique.`);
		seen.add(t.id);
	}
	return sequence;
}

export function parseVideoMarker(v: unknown, path = 'marker'): VideoMarker {
	if (!isObject(v)) return fail(path, 'must be an object');
	return compact({ id: str(v.id, `${path}.id`)!, time: num(v.time, `${path}.time`, { min: 0 })!, label: str(v.label, `${path}.label`, true), color: str(v.color, `${path}.color`, true) });
}

/**
 * Reads a project from JSON text or an object, checking every field. Throws an error naming the
 * first bad field (`tracks[0].clips[2].duration must be greater than 0.`). Ids must be unique
 * within assets, tracks, sequences, clips (across the project and its sequences) and markers.
 * Overlaps, missing media and sequences, and sequences that contain themselves are left to
 * `checkVideoProject`, so a project with problems can still be opened and fixed.
 */
export function parseVideoProject(input: unknown): VideoProject {
	let v = input;
	if (typeof v === 'string') {
		try {
			v = JSON.parse(v);
		} catch (error) {
			throw new Error(`The project is not valid JSON: ${(error as Error).message}`);
		}
	}
	if (!isObject(v)) return fail('The project', 'must be an object');
	if (v.version !== undefined && v.version !== 1) fail('version', 'must be 1');
	for (const key of ['assets', 'tracks', 'sequences', 'markers']) if (v[key] !== undefined && !Array.isArray(v[key])) fail(key, 'must be an array');
	const project: VideoProject = compact({
		version: 1 as const,
		name: str(v.name, 'name', true),
		width: num(v.width, 'width', { positive: true })!,
		height: num(v.height, 'height', { positive: true })!,
		fps: num(v.fps ?? 30, 'fps', { positive: true, max: 240 })!,
		background: str(v.background, 'background', true),
		assets: ((v.assets ?? []) as unknown[]).map((a, i) => parseVideoAsset(a, `assets[${i}]`)),
		tracks: ((v.tracks ?? []) as unknown[]).map((t, i) => parseVideoTrack(t, `tracks[${i}]`)),
		sequences: v.sequences === undefined ? undefined : (v.sequences as unknown[]).map((q, i) => parseVideoSequence(q, `sequences[${i}]`)),
		markers: v.markers === undefined ? undefined : (v.markers as unknown[]).map((m, i) => parseVideoMarker(m, `markers[${i}]`))
	});
	const unique = (ids: string[], what: string) => {
		const seen = new Set<string>();
		for (const id of ids) {
			if (seen.has(id)) throw new Error(`Two ${what} share the id "${id}"; ids must be unique.`);
			seen.add(id);
		}
	};
	unique(project.assets.map((a) => a.id), 'assets');
	unique(project.tracks.map((t) => t.id), 'tracks');
	unique((project.sequences ?? []).map((q) => q.id), 'sequences');
	// Clip ids are unique across the project and every sequence, so an id names one clip.
	unique([...project.tracks, ...(project.sequences ?? []).flatMap((q) => q.tracks)].flatMap((t) => t.clips.map((c) => c.id)), 'clips');
	unique((project.markers ?? []).map((m) => m.id), 'markers');
	return project;
}

export interface CreateVideoProjectOptions {
	name?: string;
	/** Default 1920. */
	width?: number;
	/** Default 1080. */
	height?: number;
	/** Default 30. */
	fps?: number;
	background?: string;
}

/** An empty project with one video track (`v1`) and one audio track (`a1`). */
export function createVideoProject(options: CreateVideoProjectOptions = {}): VideoProject {
	return compact({
		version: 1 as const,
		name: options.name,
		width: options.width ?? 1920,
		height: options.height ?? 1080,
		fps: options.fps ?? 30,
		background: options.background,
		assets: [],
		tracks: [
			{ id: 'v1', kind: 'video' as const, name: 'Video 1', clips: [] },
			{ id: 'a1', kind: 'audio' as const, name: 'Audio 1', clips: [] }
		]
	});
}
