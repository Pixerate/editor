/**
 * House style for paintings (#779): the `paint-editor.json` profile (the papers and brushes
 * allowed, a layer limit, and the colours paint may use), its checks, and `check_paint_style` /
 * `fix_paint_style`.
 *
 * Findings target the paper (`{ paper: preset }`, the house paper to switch to), the current
 * brush (`{ brush: id }`), a recorded stroke (`{ stroke: id }`), the current colour or a swatch.
 */
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { StyleCheck, StyleDomain, StyleFinding, StyleResolver } from '../tools/style.js';
import type { StyleSurface, StyleSurfaceColor } from '../tools/style-surface.js';
import { brandPalette } from '../tools/brand.js';
import type { PaintEditorController, PaintEditorState } from './controller.js';
import { PAPER_LIBRARY } from './paper.js';

/** The `paint-editor.json` profile, after `$token` references are resolved. */
export interface PaintStyleProfile {
	/** Paper presets allowed (the first is the house paper). */
	papers?: string[];
	/** Brush ids allowed (the first is the house default). */
	brushes?: string[];
	/** Most layers in one painting. */
	maxLayers?: number;
	/** Colours paint may use (for palette-only). Default: the brand's. */
	palette?: string[];
}

/** A finding's target. */
export type PaintStyleTarget = { paper: string } | { brush: string } | { stroke: string } | { color: 'current' } | { swatch: number } | { painting: true };

const profileOf = (p: Readonly<Record<string, unknown>>) => p as PaintStyleProfile;

const paper: StyleCheck<PaintEditorState> = {
	id: 'paper',
	description: 'The painting is on a house paper ("papers": preset ids; the first is the house paper).',
	run(state, profile) {
		const papers = profileOf(profile).papers;
		if (!papers?.length) throw new Error('the profile has no "papers".');
		const current = state.document.paper.preset;
		if (papers.includes(current)) return [];
		return [{ severity: 'warning' as const, message: `The painting is on "${current}" paper; the house papers are ${papers.map((p) => `"${p}"`).join(', ')}. Switch to "${papers[0]}" with set_paper.`, target: { paper: papers[0] } satisfies PaintStyleTarget }];
	}
};

const brushes: StyleCheck<PaintEditorState> = {
	id: 'brushes',
	description: 'Strokes and the current brush use house brushes ("brushes": brush ids; the first is the house default).',
	run(state, profile) {
		const allowed = profileOf(profile).brushes;
		if (!allowed?.length) throw new Error('the profile has no "brushes".');
		const out: Omit<StyleFinding, 'check' | 'layer'>[] = [];
		if (!allowed.includes(state.brush.id)) out.push({ severity: 'warning' as const, message: `The current brush is "${state.brush.id}"; the house brushes are ${allowed.join(', ')}. Pick "${allowed[0]}" before painting.`, target: { brush: allowed[0] } satisfies PaintStyleTarget });
		const off = state.document.strokes.filter((s) => !allowed.includes(s.brush.id));
		for (const s of off.slice(0, 50)) out.push({ severity: 'info' as const, message: `Stroke ${s.id} was painted with "${s.brush.id}", not a house brush.`, target: { stroke: s.id } satisfies PaintStyleTarget });
		if (off.length > 50) out.push({ severity: 'info' as const, message: `${off.length - 50} more strokes use brushes outside the house set.`, target: { painting: true } satisfies PaintStyleTarget });
		return out;
	}
};

const maxLayers: StyleCheck<PaintEditorState> = {
	id: 'max-layers',
	description: 'A painting has at most "maxLayers" layers; merge passes that belong together.',
	run(state, profile) {
		const max = profileOf(profile).maxLayers;
		if (!max) throw new Error('the profile has no "maxLayers".');
		const n = state.document.layers.length;
		if (n <= max) return [];
		return [{ severity: 'info' as const, message: `The painting has ${n} layers; the house style keeps paintings to ${max}. Merge layers that belong together.`, target: { painting: true } satisfies PaintStyleTarget }];
	}
};

/** The colours paint uses (strokes, the current colour, swatches), for the shared checks. */
export function paintStyleSurface(state: PaintEditorState): StyleSurface {
	const colors: StyleSurfaceColor[] = [];
	colors.push({ color: state.color, label: 'The current colour', target: { color: 'current' } satisfies PaintStyleTarget, use: 'fill' });
	state.swatches.forEach((s, i) => colors.push({ color: s.color, label: `Swatch ${i + 1}${s.name ? ` ("${s.name}")` : ''}`, target: { swatch: i } satisfies PaintStyleTarget, use: 'fill' }));
	const seen = new Set<string>();
	for (const s of state.document.strokes) {
		const key = s.color.toLowerCase();
		if (seen.has(key)) continue; // one finding per colour, at its first stroke
		seen.add(key);
		colors.push({ color: s.color, label: `Stroke ${s.id}`, target: { stroke: s.id } satisfies PaintStyleTarget, use: 'fill' });
	}
	return { colors };
}

/** The paint house-style domain: register it with `createStyleResolver({ domains })`. */
export const paintStyleDomain: StyleDomain<PaintEditorState> = {
	id: 'paint-editor',
	title: 'Paintings',
	description: 'How paintings are made: the papers and brushes allowed, a layer limit, and the colours paint may use (strokes, the current colour and swatches).',
	profileSchema: {
		type: 'object',
		properties: {
			papers: { type: 'array', items: { type: 'string', enum: PAPER_LIBRARY.map((p) => p.preset) }, minItems: 1, description: 'Paper presets allowed (from the paper library); the first is the house paper.' },
			brushes: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, description: 'Brush ids allowed; the first is the house default.' },
			maxLayers: { type: 'integer', minimum: 1, maximum: 500, description: 'Most layers in one painting.' },
			palette: { type: 'array', items: { type: 'string', minLength: 1, description: 'A CSS colour, or a { "$token": ... } reference.' }, description: 'Colours paint may use (for palette-only). Default: the brand palette and roles.' }
		},
		additionalProperties: false
	},
	checks: [paper, brushes, maxLayers],
	surface: paintStyleSurface,
	themeFromBrand: (brand) => {
		const palette = brandPalette(brand);
		return palette.length ? { palette } : {};
	},
	example: {
		papers: ['cold-pressed', 'hot-pressed'],
		brushes: ['watercolor-round', 'watercolor-wash', 'pencil-hb'],
		maxLayers: 12,
		checks: ['paper', 'brushes', 'max-layers', 'palette-only']
	}
};

export interface PaintStyleToolProviderOptions {
	/** Provider id (unique per registry). Default `paint-style`. */
	id?: string;
	/** Tool-name prefix; defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Where the tools work: skills scoped elsewhere do not apply. Set by the host. */
	scope?: string;
	/** The painting cannot be changed: `fix_paint_style` is hidden (a string is the reason). */
	readOnly?: boolean | string | (() => boolean | string);
}

/**
 * `check_paint_style` and, while the painting is editable, `fix_paint_style` (switches to the
 * house paper and the house brush; strokes already painted stay as they are).
 */
export function createPaintStyleToolProvider(controller: PaintEditorController, styles: StyleResolver, options: PaintStyleToolProviderOptions = {}): AgentToolProvider {
	if (!styles.domains.some((d) => d.id === 'paint-editor')) throw new Error('The style resolver has no "paint-editor" domain; add paintStyleDomain to its domains.');
	const scope = options.scope !== undefined ? { scope: options.scope } : {};
	const readOnlyReason = (): string | null => {
		const r = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		if (!r) return null;
		return typeof r === 'string' ? r : 'This painting is read-only.';
	};
	const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
	const run = () => styles.check('paint-editor', controller.getState(), scope);

	const check: AgentTool = {
		name: 'check_paint_style',
		title: 'Check painting house style',
		description:
			'Checks the painting against the house style (see get_style with domain "paint-editor"): paper, brushes, max-layers, and the brand\'s palette-only on stroke colours, the current colour and swatches. Returns findings with a severity, a sentence saying how to fix it, a target ({ paper } or { brush } with the house value, { stroke: id }, { color: "current" }, { swatch: index } or { painting: true }) and the layer that asked; the checks that ran and those skipped. fix_paint_style switches to the house paper and brush.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Check painting house style', ...READ },
		handler: async () => {
			const { style, ...report } = await run();
			return {
				...report,
				ok: report.findings.length === 0,
				...(style.skills.length ? {} : { note: 'No house style applies to paintings.' }),
				...(style.issues.length ? { issues: style.issues } : {})
			};
		}
	};

	const fix: AgentTool = {
		name: 'fix_paint_style',
		title: 'Fix painting house style',
		description:
			'Switches the painting to the house paper and the current brush to the house brush. Strokes already painted, colours and layers are left for you (repaint or recolour them deliberately). Returns what it changed and the findings left. Run check_paint_style after.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Fix painting house style', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: async () => {
			const reason = readOnlyReason();
			if (reason) throw new Error(reason);
			const { findings } = await run();
			const changed: Record<string, string> = {};
			const left: StyleFinding[] = [];
			for (const f of findings) {
				const t = f.target as PaintStyleTarget | undefined;
				if (t && 'paper' in t && !changed.paper) {
					controller.setPaper({ preset: t.paper });
					changed.paper = controller.getState().document.paper.preset;
				} else if (t && 'brush' in t && !changed.brush && controller.getState().brushes.some((b) => b.id === t.brush)) {
					controller.setBrush({ id: t.brush });
					changed.brush = t.brush;
				} else left.push(f);
			}
			return { changed, left };
		}
	};

	return {
		id: options.id ?? 'paint-style',
		namespace: options.namespace,
		title: 'Painting house style',
		description: 'Check a painting against the house style and switch to the house paper and brush.',
		skill: 'pixerate-paint-editor',
		tools: () => (readOnlyReason() ? [check] : [check, fix])
	};
}
