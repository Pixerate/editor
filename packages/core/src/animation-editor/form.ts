import { ANIMATION_EASING_LABELS, ANIMATION_EASING_PRESETS, evaluateEasing, resolveEasing, springSettleMs, type AnimationEasing } from '../animation/easing.js';
import type { JsonSchema } from '../tools/schema.js';
import { compileMotionScene, indexMotionNodes, motionBeatAt, motionBeatTime, motionCueTime } from './compile.js';
import type { MotionEdit } from './edit.js';
import { fitMotionScene, type MotionFitOptions } from './fit.js';
import { MOTION_COMMAND_SCHEMA } from './tools.js';
import { motionFlairPrimitive, type MotionCommand, type MotionCommandType, type MotionCue, type MotionNarration, type MotionScene } from './types.js';

/**
 * Helpers for hand-editing UIs (React's and Svelte's command inspector, ease picker, cue picker,
 * scrubber and stage picking). They hold the logic both bindings share, so the components stay
 * thin and alike. The command form is generated from `MOTION_COMMAND_SCHEMA`, the same schema
 * the agent tools take, so people and agents see the same fields, limits and descriptions.
 */

/** How a command field is edited. */
export type MotionFieldKind = 'targets' | 'node' | 'enum' | 'number' | 'integer' | 'boolean' | 'text' | 'color' | 'point' | 'scale' | 'ease';

export interface MotionFieldSpec {
	name: string;
	kind: MotionFieldKind;
	label: string;
	description: string;
	required: boolean;
	/** For `enum`. */
	options?: readonly string[];
	min?: number;
	max?: number;
	/** Unit shown next to a number: `ms`, `units`, `°`, `Hz`, `fps`, `×` or `0–1`. */
	unit?: string;
	/** `main` (what it does) or `timing` (when and how fast). */
	group: 'main' | 'timing';
}

const TIMING = new Set(['duration', 'delay', 'stagger', 'with', 'ease', 'repeat', 'repeatMode', 'steps', 'note']);
const COLORS = new Set(['fill', 'stroke', 'color']);
const NODES = new Set(['into', 'path']);

function branch(type: MotionCommandType): JsonSchema | undefined {
	return (MOTION_COMMAND_SCHEMA.oneOf ?? []).find((b) => (b.properties?.type as JsonSchema | undefined)?.const === type);
}

function unitOf(type: MotionCommandType, name: string): string | undefined {
	if (name === 'duration' || name === 'delay' || name === 'stagger') return 'ms';
	if (name === 'steps') return 'fps';
	if (name === 'frequency') return 'Hz';
	if (name === 'repeat' || name === 'count') return '×';
	if (name === 'distance' || name === 'strokeWidth') return 'units';
	if (name === 'angle') return '°';
	if (name === 'amount') return type === 'pulse' ? '×' : 'units';
	if (name === 'rotate' && type === 'wiggle') return '°';
	if ((name === 'by' || name === 'to') && type === 'rotate') return '°';
	if (name === 'scale' || (name === 'to' && type === 'scale')) return '×';
	if ((name === 'from' || name === 'to') && (type === 'draw' || type === 'fade' || type === 'follow')) return '0–1';
	return undefined;
}

/** `repeatMode` → `Repeat mode`. */
export function motionFieldLabel(name: string): string {
	const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

function kindOf(name: string, schema: JsonSchema): MotionFieldKind {
	if (name === 'targets') return 'targets';
	if (name === 'ease') return 'ease';
	if (schema.enum) return 'enum';
	if (schema.anyOf) return 'scale';
	if (schema.type === 'object') return 'point';
	if (schema.type === 'boolean') return 'boolean';
	if (schema.type === 'integer') return 'integer';
	if (schema.type === 'number') return 'number';
	if (COLORS.has(name)) return 'color';
	if (NODES.has(name)) return 'node';
	return 'text';
}

/**
 * The fields a command type takes, in schema order (main fields first, then timing), each with
 * how to edit it, its limits and unit. Generated from `MOTION_COMMAND_SCHEMA`.
 */
export function motionCommandFields(type: MotionCommandType): MotionFieldSpec[] {
	const schema = branch(type);
	if (!schema?.properties) return [];
	const required = new Set(schema.required ?? []);
	const fields = Object.entries(schema.properties)
		.filter(([name]) => name !== 'type')
		.map(([name, s]): MotionFieldSpec => {
			const kind = kindOf(name, s);
			const min = typeof s.minimum === 'number' ? s.minimum : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum : undefined;
			return {
				name,
				kind,
				label: motionFieldLabel(name),
				description: s.description ?? '',
				required: required.has(name),
				...(s.enum ? { options: s.enum.map(String) } : {}),
				...(min !== undefined ? { min } : {}),
				...(typeof s.maximum === 'number' ? { max: s.maximum } : {}),
				...(unitOf(type, name) ? { unit: unitOf(type, name) } : {}),
				group: TIMING.has(name) ? 'timing' : 'main'
			};
		});
	return [...fields.filter((f) => f.group === 'main'), ...fields.filter((f) => f.group === 'timing')];
}

export type MotionFieldInput = { set: unknown } | { remove: true } | { error: string };

/**
 * Turns what a person typed into a field into a value to `set`, a field to `remove` (an empty
 * optional field) or an `error` to show. Numbers are checked against the field's limits.
 */
export function parseMotionFieldInput(field: MotionFieldSpec, raw: string | boolean | readonly string[] | { x: string; y: string }): MotionFieldInput {
	if (field.kind === 'boolean') return raw === true ? { set: true } : { remove: true };
	if (field.kind === 'targets') {
		const ids = (Array.isArray(raw) ? raw : String(raw).split(',')).map((s) => String(s).trim()).filter(Boolean);
		return ids.length ? { set: ids } : { error: 'Pick at least one target.' };
	}
	if (field.kind === 'point' || (field.kind === 'scale' && typeof raw === 'object' && !Array.isArray(raw))) {
		const p = raw as { x: string; y: string };
		if (p.x.trim() === '' && p.y.trim() === '') return field.required ? { error: `${field.label} is required.` } : { remove: true };
		const x = Number(p.x);
		const y = Number(p.y);
		if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: `${field.label} needs a number for x and for y.` };
		return { set: { x, y } };
	}
	const text = String(raw).trim();
	if (text === '') return field.required ? { error: `${field.label} is required.` } : { remove: true };
	if (field.kind === 'number' || field.kind === 'integer' || field.kind === 'scale') {
		const n = Number(text);
		if (!Number.isFinite(n)) return { error: `${field.label} must be a number${field.unit ? ` (${field.unit})` : ''}.` };
		if (field.kind === 'integer' && !Number.isInteger(n)) return { error: `${field.label} must be a whole number.` };
		if (field.min !== undefined && n < field.min) return { error: `${field.label} must be at least ${field.min}.` };
		if (field.max !== undefined && n > field.max) return { error: `${field.label} must be at most ${field.max}.` };
		return { set: n };
	}
	if (field.kind === 'enum' && field.options && !field.options.includes(text)) return { error: `${field.label} must be one of ${field.options.join(', ')}.` };
	return { set: text };
}

/** The `update_command` edit for one field input, or the error to show. */
export function motionFieldEdit(shot: string, command: number, field: MotionFieldSpec, raw: Parameters<typeof parseMotionFieldInput>[1]): MotionEdit | { error: string } {
	const input = parseMotionFieldInput(field, raw);
	if ('error' in input) return input;
	if ('remove' in input) return { op: 'update_command', shot, command, remove: [field.name] };
	return { op: 'update_command', shot, command, set: { [field.name]: input.set } };
}

/**
 * A new command of `type` on `targets`, with its required fields filled from the artwork (the
 * first hidden shape to morph into, the first path to follow, the first effect parameter to
 * tween). Returns an error when the artwork has nothing to fill one with.
 */
export function defaultMotionCommand(type: MotionCommandType, targets: readonly string[], scene: MotionScene): MotionCommand | { error: string } {
	if (type === 'wait') return { type: 'wait', duration: 500 };
	if (!targets.length) return { error: 'Pick a target first: click an element on the stage.' };
	const nodes = [...indexMotionNodes(scene.artwork.nodes).values()];
	const other = (pred: (e: (typeof nodes)[number]) => boolean) => nodes.find((e) => !targets.includes(e.node.id) && pred(e))?.node.id;
	const base = { targets: [...targets] };
	switch (type) {
		case 'scale':
			return { type, ...base, to: 1.2 };
		case 'fade':
			return { type, ...base, to: 0.5 };
		case 'move':
			return { type, ...base, by: { x: 40, y: 0 } };
		case 'rotate':
			return { type, ...base, by: 90 };
		case 'style':
			return { type, ...base, fill: '#f59e0b' };
		case 'morph': {
			const into = other((e) => e.node.type === 'path' && e.node.visible === false) ?? other((e) => e.node.type === 'path');
			return into ? { type, ...base, into } : { error: 'Morph needs another shape to become; draw one (it can stay hidden).' };
		}
		case 'match': {
			const into = other((e) => e.node.type === 'group' && e.node.visible === false) ?? other((e) => e.node.type === 'group');
			return into ? ({ type, ...base, into } as MotionCommand) : { error: 'Match needs another group to become; group the end state (it can stay hidden).' };
		}
		case 'follow': {
			const path = other((e) => e.node.type === 'path' && e.node.visible === false) ?? other((e) => e.node.type === 'path');
			return path ? { type, ...base, path } : { error: 'Follow needs a path to travel along; draw one (it can stay hidden).' };
		}
		case 'effect': {
			for (const id of targets) {
				const node = nodes.find((e) => e.node.id === id)?.node;
				for (const effect of node?.effects ?? []) {
					const param = Object.entries(effect.params as unknown as Record<string, unknown>).find(([, v]) => typeof v === 'number');
					if (param) return { type, ...base, effect: effect.id, param: param[0], to: (param[1] as number) + 1 };
				}
			}
			return { error: 'Effect needs a target with a live path effect (wiggle, twist, zig zag…).' };
		}
		default:
			return { type, ...base } as MotionCommand;
	}
}

/** A short line for a command in a list: `enter pop · ring, badge`. */
export function motionCommandSummary(command: MotionCommand): string {
	const c = command as unknown as Record<string, unknown>;
	const what = [command.type, typeof c.style === 'string' ? c.style : ''].filter(Boolean).join(' ');
	if (command.type === 'wait') return `wait ${command.duration} ms`;
	const extra = typeof c.into === 'string' ? ` → ${c.into}` : typeof c.path === 'string' ? ` along ${c.path}` : '';
	return `${what} · ${(command.targets ?? []).join(', ')}${extra}`;
}

/** The commands of a shot as a list UI shows them. */
export function motionCommandRows(scene: MotionScene, shotId: string) {
	const index = scene.shots.findIndex((s) => s.id === shotId);
	if (index < 0) return [];
	const timeline = compileMotionScene(scene);
	return scene.shots[index].run.map((command, i) => {
		const t = timeline.commands.find((c) => c.shotIndex === index && c.command === i);
		const primitive = motionFlairPrimitive(command);
		return { index: i, command, summary: motionCommandSummary(command), start: t?.start ?? 0, end: t?.end ?? 0, ...(primitive ? { flairPrimitive: primitive } : {}) };
	});
}

/** Edits that put a copy of a command right after it. */
export function duplicateMotionCommandEdit(scene: MotionScene, shot: string, command: number): MotionEdit {
	const run = scene.shots.find((s) => s.id === shot)?.run ?? [];
	return { op: 'add_commands', shot, commands: run[command] ? [structuredClone(run[command])] : [], at: command + 1 };
}

// ---------------------------------------------------------------------------------------------
// Easing

/** The ease picker's choices: `default` (the command type's own), every preset, then `custom`. */
export const MOTION_EASE_CHOICES: readonly { value: string; label: string }[] = [
	{ value: '', label: 'Default' },
	...ANIMATION_EASING_PRESETS.map((p) => ({ value: p, label: ANIMATION_EASING_LABELS[p] }))
];

/** The picker value for an easing: `''` for none, the preset name, else `custom`. */
export function motionEaseKey(ease: AnimationEasing | undefined | null): string {
	if (ease === undefined || ease === null) return '';
	return typeof ease === 'string' ? ease : 'custom';
}

export interface MotionEasingCurve {
	/** Samples of the eased value from u = 0 to 1. */
	points: { u: number; v: number }[];
	/** The lowest and highest eased value (below 0 or above 1 when the curve overshoots). */
	min: number;
	max: number;
	/** The length the curve was sampled over: a spring's settle time, else `durationMs`. */
	durationMs: number;
}

/** Samples an easing (`evaluateEasing`) for a preview; springs are sampled until they settle. */
export function motionEasingCurve(ease: AnimationEasing | string | undefined | null, samples = 48, durationMs = 1000): MotionEasingCurve {
	const resolved = resolveEasing(ease);
	const ms = resolved !== 'hold' && resolved.type === 'spring' ? springSettleMs(resolved) : durationMs;
	const n = Math.max(2, Math.floor(samples));
	const points: { u: number; v: number }[] = [];
	for (let i = 0; i <= n; i++) {
		const u = i / n;
		points.push({ u, v: resolved === 'hold' ? (i === n ? 1 : 0) : evaluateEasing(ease, u, ms) });
	}
	const values = points.map((p) => p.v);
	return { points, min: Math.min(0, ...values), max: Math.max(1, ...values), durationMs: ms };
}

/** An SVG path (`d`) of an easing curve in a `width` × `height` box, overshoot included. */
export function motionEasingPath(curve: MotionEasingCurve, width: number, height: number, pad = 4): string {
	const span = curve.max - curve.min || 1;
	const f = (n: number) => String(Math.round(n * 100) / 100);
	return curve.points
		.map((p, i) => `${i ? 'L' : 'M'}${f(pad + p.u * (width - 2 * pad))} ${f(pad + (1 - (p.v - curve.min) / span) * (height - 2 * pad))}`)
		.join(' ');
}

/** Where 0 and 1 fall on a curve preview's y axis (for guide lines). */
export function motionEasingGuides(curve: MotionEasingCurve, height: number, pad = 4): { zero: number; one: number } {
	const span = curve.max - curve.min || 1;
	const y = (v: number) => pad + (1 - (v - curve.min) / span) * (height - 2 * pad);
	return { zero: y(0), one: y(1) };
}

// ---------------------------------------------------------------------------------------------
// Stage picking

interface ElementLike {
	getAttribute(name: string): string | null;
	parentElement: ElementLike | null;
}

/**
 * The artwork node a click landed on: the nearest element (from `target` up to `root`) whose
 * id is a node of the scene. Onion-skin ghosts and motion-path overlays carry no node ids, so
 * clicks on them pick nothing.
 */
export function motionNodeAtElement(scene: MotionScene, target: ElementLike | null, root?: ElementLike | null): string | null {
	const ids = indexMotionNodes(scene.artwork.nodes);
	for (let el = target; el && el !== root; el = el.parentElement) {
		const id = el.getAttribute('id');
		if (id && ids.has(id)) return id;
	}
	return null;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Marks the nodes `ids` in stage SVG with `data-picked` and outlines them. */
export function highlightMotionSvg(svg: string, ids: readonly string[], color = '#f43f5e'): string {
	if (!ids.length) return svg;
	let out = svg;
	for (const id of ids) {
		const escaped = id.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
		out = out.replace(new RegExp(` id="${escapeRegExp(escaped)}"`), ` id="${escaped}" data-picked=""`);
	}
	return out.replace(/(<svg\b[^>]*>)/, `$1<style>[data-picked]{filter:drop-shadow(0 0 1px #fff) drop-shadow(0 0 3px ${color}) drop-shadow(0 0 3px ${color})}</style>`);
}

// ---------------------------------------------------------------------------------------------
// Time ruler, fit, cues and narration

/** Ticks for a time ruler `width` px wide: a step that leaves at least `minGap` px between labels. */
export function motionRulerTicks(duration: number, width: number, minGap = 56): { time: number; label: string; major: boolean }[] {
	const span = Math.max(1, duration);
	const steps = [100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000];
	const step = steps.find((s) => (s / span) * Math.max(1, width) >= minGap) ?? steps[steps.length - 1];
	const ticks: { time: number; label: string; major: boolean }[] = [];
	for (let t = 0; t <= span + 1e-6; t += step / 2) {
		const major = Math.round(t / (step / 2)) % 2 === 0;
		ticks.push({ time: t, major, label: major ? `${step < 1000 ? (t / 1000).toFixed(step < 500 ? 2 : 1) : String(Math.round(t / 1000))}s` : '' });
	}
	return ticks;
}

/**
 * The edits that fit a scene to `ms` (`fitMotionScene`): one `update_shot` per shot whose speed
 * changes, so applied together they are one undo step. Throws with the reason when it can't fit.
 */
export function fitMotionSceneEdits(scene: MotionScene, ms: number, options: MotionFitOptions = {}): MotionEdit[] {
	const fit = fitMotionScene(scene, ms, options);
	return fit.scene.shots.flatMap((shot, i): MotionEdit[] => {
		const before = scene.shots[i].speed;
		if (before === shot.speed) return [];
		return shot.speed === undefined ? [{ op: 'update_shot', shot: shot.id, remove: ['speed'] }] : [{ op: 'update_shot', shot: shot.id, set: { speed: shot.speed } }];
	});
}

/** A cue picker's value for a cue: `beat:4`, `word:2`, `ms:1200` or `''` for none. */
export function motionCueKey(cue: MotionCue | undefined): string {
	if (!cue) return '';
	if (typeof cue.beat === 'number') return `beat:${cue.beat}`;
	if (typeof cue.word === 'number') return `word:${cue.word}`;
	if (typeof cue.ms === 'number') return `ms:${cue.ms}`;
	return '';
}

/** The cue a picker value names, or undefined for none. */
export function motionCueFromKey(key: string): MotionCue | undefined {
	const m = /^(beat|word|ms):(-?\d+(?:\.\d+)?)$/.exec(key);
	if (!m) return undefined;
	return { [m[1]]: Number(m[2]) } as MotionCue;
}

/**
 * The cues a shot can start on: every beat of the scene's grid up to a little past the end, and
 * every narration word, each labelled with its time.
 */
export function motionCueChoices(scene: MotionScene, limit = 256): { value: string; label: string; time: number }[] {
	const choices: { value: string; label: string; time: number }[] = [];
	const s = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
	const end = Math.max(compileMotionScene(scene).duration, ...(scene.narration?.words.map((w) => w.end ?? w.start) ?? [0])) + 2000;
	if (scene.beat && scene.beat.bpm > 0) {
		for (let beat = 0; choices.length < limit; beat++) {
			const time = motionBeatTime(scene.beat, beat);
			if (time > end) break;
			if (time < 0) continue;
			const at = motionBeatAt(scene.beat, time);
			choices.push({ value: `beat:${beat}`, label: `Beat ${beat} (bar ${at.bar}.${at.beatInBar}) · ${s(time)}`, time });
		}
	}
	scene.narration?.words.forEach((w, i) => {
		if (choices.length < limit * 2) choices.push({ value: `word:${i}`, label: `Word ${i} “${w.text}” · ${s(w.start)}`, time: w.start });
	});
	return choices;
}

/** When a shot's cue falls (ms), or undefined. */
export function motionShotCueTime(scene: MotionScene, cue: MotionCue | undefined): number | undefined {
	return cue ? motionCueTime(scene, cue) : undefined;
}

/** Narration as text, a word a line: `<start ms> <word>`. */
export function formatMotionNarration(narration: MotionNarration | undefined): string {
	return (narration?.words ?? []).map((w) => `${w.start} ${w.text}`).join('\n');
}

/** Reads narration typed a word a line (`<start ms> <word>`); empty text clears it. */
export function parseMotionNarration(text: string): { narration: MotionNarration | null } | { error: string } {
	const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
	if (!lines.length) return { narration: null };
	const words: MotionNarration['words'] = [];
	for (const [i, line] of lines.entries()) {
		const m = /^(\d+(?:\.\d+)?)\s+(.+)$/.exec(line);
		if (!m) return { error: `Line ${i + 1} ("${line}") should be a start time in ms and a word, e.g. "1200 hello".` };
		const start = Number(m[1]);
		if (words.length && start < words[words.length - 1].start) return { error: `Line ${i + 1} starts before the word above it; keep the words in time order.` };
		words.push({ text: m[2], start });
	}
	return { narration: { words } };
}
