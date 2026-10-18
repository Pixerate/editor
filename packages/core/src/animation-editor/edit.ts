import type { VectorDocument } from '../vector/types.js';
import { checkMotionScene } from './check.js';
import { motionIssueKey, motionIssueLine, namedWithSuggestion, type MotionIssue } from './issues.js';
import { clipsShapeProblems, driversShapeProblems, commandShapeProblems, motionSceneShapeProblems, shotShapeProblems } from './parse.js';
import type { MotionClip, MotionDriver, MotionCommand, MotionControl, MotionPreset, MotionScene, MotionShot } from './types.js';

/**
 * Edits as data: each is a pure function of the scene, all or nothing. An edit that leaves the
 * scene malformed, or adds an error the scene did not have (an unknown id, say), changes
 * nothing and says why; existing errors do not block unrelated edits, so a broken scene can be
 * fixed a step at a time.
 */
export type MotionEdit =
	| { op: 'set_settings'; name?: string; description?: string | null; loop?: MotionScene['loop']; trigger?: MotionScene['trigger'] | null; fps?: number; steps?: number | null; beat?: MotionScene['beat'] | null; narration?: MotionScene['narration'] | null; target?: [number, number] | null }
	| { op: 'insert_shots'; shots: MotionShot[]; at?: number }
	| { op: 'update_shot'; shot: string; set?: Partial<MotionShot>; remove?: ('label' | 'camera' | 'hold' | 'speed' | 'at')[] }
	| { op: 'delete_shots'; shots: string[] }
	| { op: 'move_shot'; shot: string; to: number }
	| { op: 'add_commands'; shot: string; commands: MotionCommand[]; at?: number }
	| { op: 'update_command'; shot: string; command: number; set?: Record<string, unknown>; remove?: string[] }
	| { op: 'delete_commands'; shot: string; commands: number[] }
	| { op: 'move_command'; shot: string; command: number; to: number }
	| { op: 'set_artwork'; artwork: VectorDocument }
	| { op: 'set_controls'; controls: MotionControl[]; presets?: MotionPreset[] }
	| { op: 'set_clip'; name: string; clip: MotionClip | null }
	| { op: 'set_drivers'; drivers: MotionDriver[] }
	| { op: 'replace_scene'; scene: MotionScene };

export type MotionEditOp = MotionEdit['op'];

export const MOTION_EDIT_OPS: readonly MotionEditOp[] = [
	'set_settings',
	'insert_shots',
	'update_shot',
	'delete_shots',
	'move_shot',
	'add_commands',
	'update_command',
	'delete_commands',
	'move_command',
	'set_artwork',
	'set_controls',
	'set_clip',
	'set_drivers',
	'replace_scene'
];

export type MotionEditResult =
	| {
			ok: true;
			scene: MotionScene;
			/** Every issue the edited scene has. */
			issues: MotionIssue[];
			/** Edits that work but may surprise (a later command undoes this one, say). */
			hints: string[];
	  }
	| { ok: false; error: string };

class EditError extends Error {}
const fail = (message: string): never => {
	throw new EditError(message);
};

function shotIndex(scene: MotionScene, id: string): number {
	const i = scene.shots.findIndex((s) => s.id === id);
	if (i < 0) fail(`There is no shot ${namedWithSuggestion(id, scene.shots.map((s) => s.id))}; the shots are ${scene.shots.map((s) => `"${s.id}"`).join(', ') || 'none yet'}.`);
	return i;
}

function position(at: number | undefined, length: number, what: string): number {
	if (at === undefined) return length;
	if (!Number.isInteger(at) || at < 0 || at > length) fail(`${what} must be a whole number from 0 to ${length} (got ${at}).`);
	return at;
}

const replaceShot = (scene: MotionScene, index: number, shot: MotionShot): MotionScene => ({ ...scene, shots: scene.shots.map((s, i) => (i === index ? shot : s)) });

/** A free shot id: `base`, then `base-2`, `base-3`… */
export function freshShotId(scene: MotionScene, base = 'shot'): string {
	const used = new Set(scene.shots.map((s) => s.id));
	if (!used.has(base)) return base;
	let n = 2;
	while (used.has(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}

function applyOne(scene: MotionScene, edit: MotionEdit): MotionScene {
	switch (edit.op) {
		case 'set_settings': {
			const next: MotionScene = { ...scene };
			if (edit.name !== undefined) next.name = edit.name;
			if (edit.description === null) delete next.description;
			else if (edit.description !== undefined) next.description = edit.description;
			if (edit.loop !== undefined) next.loop = edit.loop;
			if (edit.trigger === null) delete next.trigger;
			else if (edit.trigger !== undefined) {
				if (!['click', 'hover', 'press', 'scroll'].includes(edit.trigger)) fail('"trigger" must be click, hover, press or scroll, or null to play on its own.');
				next.trigger = edit.trigger;
			}
			if (edit.fps !== undefined) next.fps = edit.fps;
			if (edit.steps === null) delete next.steps;
			else if (edit.steps !== undefined) {
				if (!(typeof edit.steps === 'number' && edit.steps > 0 && edit.steps <= 120)) fail('"steps" must be frames per second from above 0 to 120 (12 is "on twos" at 24 fps), or null for smooth.');
				next.steps = edit.steps;
			}
			for (const key of ['beat', 'narration'] as const) {
				if (edit[key] === null) delete next[key];
				else if (edit[key] !== undefined) (next as unknown as Record<string, unknown>)[key] = edit[key];
			}
			{
				const problems = motionSceneShapeProblems(next).filter((p) => /"beat"|"narration"/.test(p));
				if (problems.length) fail(problems.join(' '));
			}
			if (edit.target === null) delete next.target;
			else if (edit.target !== undefined) next.target = edit.target;
			return next;
		}
		case 'set_drivers': {
			const problems = driversShapeProblems(edit.drivers);
			if (problems.length) fail(problems.join(' '));
			const next: MotionScene = { ...scene, drivers: edit.drivers };
			if (!edit.drivers.length) delete next.drivers;
			return next;
		}
		case 'set_clip': {
			if (typeof edit.name !== 'string' || !edit.name) fail('Give the clip a "name".');
			const clips = { ...(scene.clips ?? {}) };
			if (edit.clip === null) {
				if (!clips[edit.name]) fail(`There is no clip ${namedWithSuggestion(edit.name, Object.keys(clips))} to delete.`);
				const playing = scene.shots.filter((s) => s.run.some((c) => c.type === 'play' && c.clip === edit.name)).map((s) => `"${s.id}"`);
				if (playing.length) fail(`Clip "${edit.name}" is played in shot${playing.length > 1 ? 's' : ''} ${playing.join(', ')}; remove those play commands first.`);
				delete clips[edit.name];
			} else {
				const problems = clipsShapeProblems({ [edit.name]: edit.clip });
				if (problems.length) fail(problems.join(' '));
				clips[edit.name] = edit.clip;
			}
			const next: MotionScene = { ...scene, clips };
			if (!Object.keys(clips).length) delete next.clips;
			return next;
		}
		case 'insert_shots': {
			if (!edit.shots.length) fail('Give at least one shot.');
			edit.shots.forEach((shot, i) => {
				const problems = shotShapeProblems(shot, `Shot ${i + 1}`);
				if (problems.length) fail(problems.join(' '));
			});
			const ids = new Set(scene.shots.map((s) => s.id));
			for (const shot of edit.shots) {
				if (ids.has(shot.id)) fail(`Shot id "${shot.id}" is already used; choose another (e.g. "${freshShotId(scene, shot.id)}").`);
				ids.add(shot.id);
			}
			const at = position(edit.at, scene.shots.length, '"at"');
			return { ...scene, shots: [...scene.shots.slice(0, at), ...edit.shots, ...scene.shots.slice(at)] };
		}
		case 'update_shot': {
			const i = shotIndex(scene, edit.shot);
			const shot: MotionShot = { ...scene.shots[i], ...(edit.set ?? {}) };
			for (const key of edit.remove ?? []) delete shot[key];
			if (shot.id !== edit.shot && scene.shots.some((s) => s.id === shot.id)) fail(`Shot id "${shot.id}" is already used; choose another.`);
			const problems = shotShapeProblems(shot, `Shot "${edit.shot}"`);
			if (problems.length) fail(problems.join(' '));
			return replaceShot(scene, i, shot);
		}
		case 'delete_shots': {
			if (!edit.shots.length) fail('Give at least one shot id.');
			edit.shots.forEach((id) => shotIndex(scene, id));
			const drop = new Set(edit.shots);
			return { ...scene, shots: scene.shots.filter((s) => !drop.has(s.id)) };
		}
		case 'move_shot': {
			const i = shotIndex(scene, edit.shot);
			const to = position(edit.to, scene.shots.length - 1, '"to"');
			const shots = [...scene.shots];
			const [shot] = shots.splice(i, 1);
			shots.splice(to, 0, shot);
			return { ...scene, shots };
		}
		case 'add_commands': {
			const i = shotIndex(scene, edit.shot);
			if (!edit.commands.length) fail('Give at least one command.');
			edit.commands.forEach((command, k) => {
				const problems = commandShapeProblems(command, `Command ${k + 1}`);
				if (problems.length) fail(problems.join(' '));
			});
			const run = scene.shots[i].run;
			const at = position(edit.at, run.length, '"at"');
			return replaceShot(scene, i, { ...scene.shots[i], run: [...run.slice(0, at), ...edit.commands, ...run.slice(at)] });
		}
		case 'update_command': {
			const i = shotIndex(scene, edit.shot);
			const run = scene.shots[i].run;
			if (!Number.isInteger(edit.command) || edit.command < 0 || edit.command >= run.length)
				fail(`Shot "${edit.shot}" has ${run.length} command${run.length === 1 ? '' : 's'}; "command" must be an index from 0 to ${run.length - 1} (got ${edit.command}).`);
			const command = { ...run[edit.command], ...(edit.set ?? {}) } as Record<string, unknown>;
			for (const key of edit.remove ?? []) {
				if (key === 'type') fail('"type" cannot be removed; replace the command instead.');
				delete command[key];
			}
			const problems = commandShapeProblems(command, `Command ${edit.command}`);
			if (problems.length) fail(problems.join(' '));
			return replaceShot(scene, i, { ...scene.shots[i], run: run.map((c, k) => (k === edit.command ? (command as unknown as MotionCommand) : c)) });
		}
		case 'delete_commands': {
			const i = shotIndex(scene, edit.shot);
			const run = scene.shots[i].run;
			if (!edit.commands.length) fail('Give at least one command index.');
			for (const k of edit.commands)
				if (!Number.isInteger(k) || k < 0 || k >= run.length) fail(`Shot "${edit.shot}" has no command ${k}; indexes run from 0 to ${run.length - 1}.`);
			const drop = new Set(edit.commands);
			return replaceShot(scene, i, { ...scene.shots[i], run: run.filter((_, k) => !drop.has(k)) });
		}
		case 'move_command': {
			const i = shotIndex(scene, edit.shot);
			const run = [...scene.shots[i].run];
			if (!Number.isInteger(edit.command) || edit.command < 0 || edit.command >= run.length)
				fail(`Shot "${edit.shot}" has ${run.length} command${run.length === 1 ? '' : 's'}; "command" must be an index from 0 to ${run.length - 1} (got ${edit.command}).`);
			const to = position(edit.to, run.length - 1, '"to"');
			const [moved] = run.splice(edit.command, 1);
			run.splice(to, 0, moved);
			return replaceShot(scene, i, { ...scene.shots[i], run });
		}
		case 'set_artwork':
			return { ...scene, artwork: edit.artwork };
		case 'set_controls': {
			const next: MotionScene = { ...scene, controls: edit.controls };
			if (!edit.controls.length) delete next.controls;
			if (edit.presets !== undefined) {
				if (edit.presets.length) next.presets = edit.presets;
				else delete next.presets;
			}
			const names = new Set(edit.controls.map((c) => c.name));
			for (const preset of next.presets ?? [])
				for (const key of Object.keys(preset.values))
					if (!names.has(key)) fail(`Preset "${preset.name}" sets ${namedWithSuggestion(key, names)}, which is not a control.`);
			return next;
		}
		case 'replace_scene':
			return edit.scene;
	}
}

function errorKeys(issues: readonly MotionIssue[]): Set<string> {
	return new Set(issues.filter((i) => i.severity === 'error').map(motionIssueKey));
}

/** Hints: commands whose change a later command takes over. */
function editHints(before: MotionIssue[], after: MotionIssue[]): string[] {
	const old = new Set(before.map(motionIssueKey));
	return after.filter((i) => i.code === 'overlap' && !old.has(motionIssueKey(i))).map(motionIssueLine);
}

/** Applies edits in order, as one change. Fails without changing anything when one fails. */
export function applyMotionEdits(scene: MotionScene, edits: MotionEdit | readonly MotionEdit[]): MotionEditResult {
	const list = Array.isArray(edits) ? edits : [edits as MotionEdit];
	const before = checkMotionScene(scene);
	let next = scene;
	for (let i = 0; i < list.length; i++) {
		const edit = list[i];
		const prefix = list.length > 1 ? `op ${i + 1} (${edit?.op}): ` : '';
		if (!edit || !(MOTION_EDIT_OPS as readonly string[]).includes(edit.op))
			return { ok: false, error: `${prefix}Unknown op ${namedWithSuggestion(String(edit?.op), MOTION_EDIT_OPS)}. Nothing was changed.` };
		try {
			next = applyOne(next, edit);
		} catch (error) {
			if (error instanceof EditError) return { ok: false, error: `${prefix}${error.message} Nothing was changed.` };
			throw error;
		}
		const problems = motionSceneShapeProblems(next);
		if (problems.length) return { ok: false, error: `${prefix}Nothing was changed: ${problems.join(' ')}` };
	}
	const issues = checkMotionScene(next);
	const had = errorKeys(before);
	const added = issues.filter((i) => i.severity === 'error' && !had.has(motionIssueKey(i)));
	if (added.length) return { ok: false, error: `Nothing was changed: ${added.map(motionIssueLine).join(' ')}` };
	return { ok: true, scene: next, issues, hints: editHints(before, issues) };
}

/** What one edit made, for later edits in a batch to refer to (`"$0.indexes[0]"`). */
export interface MotionEditOutcome {
	op: string;
	/** The shot it changed or added to. */
	shot?: string;
	/** Shots it added. */
	shots?: string[];
	/** Indexes of the commands it added (or where it moved one). */
	indexes?: number[];
	/** The clip it set. */
	clip?: string;
}

const REF = /^\$(\d+|last)((?:\.[A-Za-z_]\w*|\[\d+\])+)$/;

/**
 * Resolves references to earlier edits' outcomes in a batch: a string `"$N.path"` (`$last` for the
 * one before) is replaced by that value, e.g. `"$0.indexes[0]"` for the index of the first command
 * edit 0 added; `"$$..."` is a literal `$`. Returns the resolved edits with what each made, or why
 * a reference does not resolve. Nothing is applied.
 */
export function resolveMotionEditRefs(scene: MotionScene, edits: readonly MotionEdit[]): { ok: true; edits: MotionEdit[]; outcomes: MotionEditOutcome[] } | { ok: false; error: string } {
	const outcomes: MotionEditOutcome[] = [];
	const resolved: MotionEdit[] = [];
	let next = scene;
	for (let i = 0; i < edits.length; i++) {
		const where = `op ${i + 1} (${edits[i]?.op})`;
		let problem: string | null = null;
		const walk = (v: unknown): unknown => {
			if (typeof v === 'string') {
				if (v.startsWith('$$')) return v.slice(1);
				const m = REF.exec(v);
				if (!m) return v;
				const n = m[1] === 'last' ? i - 1 : Number(m[1]);
				if (!(n >= 0 && n < i)) {
					problem = `${where}: "${v}" refers to op ${n + 1}, but only ops before this one (1 to ${i}) can be referred to.`;
					return v;
				}
				let value: unknown = outcomes[n];
				for (const part of m[2].match(/\.[A-Za-z_]\w*|\[\d+\]/g) ?? []) value = value == null ? undefined : (value as Record<string, unknown>)[part.startsWith('.') ? part.slice(1) : part.slice(1, -1)];
				if (value === undefined) problem = `${where}: "${v}" has no value; op ${n + 1} made ${JSON.stringify(outcomes[n])}.`;
				return value;
			}
			if (Array.isArray(v)) return v.map(walk);
			if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
			return v;
		};
		const edit = walk(edits[i]) as MotionEdit;
		if (problem) return { ok: false, error: `${problem} Nothing was changed.` };
		const before = next;
		try {
			next = applyOne(next, edit);
		} catch (error) {
			if (error instanceof EditError) return { ok: false, error: `${where}: ${error.message} Nothing was changed.` };
			throw error;
		}
		resolved.push(edit);
		const out: MotionEditOutcome = { op: edit.op };
		if (edit.op === 'insert_shots') out.shots = edit.shots.map((s) => s.id);
		if ('shot' in edit && typeof edit.shot === 'string') out.shot = edit.op === 'update_shot' && edit.set?.id ? edit.set.id : edit.shot;
		if (edit.op === 'add_commands') {
			const at = edit.at ?? before.shots.find((s) => s.id === edit.shot)?.run.length ?? 0;
			out.indexes = edit.commands.map((_, k) => at + k);
		}
		if (edit.op === 'move_command') out.indexes = [edit.to];
		if (edit.op === 'set_clip') out.clip = edit.name;
		outcomes.push(out);
	}
	return { ok: true, edits: resolved, outcomes };
}

/** An empty scene over `artwork`. */
export function createMotionScene(artwork: VectorDocument, init: Partial<Omit<MotionScene, 'artwork' | 'version'>> = {}): MotionScene {
	return { version: 1, name: init.name ?? 'animation', ...init, artwork, shots: init.shots ?? [] };
}
