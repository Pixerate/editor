/**
 * Diagram families offered as UI components (#819), beside the chart types (`uiComponents()` in
 * `@pixerate/editor/chart`): `flow` (a process of steps), `timeline` (periods and their events)
 * and `mindmap` (a root and its branches). Each takes plain data, writes it as Mermaid, lays it out
 * with the family's own layout and draws it with `mermaidToSvg`, so a component library gets the
 * diagram editor's drawing without hand-written wrappers.
 *
 * Here rather than in `/chart` because diagram layout needs dagre (this entry's dependency).
 */
import { DEFAULT_CHART_PALETTE } from '../chart/spec.js';
import { chartPaletteWithAccent, type ChartUiRenderOptions, type ChartUiThemeMode, type UiColorRole, type UiComponentContract, type UiDescriptor, type UiJsonValue, type UiPlatformTarget } from '../chart/ui-components.js';
import { parseMermaid } from '../diagram/document.js';
import { hashValue } from '../generation/hash.js';
import { validateJsonSchema, type JsonSchema } from '../tools/schema.js';
import { mermaidToSvg } from './mermaid/export.js';
import { DIAGRAM_SCENE_DARK_THEME, DIAGRAM_SCENE_LIGHT_THEME, type DiagramSceneTheme } from './mermaid/scene-kit.js';

export type DiagramUiComponentId = 'flow' | 'timeline' | 'mindmap';

/** A process: steps in order, joined in sequence unless `links` say otherwise. */
export interface FlowUiData {
	steps: { id?: string; label: string }[];
	/** Arrows between steps by id (a step's id defaults to its position, "1", "2", …). Default: each step to the next. */
	links?: { from: string; to: string; label?: string }[];
	/** `LR` left to right (default) or `TD` top down. */
	direction?: 'LR' | 'TD';
	title?: string;
}

/** Periods in order, each with its events. */
export interface TimelineUiData {
	periods: { label: string; events: string[] }[];
	title?: string;
}

/** A root idea and its branches (two levels of children at most). */
export interface MindmapUiData {
	root: string;
	branches: { label: string; children?: { label: string; children?: { label: string }[] }[] }[];
	title?: string;
}

/** A diagram family offered as a UI component (the same shape as `ChartUiComponent`). */
export interface DiagramUiComponent {
	id: DiagramUiComponentId;
	title: string;
	description: string;
	descriptor: UiDescriptor;
	colorRoleUse: Record<UiColorRole, string>;
	defaultColors: Record<ChartUiThemeMode, Record<UiColorRole, string>>;
	/** Draws `data` as a standalone, accessible SVG of exactly `width` × `height`, the diagram fitted and centred in it. */
	render(data: unknown, options: ChartUiRenderOptions): string;
	/** The Mermaid source `data` is drawn from, for hosts that want to edit it as a diagram. */
	toMermaid(data: unknown): string;
}

/** Per-type render versions (as `CHART_UI_RENDER_VERSIONS`): bump when the drawing changes unseen. */
export const DIAGRAM_UI_RENDER_VERSIONS: Readonly<Record<DiagramUiComponentId, number>> = { flow: 1, timeline: 1, mindmap: 1 };

const LABEL: JsonSchema = { type: 'string', minLength: 1, maxLength: 80, description: 'A short label.' };

const FLOW_PROPS: JsonSchema = {
	type: 'object',
	properties: {
		steps: { type: 'array', minItems: 1, maxItems: 30, description: 'The steps, in order.', items: { type: 'object', properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,40}$', description: 'Id for links (default its position, "1", "2", …).' }, label: LABEL }, required: ['label'], additionalProperties: false } },
		links: { type: 'array', maxItems: 60, description: 'Arrows between steps by id (default: each step to the next).', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string', maxLength: 40 } }, required: ['from', 'to'], additionalProperties: false } },
		direction: { type: 'string', enum: ['LR', 'TD'], description: 'LR left to right (default) or TD top down.' },
		title: { type: 'string', description: 'Accessible name (default: built from the steps).' }
	},
	required: ['steps'],
	additionalProperties: false
};

const TIMELINE_PROPS: JsonSchema = {
	type: 'object',
	properties: {
		periods: { type: 'array', minItems: 1, maxItems: 20, description: 'Periods in order, each with its events.', items: { type: 'object', properties: { label: LABEL, events: { type: 'array', items: LABEL, maxItems: 8, description: 'What happened in the period.' } }, required: ['label', 'events'], additionalProperties: false } },
		title: { type: 'string', description: 'Title drawn above the timeline and used as its accessible name.' }
	},
	required: ['periods'],
	additionalProperties: false
};

const LEAF = { type: 'object', properties: { label: LABEL }, required: ['label'], additionalProperties: false } as const;
const MINDMAP_PROPS: JsonSchema = {
	type: 'object',
	properties: {
		root: { ...LABEL, description: 'The central idea.' },
		branches: {
			type: 'array',
			minItems: 1,
			maxItems: 12,
			description: 'Branches round the root, each with up to two levels of children.',
			items: { type: 'object', properties: { label: LABEL, children: { type: 'array', maxItems: 12, items: { type: 'object', properties: { label: LABEL, children: { type: 'array', maxItems: 12, items: LEAF } }, required: ['label'], additionalProperties: false } } }, required: ['label'], additionalProperties: false }
		},
		title: { type: 'string', description: 'Accessible name (default: built from the root).' }
	},
	required: ['root', 'branches'],
	additionalProperties: false
};

const FLOW_EXAMPLE: FlowUiData = { steps: [{ label: 'Sign up' }, { label: 'Verify email' }, { label: 'Pick a plan' }, { label: 'Start trial' }] };
const TIMELINE_EXAMPLE: TimelineUiData = { title: 'Product history', periods: [{ label: '2021', events: ['Prototype', 'First customer'] }, { label: '2022', events: ['Series A'] }, { label: '2023', events: ['Mobile app', '1M users'] }] };
const MINDMAP_EXAMPLE: MindmapUiData = { root: 'Platform', branches: [{ label: 'Research', children: [{ label: 'Interviews' }, { label: 'Surveys' }] }, { label: 'Design', children: [{ label: 'Systems' }] }, { label: 'Engineering' }] };

/** A label safe inside Mermaid's double quotes, on one line. */
const quoted = (text: string) => `"${text.replace(/\s+/g, ' ').trim().replace(/"/g, '#quot;')}"`;
/** Timeline text cannot hold the `:` that separates events, or line breaks. */
const timelineText = (text: string) => text.replace(/\s+/g, ' ').trim().replace(/:/g, '∶');

function flowMermaid(d: FlowUiData): string {
	const ids = d.steps.map((s, i) => s.id ?? String(i + 1));
	const key = new Map(ids.map((id, i) => [id, `s${i}`]));
	const lines = [`flowchart ${d.direction ?? 'LR'}`];
	d.steps.forEach((s, i) => lines.push(`  s${i}[${quoted(s.label)}]`));
	const links: { from: string; to: string; label?: string }[] = d.links ?? ids.slice(1).map((id, i) => ({ from: ids[i]!, to: id }));
	for (const l of links) {
		const from = key.get(l.from);
		const to = key.get(l.to);
		if (!from || !to) throw new Error(`flow: link ${l.from} → ${l.to} names a step that does not exist; step ids are ${ids.join(', ')}.`);
		lines.push(`  ${from} -->${l.label ? `|${quoted(l.label)}|` : ''} ${to}`);
	}
	return lines.join('\n');
}

function timelineMermaid(d: TimelineUiData): string {
	const lines = ['timeline'];
	if (d.title) lines.push(`  title ${timelineText(d.title)}`);
	for (const p of d.periods) lines.push(`  ${[p.label, ...p.events].map(timelineText).join(' : ')}`);
	return lines.join('\n');
}

function mindmapMermaid(d: MindmapUiData): string {
	let n = 0;
	const lines = ['mindmap', `  root((${quoted(d.root)}))`];
	for (const b of d.branches) {
		lines.push(`    n${n++}[${quoted(b.label)}]`);
		for (const c of b.children ?? []) {
			lines.push(`      n${n++}[${quoted(c.label)}]`);
			for (const g of c.children ?? []) lines.push(`        n${n++}[${quoted(g.label)}]`);
		}
	}
	return lines.join('\n');
}

const ROLES = ['surface', 'surface-raised', 'ink', 'ink-muted', 'border', 'accent'];
const DEFAULTS: Record<ChartUiThemeMode, Record<UiColorRole, string>> = {
	light: { surface: '#ffffff', 'surface-raised': '#ffffff', ink: '#0f172a', 'ink-muted': '#64748b', border: '#0f172a', accent: DIAGRAM_SCENE_LIGHT_THEME.palette[0]! },
	dark: { surface: '#0f172a', 'surface-raised': '#1e293b', ink: '#f1f5f9', 'ink-muted': '#94a3b8', border: '#e2e8f0', accent: DIAGRAM_SCENE_DARK_THEME.palette[0]! }
};
const ROLE_USE: Record<UiColorRole, string> = {
	surface: 'Background.',
	'surface-raised': 'Step boxes (flow).',
	ink: 'Labels and titles.',
	'ink-muted': 'Arrows, the timeline axis and secondary text.',
	border: 'Step box outlines and group outlines.',
	accent: 'The first period or branch; further ones take the next colours of the categorical palette.'
};

function check(id: DiagramUiComponentId, data: unknown, schema: JsonSchema, options: ChartUiRenderOptions): void {
	const errors = validateJsonSchema(data, schema);
	if (errors.length) throw new Error(`${id}: invalid data: ${errors.map((e) => `${e.path || '/'} ${e.message}`).join('; ')}`);
	for (const [name, v] of [['width', options?.width], ['height', options?.height]] as const) {
		if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 4096) throw new Error(`${id}: ${name} must be a number of CSS px from 1 to 4096 (got ${String(v)}).`);
	}
	if (options.theme !== undefined && options.theme !== 'light' && options.theme !== 'dark') throw new Error(`${id}: theme must be "light" or "dark" (got ${String(options.theme)}).`);
}

/** The diagram drawn at exactly width × height: the fitted drawing, centred, on the background. */
function draw(id: DiagramUiComponentId, source: string, label: string, options: ChartUiRenderOptions): string {
	const mode = options.theme ?? 'light';
	const c = { ...DEFAULTS[mode] };
	for (const [role, value] of Object.entries(options.colors ?? {})) if (ROLES.includes(role) && typeof value === 'string' && value.trim()) c[role] = value.trim();
	const base = mode === 'dark' ? DIAGRAM_SCENE_DARK_THEME : DIAGRAM_SCENE_LIGHT_THEME;
	const theme: Partial<DiagramSceneTheme> = {
		background: c.surface,
		edgeLabelBackground: c.surface,
		nodeFill: c['surface-raised'],
		nodeStroke: c.border,
		groupStroke: c.border,
		text: c.ink,
		groupText: c['ink-muted'],
		mutedText: c['ink-muted'],
		edge: c['ink-muted'],
		grid: c['ink-muted'],
		palette: chartPaletteWithAccent(c.accent!, base.palette.length ? base.palette : DEFAULT_CHART_PALETTE)
	};
	const doc = parseMermaid(source);
	const out = mermaidToSvg(doc, { theme, maxWidth: options.width, maxHeight: options.height, title: label, transparent: true });
	// Size the document to the box asked for; the drawing keeps its proportions, centred (its viewBox).
	const body = out.svg
		.replace(/^<svg\b([^>]*?)\swidth="[^"]*"/, '<svg$1')
		.replace(/^<svg\b([^>]*?)\sheight="[^"]*"/, '<svg$1')
		.replace(/^<svg\b/, `<svg width="${options.width}" height="${options.height}" preserveAspectRatio="xMidYMid meet"`)
		.replace(/^<svg\b[^>]*>/, (open) => `${open.slice(0, -1).replace(/\srole="[^"]*"/g, '')} role="img" data-diagram="${id}">`);
	// A full-size background behind the fitted drawing.
	return body.replace(/^(<svg\b[^>]*>)/, `$1<rect x="-100000" y="-100000" width="200000" height="200000" fill="${c.surface}"/>`);
}

interface Spec<D> {
	id: DiagramUiComponentId;
	title: string;
	description: string;
	props: JsonSchema;
	example: D;
	sizing: UiComponentContract['sizing'];
	mermaid: (data: D) => string;
	label: (data: D) => string;
}

function component<D>(spec: Spec<D>): Omit<DiagramUiComponent, 'descriptor'> & { contract: UiComponentContract; example: D } {
	const contract: UiComponentContract = {
		props: spec.props as Record<string, UiJsonValue>,
		state: [],
		events: [],
		a11y: { role: 'img', keyboard: {}, labelFrom: 'content' },
		colorRoles: ROLES,
		motion: false,
		sizing: spec.sizing
	};
	return {
		id: spec.id,
		title: spec.title,
		description: spec.description,
		contract,
		example: spec.example,
		colorRoleUse: { ...ROLE_USE },
		defaultColors: { light: { ...DEFAULTS.light }, dark: { ...DEFAULTS.dark } },
		toMermaid(data: unknown) {
			const errors = validateJsonSchema(data, spec.props);
			if (errors.length) throw new Error(`${spec.id}: invalid data: ${errors.map((e) => `${e.path || '/'} ${e.message}`).join('; ')}`);
			return spec.mermaid(data as D);
		},
		render(data: unknown, options: ChartUiRenderOptions) {
			check(spec.id, data, spec.props, options);
			return draw(spec.id, spec.mermaid(data as D), spec.label(data as D), options);
		}
	};
}

const EXAMPLE_SIZES: Record<DiagramUiComponentId, { width: number; height: number }> = { flow: { width: 560, height: 120 }, timeline: { width: 560, height: 320 }, mindmap: { width: 560, height: 320 } };

let cache: DiagramUiComponent[] | null = null;

/**
 * The diagram families offered as UI components (group `data-visual`): `flow`, `timeline` and
 * `mindmap`, each with a `UiDescriptor` (data JSON Schema, colour roles, accessibility, sizing,
 * example, `contentHash`), a `render` to SVG at a size, theme and role colours, and `toMermaid`.
 * `contentHash` is computed as for `uiComponents()` in `/chart`.
 */
export function diagramUiComponents(): DiagramUiComponent[] {
	if (!cache) {
		const parts = [
			component<FlowUiData>({
				id: 'flow',
				title: 'Flow',
				description: 'A process as boxes joined by arrows, left to right or top down, in the diagram editor\'s layout.',
				props: FLOW_PROPS,
				example: FLOW_EXAMPLE,
				sizing: { mode: 'fill', minWidth: 240, minHeight: 80 },
				mermaid: flowMermaid,
				label: (d) => d.title || `Flow: ${d.steps.map((s) => s.label).join(' → ')}`
			}),
			component<TimelineUiData>({
				id: 'timeline',
				title: 'Timeline',
				description: 'Periods along an axis, each with its events stacked under it, one colour per period.',
				props: TIMELINE_PROPS,
				example: TIMELINE_EXAMPLE,
				sizing: { mode: 'fill', minWidth: 280, minHeight: 200 },
				mermaid: timelineMermaid,
				label: (d) => d.title || `Timeline of ${d.periods.length} periods: ${d.periods.map((p) => p.label).join(', ')}`
			}),
			component<MindmapUiData>({
				id: 'mindmap',
				title: 'Mind map',
				description: 'A central idea with branches and sub-branches spread round it, one colour per branch.',
				props: MINDMAP_PROPS,
				example: MINDMAP_EXAMPLE,
				sizing: { mode: 'fill', minWidth: 280, minHeight: 220 },
				mermaid: mindmapMermaid,
				label: (d) => d.title || `Mind map of ${d.root}: ${d.branches.map((b) => b.label).join(', ')}`
			})
		] as (Omit<DiagramUiComponent, 'descriptor'> & { contract: UiComponentContract; example: unknown })[];
		cache = parts.map(({ contract, example, ...rest }) => {
			const platforms: UiPlatformTarget[] = ['html-page'];
			const size = EXAMPLE_SIZES[rest.id];
			const renders = (['light', 'dark'] as const).map((theme) => rest.render(example, { ...size, theme }));
			const contentHash = hashValue({ id: rest.id, renderVersion: DIAGRAM_UI_RENDER_VERSIONS[rest.id], contract, platforms, example, renders });
			return { ...rest, descriptor: { implements: rest.id, group: 'data-visual', contract, platforms, swiftReady: false, example: example as Record<string, UiJsonValue>, contentHash } };
		});
	}
	const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
	return cache.map((c) => ({ ...c, descriptor: clone(c.descriptor), colorRoleUse: { ...c.colorRoleUse }, defaultColors: clone(c.defaultColors) }));
}
