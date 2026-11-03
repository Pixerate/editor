import type { ToolMiddleware, ToolMiddlewareCall } from './registry.js';

/** What the origin middleware needs of a history (`HistoryManager` satisfies it). */
export interface OriginHistoryTarget {
	withOrigin<T>(origin: string, fn: () => T): T;
}

export interface OriginMiddlewareOptions {
	/**
	 * The histories a call's changes land in: one, several, or a function of the call (e.g. by
	 * `call.provider.id`) returning them or nothing to leave the call alone.
	 */
	histories:
		| OriginHistoryTarget
		| readonly OriginHistoryTarget[]
		| ((call: ToolMiddlewareCall) => OriginHistoryTarget | readonly OriginHistoryTarget[] | undefined);
	/** Origin for calls that name no actor (default `agent:anonymous`). */
	fallbackOrigin?: string;
}

/**
 * A `ToolRegistry` middleware that records the changes a tool call makes as the calling agent's
 * (`agent:<actor.id>`), so history steps, change feeds and proposals can tell them from the user's.
 * Read-only tools pass straight through. Add it after agent playback (`registry.use` order), so
 * it wraps only the handler and not the time a call waits in an actor's queue: while a handler
 * runs, other changes recorded on the same history are stamped with the agent's origin too.
 */
export function createOriginMiddleware(options: OriginMiddlewareOptions): ToolMiddleware {
	const fallback = options.fallbackOrigin ?? 'agent:anonymous';
	return (call, next) => {
		if (call.tool.annotations?.readOnlyHint === true) return next();
		const found = typeof options.histories === 'function' ? options.histories(call) : options.histories;
		const targets: readonly OriginHistoryTarget[] = !found ? [] : Array.isArray(found) ? found : [found as OriginHistoryTarget];
		if (!targets.length) return next();
		const origin = call.context.actor?.id ? `agent:${call.context.actor.id}` : fallback;
		const run = targets.reduceRight<() => Promise<unknown>>((inner, target) => () => target.withOrigin(origin, inner), next);
		return run();
	};
}
