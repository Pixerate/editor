/**
 * House style for animations (#779): the `animation-editor.json` profile (the easings allowed,
 * a range for move durations, the least hold at the end of a shot, a length limit, the frame
 * rates allowed, and the colours style commands may use), its checks, and
 * `check_animation_style` / `fix_animation_style`.
 *
 * Findings target a command (`{ shot, command, set }`), a shot (`{ shot, set }`) or the scene
 * (`{ scene: true, set? }`), with the fields to set when the fix is certain.
 */
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { StyleCheck, StyleDomain, StyleFinding, StyleResolver } from '../tools/style.js';
import type { StyleSurface, StyleSurfaceColor } from '../tools/style-surface.js';
import { brandPalette } from '../tools/brand.js';
import type { AnimationEditorController, AnimationEditorState } from './controller.js';
import type { MotionEdit } from './edit.js';

type Finding = Omit<StyleFinding, 'check' | 'layer'>;

/** The `animation-editor.json` profile, after `$token` references are resolved. */
export interface AnimationStyleProfile {
	/** Easing presets allowed (the first is the house default), e.g. ["ease-out", "ease-in-out"]. */
	easings?: string[];
	/** Range for a command's duration, in ms. */
	durations?: { min?: number; max?: number };
	/** Least hold at the end of each shot, in ms, so the viewer can read it. */
	minHold?: number;
	/** Longest animation, in ms. */
	maxLength?: number;
	/** Frame rates allowed (the first is the house default). */
	fps?: number[];
	/** Colours style commands may use (for palette-only). Default: the brand's. */
	palette?: string[];
}

/** A finding's target, with the fields to set when the fix is certain. */
export type AnimationStyleTarget =
	| { shot: string; command: number; set?: Record<string, unknown> }
	| { shot: string; set?: Record<string, unknown> }
	| { scene: true; set?: Record<string, unknown> };

const profileOf = (p: Readonly<Record<string, unknown>>) => p as AnimationStyleProfile;
const shotName = (s: { id: string; label?: string }) => (s.label ? `Shot "${s.label}"` : `Shot ${s.id}`);

const easings: StyleCheck<AnimationEditorState> = {
	id: 'easings',
	description: 'Commands and camera moves use house easings ("easings": preset names; the first is the house default). Custom curves (bezier, spring) count as off-house.',
	run(state, profile) {
		const allowed = profileOf(profile).easings;
		if (!allowed?.length) throw new Error('the profile has no "easings".');
		const out: Finding[] = [];
		const name = (e: unknown) => (typeof e === 'string' ? e : e && typeof e === 'object' ? `a custom ${(e as { type?: string }).type ?? 'curve'}` : undefined);
		for (const shot of state.scene.shots) {
			const camEase = shot.camera?.ease;
			if (camEase !== undefined && !(typeof camEase === 'string' && allowed.includes(camEase))) {
				out.push({ severity: 'info' as const, message: `${shotName(shot)}'s camera eases with ${name(camEase)}; the house easings are ${allowed.join(', ')}.`, target: { shot: shot.id, set: { camera: { ...shot.camera, ease: allowed[0] } } } satisfies AnimationStyleTarget });
			}
			shot.run.forEach((cmd, i) => {
				const ease = (cmd as { ease?: unknown }).ease;
				if (ease === undefined || (typeof ease === 'string' && allowed.includes(ease))) return;
				out.push({ severity: 'info' as const, message: `${shotName(shot)}, command ${i + 1} (${cmd.type}) eases with ${name(ease)}; use ${allowed[0]}.`, target: { shot: shot.id, command: i, set: { ease: allowed[0] } } satisfies AnimationStyleTarget });
			});
		}
		return out;
	}
};

const durations: StyleCheck<AnimationEditorState> = {
	id: 'durations',
	description: 'Each command takes a house duration ("durations": { min, max } in ms): quick enough to keep pace, slow enough to follow.',
	run(state, profile) {
		const r = profileOf(profile).durations;
		if (!r || (r.min === undefined && r.max === undefined)) throw new Error('the profile has no "durations" range.');
		const out: Finding[] = [];
		for (const shot of state.scene.shots) {
			shot.run.forEach((cmd, i) => {
				const ms = (cmd as { duration?: unknown }).duration;
				if (typeof ms !== 'number') return;
				const want = r.min !== undefined && ms < r.min ? r.min : r.max !== undefined && ms > r.max ? r.max : undefined;
				if (want === undefined) return;
				out.push({ severity: 'info' as const, message: `${shotName(shot)}, command ${i + 1} (${cmd.type}) takes ${ms} ms; the house range is ${r.min ?? '…'}–${r.max ?? '…'} ms. Use ${want}.`, target: { shot: shot.id, command: i, set: { duration: want } } satisfies AnimationStyleTarget });
			});
		}
		return out;
	}
};

const holds: StyleCheck<AnimationEditorState> = {
	id: 'holds',
	description: 'Each shot holds for at least "minHold" ms at its end, so the viewer can read it before the next.',
	run(state, profile) {
		const min = profileOf(profile).minHold;
		if (min === undefined) throw new Error('the profile has no "minHold".');
		return state.scene.shots
			.filter((s) => (s.hold ?? 0) < min)
			.map((s) => ({ severity: 'info' as const, message: `${shotName(s)} holds ${s.hold ?? 0} ms; the house style holds at least ${min} ms.`, target: { shot: s.id, set: { hold: min } } satisfies AnimationStyleTarget }));
	}
};

const maxLength: StyleCheck<AnimationEditorState> = {
	id: 'max-length',
	description: 'The animation runs no longer than "maxLength" ms (fit_animation shortens it evenly).',
	run(state, profile) {
		const max = profileOf(profile).maxLength;
		if (!max) throw new Error('the profile has no "maxLength".');
		if (state.duration <= max) return [];
		return [{ severity: 'warning' as const, message: `The animation runs ${Math.round(state.duration)} ms; the house limit is ${max} ms. Shorten it with fit_animation or cut shots.`, target: { scene: true } satisfies AnimationStyleTarget }];
	}
};

const fps: StyleCheck<AnimationEditorState> = {
	id: 'fps',
	description: 'The scene plays at a house frame rate ("fps"; the first is the house default).',
	run(state, profile) {
		const allowed = profileOf(profile).fps;
		if (!allowed?.length) throw new Error('the profile has no "fps".');
		const have = state.scene.fps;
		if (have === undefined || allowed.includes(have)) return [];
		return [{ severity: 'info' as const, message: `The scene plays at ${have} fps; the house rates are ${allowed.join(', ')}.`, target: { scene: true, set: { fps: allowed[0] } } satisfies AnimationStyleTarget }];
	}
};

/** The colours style commands paint with, for the shared checks. */
export function animationStyleSurface(state: AnimationEditorState): StyleSurface {
	const colors: StyleSurfaceColor[] = [];
	for (const shot of state.scene.shots) {
		shot.run.forEach((cmd, i) => {
			if (cmd.type !== 'style') return;
			const target = { shot: shot.id, command: i } satisfies AnimationStyleTarget;
			if (cmd.fill) colors.push({ color: cmd.fill, label: `${shotName(shot)}, command ${i + 1} fill`, target, use: 'fill' });
			if (cmd.stroke) colors.push({ color: cmd.stroke, label: `${shotName(shot)}, command ${i + 1} stroke`, target, use: 'stroke' });
		});
	}
	return { colors };
}

/** The animation house-style domain: register it with `createStyleResolver({ domains })`. */
export const animationStyleDomain: StyleDomain<AnimationEditorState> = {
	id: 'animation-editor',
	title: 'Animations',
	description: 'How motion feels: the easings allowed, a range for durations, the least hold per shot, a length limit, the frame rates allowed, and the colours style commands may use.',
	profileSchema: {
		type: 'object',
		properties: {
			easings: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, description: 'Easing presets allowed; the first is the house default, e.g. ["ease-out", "ease-in-out"].' },
			durations: {
				type: 'object',
				properties: { min: { type: 'number', minimum: 0, description: 'Shortest command, ms.' }, max: { type: 'number', minimum: 0, description: 'Longest command, ms.' } },
				additionalProperties: false,
				description: 'Range for a command\'s duration, in ms.'
			},
			minHold: { type: 'number', minimum: 0, description: 'Least hold at the end of each shot, ms.' },
			maxLength: { type: 'number', exclusiveMinimum: 0, description: 'Longest animation, ms.' },
			fps: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 240 }, minItems: 1, description: 'Frame rates allowed; the first is the house default.' },
			palette: { type: 'array', items: { type: 'string', minLength: 1, description: 'A CSS colour, or a { "$token": ... } reference.' }, description: 'Colours style commands may use (for palette-only). Default: the brand palette and roles.' }
		},
		additionalProperties: false
	},
	checks: [easings, durations, holds, maxLength, fps],
	surface: animationStyleSurface,
	themeFromBrand: (brand) => {
		const palette = brandPalette(brand);
		return palette.length ? { palette } : {};
	},
	example: {
		easings: ['ease-out', 'ease-in-out'],
		durations: { min: 200, max: 1200 },
		minHold: 600,
		maxLength: 15000,
		fps: [30, 60],
		checks: ['easings', 'durations', 'holds', 'max-length', 'fps', 'palette-only']
	}
};

export interface AnimationStyleToolProviderOptions {
	/** Provider id (unique per registry). Default `animation-style`. */
	id?: string;
	/** Tool-name prefix; defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Where the tools work: skills scoped elsewhere do not apply. Set by the host. */
	scope?: string;
}

/**
 * `check_animation_style` and, while the scene is editable, `fix_animation_style` (applies the
 * house easings, durations, holds and frame rate as one undo step).
 */
export function createAnimationStyleToolProvider(controller: AnimationEditorController, styles: StyleResolver, options: AnimationStyleToolProviderOptions = {}): AgentToolProvider {
	if (!styles.domains.some((d) => d.id === 'animation-editor')) throw new Error('The style resolver has no "animation-editor" domain; add animationStyleDomain to its domains.');
	const scope = options.scope !== undefined ? { scope: options.scope } : {};
	const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
	const run = () => styles.check('animation-editor', controller.getState(), scope);
	const editFor = (t: AnimationStyleTarget | undefined): MotionEdit | undefined => {
		if (!t?.set) return undefined;
		if ('command' in t) return { op: 'update_command', shot: t.shot, command: t.command, set: t.set };
		if ('shot' in t) return { op: 'update_shot', shot: t.shot, set: t.set };
		return { op: 'set_settings', ...(t.set as { fps?: number }) };
	};

	const check: AgentTool = {
		name: 'check_animation_style',
		title: 'Check animation house style',
		description:
			'Checks the animation against the house style (see get_style with domain "animation-editor"): easings, durations, holds, max-length, fps, and the brand\'s palette-only on style commands. Returns findings with a severity, a sentence saying how to fix it, a target ({ shot, command }, { shot } or { scene: true }, with `set`: the fields to set when certain) and the layer that asked; the checks that ran and those skipped. fix_animation_style applies the certain fixes at once.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Check animation house style', ...READ },
		handler: async () => {
			const { style, ...report } = await run();
			return {
				...report,
				ok: report.findings.length === 0,
				fixable: report.findings.filter((f) => editFor(f.target as AnimationStyleTarget)).length,
				...(style.skills.length ? {} : { note: 'No house style applies to animations.' }),
				...(style.issues.length ? { issues: style.issues } : {})
			};
		}
	};

	const fix: AgentTool = {
		name: 'fix_animation_style',
		title: 'Fix animation house style',
		description:
			'Applies every certain house-style fix as one undo step: house easings, durations clamped into the house range, the least hold per shot, and the house frame rate. Returns how many it fixed and the findings left (length and colours: fix those with the animation tools). Run check_animation_style after.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Fix animation house style', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: async () => {
			if (controller.getState().readOnly) throw new Error('The animation is read-only, so its house style cannot be fixed.');
			const { findings } = await run();
			const edits: MotionEdit[] = [];
			const left: StyleFinding[] = [];
			for (const f of findings) {
				const e = editFor(f.target as AnimationStyleTarget);
				if (e) edits.push(e);
				else left.push(f);
			}
			if (edits.length) {
				const result = controller.apply(edits, 'Apply house style');
				if (!result.ok) throw new Error(`The house style could not be applied: ${(result as { message?: string }).message ?? 'the edits were refused'}`);
			}
			return { fixed: edits.length, left };
		}
	};

	return {
		id: options.id ?? 'animation-style',
		namespace: options.namespace,
		title: 'Animation house style',
		description: 'Check an animation against the house style and apply its certain fixes.',
		skill: 'pixerate-animation-editor',
		tools: () => (controller.getState().readOnly ? [check] : [check, fix])
	};
}
