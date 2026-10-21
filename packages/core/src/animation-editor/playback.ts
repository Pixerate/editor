// Agent playback in the animation editor (see `tools/playback.ts`): the cursor clicks the shot a
// call works on in the timeline, then visits the stage elements its commands animate. Plans only
// name shots (`{ kind: 'shot', id }`) and elements (`{ kind: 'element', id }`); the editor finds them.
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { PlaybackStep } from '../tools/playback.js';

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Element ids a call's commands animate (`targets`, also inside `commands`, `run`, `shots[].run` and batch `ops`). */
function elementsOf(args: Record<string, any>): string[] {
	const out: string[] = [];
	const add = (v: unknown) => str(v) && !out.includes(v) && out.push(v);
	const fromCommand = (c: unknown) => {
		if (!c || typeof c !== 'object') return;
		const t = (c as { targets?: unknown; target?: unknown }).targets ?? (c as { target?: unknown }).target;
		if (Array.isArray(t)) t.forEach(add);
		else add(t);
	};
	fromCommand(args);
	fromCommand(args.command);
	if (Array.isArray(args.commands)) args.commands.forEach(fromCommand);
	const fromShot = (s: unknown) => {
		if (!s || typeof s !== 'object') return;
		for (const key of ['run', 'commands'] as const) {
			const list = (s as Record<string, unknown>)[key];
			if (Array.isArray(list)) list.forEach(fromCommand);
		}
	};
	if (Array.isArray(args.run)) args.run.forEach(fromCommand);
	if (Array.isArray(args.shots)) args.shots.forEach(fromShot);
	if (Array.isArray(args.ops)) {
		for (const op of args.ops) {
			fromShot(op);
			if (Array.isArray(op?.shots)) op.shots.forEach(fromShot);
		}
	}
	return out.slice(0, 4);
}

/** The cursor steps for one animation tool call (by bare name), or null to fall back to the ids it names. */
export function planAnimationToolPlayback(tool: string, args: Record<string, any>): PlaybackStep[] | null {
	const steps: PlaybackStep[] = [];
	const shot = str(args.shot) ? args.shot : str(args.id) && /shot/.test(tool) ? args.id : null;
	if (shot) steps.push({ type: 'target', ref: { kind: 'shot', id: shot } }, { type: 'press' }, { type: 'release' });
	for (const id of elementsOf(args)) steps.push({ type: 'target', ref: { kind: 'element', id } });
	return steps.length ? steps : null;
}

/**
 * Gives an animation tool provider agent playback: each tool plans its steps with
 * `planAnimationToolPlayback` and every call plays on `surface` (default `animation`, where
 * `AnimationEditor` attaches itself).
 */
export function withAnimationPlayback(provider: AgentToolProvider, surface = 'animation'): AgentToolProvider {
	const plan = (tool: AgentTool): AgentTool =>
		tool.plan || tool.playback !== undefined ? tool : { ...tool, plan: (args) => planAnimationToolPlayback(tool.name, args) };
	const tools = provider.tools;
	return {
		...provider,
		playbackSurface: provider.playbackSurface ?? surface,
		tools: typeof tools === 'function' ? () => tools().map(plan) : tools.map(plan)
	};
}
