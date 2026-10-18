import type { VectorDocument } from '../vector/types.js';
import { checkMotionScene } from './check.js';
import { motionIssueKey, motionIssueLine, namedWithSuggestion, type MotionIssue } from './issues.js';
import { commandShapeProblems, motionSceneShapeProblems, shotShapeProblems } from './parse.js';
import type { MotionCommand, MotionControl, MotionPreset, MotionScene, MotionShot } from './types.js';

/**
 * Edits as data: each is a pure function of the scene, all or nothing. An edit that leaves the
 * scene malformed, or adds an error the scene did not have (an unknown id, say), changes
 * nothing and says why; existing errors do not block unrelated edits, so a broken scene can be
 * fixed a step at a time.
 */
export type MotionEdit =
	| { op: 'set_settings'; name?: string; description?: string | null; loop?: MotionScene['loop']; fps?: number; steps?: number | null; beat?: MotionScene['beat'] | null; narration?: MotionScene['narration'] | null; target?: [number, number] | null }
	| { op: 'insert_shots'; shots: MotionShot[]; at?: number }
	| { op: 'update_shot'; shot: string; set?: Partial<MotionShot>; remove?: ('label' | 'camera' | 'hold' | 'speed' | 'at')[] }
	| { op: 'delete_shots'; shots: string[] }
	| { op: 'move_shot'; shot: string; to: number }
	| { op: 'add_commands'; shot: string; commands: MotionCommand[]; at?: number }
	| { op: 'update_command'; shot: string; command: number; set?: Record<string, unknown>; remove?: string[] }
	| { op: 'delete_commands'; shot: string; commands: number[] }
	| { op: 'set_artwork'; artwork: VectorDocument }
	| { op: 'set_controls'; controls: MotionControl[]; presets?: MotionPreset[] }
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
	'set_artwork',
	'set_controls',
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

/** An empty scene over `artwork`. */
export function createMotionScene(artwork: VectorDocument, init: Partial<Omit<MotionScene, 'artwork' | 'version'>> = {}): MotionScene {
	return { version: 1, name: init.name ?? 'animation', ...init, artwork, shots: init.shots ?? [] };
}
