// Scripted agent turns, after Ursula's "▶ Demo agent" (dev/whiteboard.tsx): a list of steps, each a
// note to the user and / or one tool call, played at reading speed with skip and stop. Calls go
// through a registry exactly as an MCP client's would, so agent playback acts them out, and later
// steps can read ids and positions from earlier results. For tours, demos and end-to-end tests.
import type { AgentPlayback } from './playback.js';
import { readingTime } from './playback.js';
import type { PresenceActorInfo } from './presence.js';
import type { McpToolResult, ToolSource } from './registry.js';

/** What earlier steps returned, for the arguments of later ones. */
export interface ToolScriptContext {
	/** Results kept with `as`, by name (a tool's `structuredContent`, or its JSON text). */
	results: Record<string, any>;
	/** The result of the step before. */
	last: any;
}

export interface ToolScriptStep {
	/** What the agent tells the user before it acts (the transcript and the cursor's bubble). */
	say?: string;
	/** Tool to call (an exposed registry name such as `sheet__set_range`). */
	tool?: string;
	/** The tool's arguments, or a function of earlier results that returns them. */
	args?: Record<string, unknown> | ((ctx: ToolScriptContext) => Record<string, unknown>);
	/** Keep the result under this name in `ctx.results`. */
	as?: string;
}

export interface ToolScript {
	id: string;
	/** The user's request, as they would type it. */
	prompt: string;
	steps: ToolScriptStep[];
}

export type ToolScriptEvent =
	| { type: 'say'; step: number; text: string }
	| { type: 'call'; step: number; tool: string; args: Record<string, unknown> }
	| { type: 'result'; step: number; tool: string; result: McpToolResult }
	| { type: 'error'; step: number; message: string }
	| { type: 'done'; ok: boolean; stopped: boolean };

/** Speed and stop for a run in progress (`speed: Infinity` finishes without pauses). */
export interface ToolScriptControl {
	speed: number;
	stopped: boolean;
}

export interface RunToolScriptOptions {
	/** Shows each note on the agent's cursor (`playback.say`) and stops its performance on stop. */
	playback?: AgentPlayback | null;
	/** The actor the calls are made as (its own cursor and queue). */
	actor?: PresenceActorInfo;
	onEvent?: (event: ToolScriptEvent) => void;
	control?: ToolScriptControl;
	/** Waits `ms` (already scaled by the speed); real timers by default. */
	wait?: (ms: number) => Promise<void>;
}

/** A tool result as a plain value: its `structuredContent`, else its first text block (parsed when JSON). */
export function toolResultValue(result: McpToolResult): any {
	if (result.structuredContent) return result.structuredContent;
	const text = result.content.find((b) => b.type === 'text') as { text?: string } | undefined;
	if (!text?.text) return undefined;
	try {
		return JSON.parse(text.text);
	} catch {
		return text.text;
	}
}

/** The error message of a failed tool result. */
export function toolResultError(result: McpToolResult): string {
	const text = result.content.find((b) => b.type === 'text') as { text?: string } | undefined;
	return text?.text ?? 'The tool failed.';
}

const realWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Plays `script` against `source` (a `ToolRegistry` or a view of one): each step's note, then its
 * tool call. Stops at the first failure (a tool error or arguments that cannot be built), like an
 * agent that has to rethink, and resolves with the results kept so far.
 */
export async function runToolScript(source: ToolSource, script: ToolScript, options: RunToolScriptOptions = {}): Promise<{ ok: boolean; ctx: ToolScriptContext }> {
	const control = options.control ?? { speed: 1, stopped: false };
	const wait = options.wait ?? realWait;
	const pause = (ms: number) => (Number.isFinite(control.speed) ? wait(ms / Math.max(0.1, control.speed)) : Promise.resolve());
	const emit = options.onEvent ?? (() => {});
	const ctx: ToolScriptContext = { results: {}, last: undefined };
	const finish = (ok: boolean) => {
		if (control.stopped) options.playback?.stop();
		emit({ type: 'done', ok, stopped: control.stopped });
		return { ok, ctx };
	};

	for (let i = 0; i < script.steps.length; i++) {
		if (control.stopped) return finish(false);
		const step = script.steps[i]!;
		if (step.say) {
			emit({ type: 'say', step: i, text: step.say });
			options.playback?.say(step.say, options.actor ? { actor: options.actor } : {});
			await pause(readingTime(step.say));
		}
		if (!step.tool) continue;
		if (control.stopped) return finish(false);
		let args: Record<string, unknown>;
		try {
			args = typeof step.args === 'function' ? step.args(ctx) : (step.args ?? {});
		} catch (error) {
			emit({ type: 'error', step: i, message: error instanceof Error ? error.message : String(error) });
			return finish(false);
		}
		emit({ type: 'call', step: i, tool: step.tool, args });
		const result = await source.callTool(step.tool, args, options.actor ? { actor: options.actor } : {});
		emit({ type: 'result', step: i, tool: step.tool, result });
		if (result.isError) {
			emit({ type: 'error', step: i, message: toolResultError(result) });
			return finish(false);
		}
		ctx.last = toolResultValue(result);
		if (step.as) ctx.results[step.as] = ctx.last;
		await pause(350);
	}
	return finish(true);
}
