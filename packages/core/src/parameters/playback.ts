// Agent playback on a parameters panel (see `tools/playback.ts`): `parameters.set` visits each
// control it changes and types the new value. Other parameter commands play from their `ids`.
// Plans only name controls (`{ kind: 'parameter', id }`); the panel finds them on screen.
import type { CommandSpec } from '../commands/registry.js';
import type { PlaybackStep } from '../tools/playback.js';

const shown = (v: unknown): string => {
	const text = typeof v === 'string' ? v : JSON.stringify(v);
	return text.length > 32 ? `${text.slice(0, 31)}…` : text;
};

/** The cursor steps for `parameters.set { values }`: each control (at most 6), clicked, its value typed. */
export function planParameterSetPlayback(values: unknown): PlaybackStep[] | null {
	if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
	const steps: PlaybackStep[] = [];
	for (const [id, value] of Object.entries(values).slice(0, 6)) {
		steps.push({ type: 'target', ref: { kind: 'parameter', id } }, { type: 'press' }, { type: 'release' }, { type: 'type', text: shown(value) });
	}
	return steps.length ? steps : null;
}

/**
 * Gives parameter commands agent playback on the `parameters` surface (where `ParametersPanel`
 * attaches): `<prefix>set` plans its controls; the others visit the `ids` they name. Mutates the
 * specs (their `params` may be getters, which a copy would freeze).
 */
export function withParameterPlayback(prefix: string, commands: CommandSpec[]): CommandSpec[] {
	for (const spec of commands) {
		if (!spec.id.startsWith(prefix)) continue;
		spec.playbackSurface ??= spec.scope ?? 'parameters';
		if (spec.id === `${prefix}set` && !spec.plan) spec.plan = (_ctx: unknown, params: { values?: unknown }) => planParameterSetPlayback(params?.values);
	}
	return commands;
}
