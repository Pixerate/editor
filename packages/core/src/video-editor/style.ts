/**
 * House style for video (#779): the `video-editor.json` profile (frame aspect ratios, frame
 * rates, a length limit, title sizes, the transitions allowed and their longest length, and the
 * colours and fonts titles may use), its checks, and `check_video_style` / `fix_video_style`.
 *
 * Findings target a clip (`{ clip, set? }`, with the fields to set when certain), a clip's
 * transition (`{ clip, transition }`) or the project (`{ project: true, set? }`).
 */
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { StyleCheck, StyleDomain, StyleFinding, StyleResolver } from '../tools/style.js';
import type { StyleSurface, StyleSurfaceColor } from '../tools/style-surface.js';
import { brandFonts, brandPalette } from '../tools/brand.js';
import { VIDEO_TRANSITION_TYPES, type VideoProject, type VideoTransition } from './types.js';
import { videoProjectDuration } from './timeline.js';
import type { VideoEdit } from './edit.js';
import type { VideoEditorController } from './controller.js';

type Finding = Omit<StyleFinding, 'check' | 'layer'>;

/** The `video-editor.json` profile, after `$token` references are resolved. */
export interface VideoStyleProfile {
	/** Frame aspect ratios allowed, as "width:height" ("16:9", "9:16", "1:1"). */
	aspectRatios?: string[];
	/** Frame rates allowed (the first is the house default). */
	fps?: number[];
	/** Longest edit, in ms. */
	maxLength?: number;
	/** Range for title font sizes, in px. */
	titleSizes?: { min?: number; max?: number };
	/** Transition types allowed (the first is the house default). */
	transitions?: string[];
	/** Longest transition, in ms. */
	maxTransition?: number;
	/** Colours titles may use (for palette-only). Default: the brand's. */
	palette?: string[];
	/** Fonts titles may use (for fonts-allowed). Default: the brand's. */
	fonts?: string[];
}

/** A finding's target, with the fields to set when the fix is certain. */
export type VideoStyleTarget = { clip: string; set?: Record<string, unknown> } | { clip: string; transition: VideoTransition } | { project: true; set?: Record<string, unknown> };

const profileOf = (p: Readonly<Record<string, unknown>>) => p as VideoStyleProfile;
const parseRatio = (r: string) => {
	const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(r.trim());
	return m ? Number(m[1]) / Number(m[2]) : NaN;
};
const clips = (project: VideoProject) => project.tracks.flatMap((t) => t.clips);

const aspectRatio: StyleCheck<VideoProject> = {
	id: 'aspect-ratio',
	description: 'The frame has a house aspect ratio ("aspectRatios", e.g. ["16:9", "9:16"]), within 1%.',
	run(project, profile) {
		const ratios = (profileOf(profile).aspectRatios ?? []).map((r) => ({ r, v: parseRatio(r) })).filter((x) => x.v > 0);
		if (!ratios.length) throw new Error('the profile has no "aspectRatios".');
		const have = project.width / project.height;
		if (ratios.some((x) => Math.abs(x.v - have) / x.v <= 0.01)) return [];
		return [{ severity: 'warning' as const, message: `The frame is ${project.width}×${project.height}; the house ratios are ${ratios.map((x) => x.r).join(', ')}. Reframe it (set_video_settings, then reposition clips).`, target: { project: true } satisfies VideoStyleTarget }];
	}
};

const fps: StyleCheck<VideoProject> = {
	id: 'fps',
	description: 'The project runs at a house frame rate ("fps"; the first is the house default).',
	run(project, profile) {
		const allowed = profileOf(profile).fps;
		if (!allowed?.length) throw new Error('the profile has no "fps".');
		if (allowed.includes(project.fps)) return [];
		return [{ severity: 'info' as const, message: `The project runs at ${project.fps} fps; the house rates are ${allowed.join(', ')}.`, target: { project: true, set: { fps: allowed[0] } } satisfies VideoStyleTarget }];
	}
};

const maxLength: StyleCheck<VideoProject> = {
	id: 'max-length',
	description: 'The edit runs no longer than "maxLength" ms.',
	run(project, profile) {
		const max = profileOf(profile).maxLength;
		if (!max) throw new Error('the profile has no "maxLength".');
		const length = videoProjectDuration(project);
		if (length <= max) return [];
		return [{ severity: 'warning' as const, message: `The edit runs ${(length / 1000).toFixed(1)} s; the house limit is ${(max / 1000).toFixed(1)} s. Cut or speed up clips.`, target: { project: true } satisfies VideoStyleTarget }];
	}
};

const titleSizes: StyleCheck<VideoProject> = {
	id: 'title-sizes',
	description: 'Titles use a house font size ("titleSizes": { min, max } in px), large enough to read on the target screen.',
	run(project, profile) {
		const r = profileOf(profile).titleSizes;
		if (!r || (r.min === undefined && r.max === undefined)) throw new Error('the profile has no "titleSizes" range.');
		const out: Finding[] = [];
		for (const c of clips(project)) {
			if (c.type !== 'text') continue;
			const size = c.fontSize ?? 64;
			const want = r.min !== undefined && size < r.min ? r.min : r.max !== undefined && size > r.max ? r.max : undefined;
			if (want === undefined) continue;
			out.push({ severity: 'warning' as const, message: `Title ${c.id} ("${c.text.slice(0, 30)}") is ${size} px; the house range is ${r.min ?? '…'}–${r.max ?? '…'} px. Use ${want}.`, target: { clip: c.id, set: { fontSize: want } } satisfies VideoStyleTarget });
		}
		return out;
	}
};

const transitions: StyleCheck<VideoProject> = {
	id: 'transitions',
	description: 'Transitions use a house type ("transitions"; the first is the house default) and last at most "maxTransition" ms.',
	run(project, profile) {
		const { transitions: allowed, maxTransition } = profileOf(profile);
		if (!allowed?.length && !maxTransition) throw new Error('the profile has no "transitions" or "maxTransition".');
		const out: Finding[] = [];
		for (const c of clips(project)) {
			const t = c.transition;
			if (!t) continue;
			const typeOk = !allowed?.length || allowed.includes(t.type);
			const lengthOk = !maxTransition || t.duration <= maxTransition;
			if (typeOk && lengthOk) continue;
			const fixed: VideoTransition = { ...t, ...(typeOk ? {} : { type: allowed![0] as VideoTransition['type'] }), ...(lengthOk ? {} : { duration: maxTransition! }) };
			out.push({
				severity: 'info' as const,
				message: `Clip ${c.id} has a ${t.duration} ms ${t.type} transition; ${typeOk ? '' : `the house transitions are ${allowed!.join(', ')}`}${!typeOk && !lengthOk ? ' and ' : ''}${lengthOk ? '' : `they last at most ${maxTransition} ms`}.`,
				target: { clip: c.id, transition: fixed } satisfies VideoStyleTarget
			});
		}
		return out;
	}
};

/** The colours and fonts titles use, for the shared checks. */
export function videoStyleSurface(project: VideoProject): StyleSurface {
	const colors: StyleSurfaceColor[] = [];
	const fonts: StyleSurface['fonts'] = [];
	for (const c of clips(project)) {
		if (c.type !== 'text') continue;
		const label = `Title ${c.id} ("${c.text.slice(0, 30)}")`;
		const target = { clip: c.id } satisfies VideoStyleTarget;
		colors.push({ color: c.color ?? '#ffffff', label, target, use: 'text', fontSize: c.fontSize ?? 64, bold: (c.fontWeight ?? 700) >= 600, ...(c.background ? { background: c.background } : {}) });
		if (c.background) colors.push({ color: c.background, label: `${label} box`, target, use: 'background' });
		if (c.fontFamily) fonts.push({ family: c.fontFamily, label, target });
	}
	return { colors, fonts };
}

/** The video house-style domain: register it with `createStyleResolver({ domains })`. */
export const videoStyleDomain: StyleDomain<VideoProject> = {
	id: 'video-editor',
	title: 'Video',
	description: 'How edits are delivered: frame aspect ratios and rates, a length limit, title sizes, the transitions allowed and their longest length, and the colours and fonts titles may use.',
	profileSchema: {
		type: 'object',
		properties: {
			aspectRatios: { type: 'array', items: { type: 'string', pattern: '^\\d+(\\.\\d+)?:\\d+(\\.\\d+)?$' }, minItems: 1, description: 'Frame aspect ratios allowed, as "width:height", e.g. ["16:9", "9:16"].' },
			fps: { type: 'array', items: { type: 'number', exclusiveMinimum: 0 }, minItems: 1, description: 'Frame rates allowed; the first is the house default.' },
			maxLength: { type: 'number', exclusiveMinimum: 0, description: 'Longest edit, ms.' },
			titleSizes: {
				type: 'object',
				properties: { min: { type: 'number', exclusiveMinimum: 0, description: 'Smallest title, px.' }, max: { type: 'number', exclusiveMinimum: 0, description: 'Largest title, px.' } },
				additionalProperties: false,
				description: 'Range for title font sizes, in px.'
			},
			transitions: { type: 'array', items: { type: 'string', enum: [...VIDEO_TRANSITION_TYPES] }, minItems: 1, description: 'Transition types allowed; the first is the house default.' },
			maxTransition: { type: 'number', exclusiveMinimum: 0, description: 'Longest transition, ms.' },
			palette: { type: 'array', items: { type: 'string', minLength: 1, description: 'A CSS colour, or a { "$token": ... } reference.' }, description: 'Colours titles may use (for palette-only). Default: the brand palette and roles.' },
			fonts: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Fonts titles may use (for fonts-allowed). Default: the brand fonts.' }
		},
		additionalProperties: false
	},
	checks: [aspectRatio, fps, maxLength, titleSizes, transitions],
	surface: videoStyleSurface,
	themeFromBrand: (brand) => {
		const palette = brandPalette(brand);
		const fonts = brandFonts(brand);
		return { ...(palette.length ? { palette } : {}), ...(fonts.length ? { fonts } : {}) };
	},
	example: {
		aspectRatios: ['16:9', '9:16'],
		fps: [30, 25],
		maxLength: 60000,
		titleSizes: { min: 48, max: 120 },
		transitions: ['crossfade', 'dip'],
		maxTransition: 500,
		checks: ['aspect-ratio', 'fps', 'max-length', 'title-sizes', 'transitions', 'palette-only', 'min-contrast', 'fonts-allowed']
	}
};

export interface VideoStyleToolProviderOptions {
	/** Provider id (unique per registry). Default `video-style`. */
	id?: string;
	/** Tool-name prefix; defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Where the tools work: skills scoped elsewhere do not apply. Set by the host. */
	scope?: string;
	/** The project cannot be changed: `fix_video_style` is hidden (a string is the reason). */
	readOnly?: boolean | string | (() => boolean | string);
}

/**
 * `check_video_style` and, while the project is editable, `fix_video_style` (applies the house
 * frame rate, title sizes and transitions as one undo step).
 */
export function createVideoStyleToolProvider(controller: VideoEditorController, styles: StyleResolver, options: VideoStyleToolProviderOptions = {}): AgentToolProvider {
	if (!styles.domains.some((d) => d.id === 'video-editor')) throw new Error('The style resolver has no "video-editor" domain; add videoStyleDomain to its domains.');
	const scope = options.scope !== undefined ? { scope: options.scope } : {};
	const readOnlyReason = (): string | null => {
		const r = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		if (!r) return null;
		return typeof r === 'string' ? r : 'This video is read-only.';
	};
	const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
	const run = () => styles.check('video-editor', controller.getProject(), scope);
	const editFor = (t: VideoStyleTarget | undefined): VideoEdit | undefined => {
		if (!t) return undefined;
		if ('transition' in t) return { op: 'set_transition', clip: t.clip, transition: t.transition };
		if (!t.set) return undefined;
		if ('clip' in t) return { op: 'update_clip', clip: t.clip, set: t.set };
		return { op: 'set_settings', ...(t.set as { fps?: number }) };
	};

	const check: AgentTool = {
		name: 'check_video_style',
		title: 'Check video house style',
		description:
			'Checks the edit against the house style (see get_style with domain "video-editor"): aspect-ratio, fps, max-length, title-sizes, transitions, and the brand\'s palette-only, min-contrast and fonts-allowed on titles. Returns findings with a severity, a sentence saying how to fix it, a target ({ clip, set? }, { clip, transition } or { project: true, set? }, with what to set when certain) and the layer that asked; the checks that ran and those skipped. fix_video_style applies the certain fixes at once.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Check video house style', ...READ },
		handler: async () => {
			const { style, ...report } = await run();
			return {
				...report,
				ok: report.findings.length === 0,
				fixable: report.findings.filter((f) => editFor(f.target as VideoStyleTarget)).length,
				...(style.skills.length ? {} : { note: 'No house style applies to video.' }),
				...(style.issues.length ? { issues: style.issues } : {})
			};
		}
	};

	const fix: AgentTool = {
		name: 'fix_video_style',
		title: 'Fix video house style',
		description:
			'Applies every certain house-style fix as one undo step: the house frame rate, title sizes in the house range, and transitions of a house type and length. Returns how many it fixed and the findings left (aspect ratio, length, colours and fonts: fix those with the video tools). Run check_video_style after.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Fix video house style', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: async () => {
			const reason = readOnlyReason();
			if (reason) throw new Error(reason);
			const { findings } = await run();
			const edits: VideoEdit[] = [];
			const left: StyleFinding[] = [];
			for (const f of findings) {
				const e = editFor(f.target as VideoStyleTarget);
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
		id: options.id ?? 'video-style',
		namespace: options.namespace,
		title: 'Video house style',
		description: 'Check an edit against the house style and apply its certain fixes.',
		skill: 'pixerate-video-editor',
		tools: () => (readOnlyReason() ? [check] : [check, fix])
	};
}
