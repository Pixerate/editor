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
import { contrastRatio } from '../color/contrast.js';
import { formatHex } from '../color/format.js';
import { parseColor } from '../color/parse.js';
import { chartPaletteWithAccent, tableFallback, type ChartUiRenderOptions, type ChartUiThemeMode, type UiColorRole, type UiComponentContract, type UiDescriptor, type UiFallback, type UiJsonValue, type UiPlatformTarget, type UiTableProps } from '../chart/ui-components.js';
import { parseMermaid } from '../diagram/document.js';
import { hashValue } from '../generation/hash.js';
import { validateJsonSchema, type JsonSchema } from '../tools/schema.js';
import { mermaidToSvg } from './mermaid/export.js';
import { TIMELINE_EVENT_WASH } from './mermaid/families/timeline.js';
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
	/** The same data as a `table` (`descriptor.fallback`), for where the drawing can't run. */
	fallback(data: unknown): UiFallback;
}

/** Per-type render versions (as `CHART_UI_RENDER_VERSIONS`): bump when the drawing changes unseen. */
export const DIAGRAM_UI_RENDER_VERSIONS: Readonly<Record<DiagramUiComponentId, number>> = { flow: 1, timeline: 2, mindmap: 2 };

/** WCAG AA for the labels drawn on palette colours. */
const LABEL_CONTRAST = 4.5;

/**
 * `color`, or the nearest step from it towards white or black (whichever reads better with `text`)
 * that keeps `text` at WCAG AA on it. Timeline periods and mind-map branches label their boxes in
 * the scene's one palette text colour, so a brand accent near that colour (a near-black primary)
 * is shifted until the label reads, keeping its hue. With `wash` (a colour and an amount), the label
 * must also read on the colour with that wash over it, as timeline events draw their period's colour.
 */
export function diagramReadableFill(color: string, text: string, wash?: { color: string; amount: number }): string {
	const c = parseColor(color);
	const t = parseColor(text);
	if (!c || !t) return color;
	const w = wash ? parseColor(wash.color) : null;
	const reads = (fill: { r: number; g: number; b: number }) => {
		if (contrastRatio(t, { ...fill, a: 1 }) < LABEL_CONTRAST) return false;
		if (!w || !wash) return true;
		const k = wash.amount;
		return contrastRatio(t, { r: fill.r + (w.r - fill.r) * k, g: fill.g + (w.g - fill.g) * k, b: fill.b + (w.b - fill.b) * k, a: 1 }) >= LABEL_CONTRAST;
	};
	if (reads(c)) return color;
	const white = { r: 1, g: 1, b: 1, a: 1 };
	const black = { r: 0, g: 0, b: 0, a: 1 };
	const to = contrastRatio(t, white) >= contrastRatio(t, black) ? white : black;
	for (let step = 1; step <= 20; step++) {
		const k = step / 20;
		const mixed = { r: c.r + (to.r - c.r) * k, g: c.g + (to.g - c.g) * k, b: c.b + (to.b - c.b) * k, a: 1 };
		if (reads(mixed)) return formatHex(mixed);
	}
	return formatHex(to);
}

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

/** The flow's links as step indexes (default: each step to the next); throws on an unknown id. */
function flowLinks(d: FlowUiData): { from: number; to: number; label?: string }[] {
	const ids = d.steps.map((s, i) => s.id ?? String(i + 1));
	const index = new Map(ids.map((id, i) => [id, i]));
	const links: { from: string; to: string; label?: string }[] = d.links ?? ids.slice(1).map((id, i) => ({ from: ids[i]!, to: id }));
	return links.map((l) => {
		const from = index.get(l.from);
		const to = index.get(l.to);
		if (from === undefined || to === undefined) throw new Error(`flow: link ${l.from} → ${l.to} names a step that does not exist; step ids are ${ids.join(', ')}.`);
		return { from, to, ...(l.label ? { label: l.label } : {}) };
	});
}

function flowMermaid(d: FlowUiData): string {
	const lines = [`flowchart ${d.direction ?? 'LR'}`];
	d.steps.forEach((s, i) => lines.push(`  s${i}[${quoted(s.label)}]`));
	for (const l of flowLinks(d)) lines.push(`  s${l.from} -->${l.label ? `|${quoted(l.label)}|` : ''} s${l.to}`);
	return lines.join('\n');
}

/** One row per step: the step, then where it leads ("Next (label)", comma-separated). */
function flowTable(d: FlowUiData): UiTableProps {
	const links = flowLinks(d);
	const next = (i: number) => links.filter((l) => l.from === i).map((l) => (l.label ? `${d.steps[l.to]!.label} (${l.label})` : d.steps[l.to]!.label)).join(', ');
	return { caption: d.title || undefined, columns: ['Step', 'Leads to'], rows: d.steps.map((s, i) => [s.label, next(i)]), rowHeaders: true };
}

/** One row per period, its events joined with semicolons. */
function timelineTable(d: TimelineUiData): UiTableProps {
	return { caption: d.title || undefined, columns: ['Period', 'Events'], rows: d.periods.map((p) => [p.label, p.events.join('; ')]), rowHeaders: true };
}

/** One row per path from a branch to its deepest child; the root is the caption (or the title). */
function mindmapTable(d: MindmapUiData): UiTableProps {
	const rows: (string | null)[][] = [];
	for (const b of d.branches) {
		if (!b.children?.length) rows.push([b.label, null, null]);
		for (const c of b.children ?? []) {
			if (!c.children?.length) rows.push([b.label, c.label, null]);
			for (const g of c.children ?? []) rows.push([b.label, c.label, g.label]);
		}
	}
	return { caption: d.title || d.root, columns: ['Branch', 'Topic', 'Detail'], rows, rowHeaders: true };
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
	ink: 'Labels and titles, and the mind map\'s root.',
	'ink-muted': 'Arrows, the timeline axis and secondary text.',
	border: 'Step box outlines and group outlines.',
	accent: 'The first period or branch; further ones take the next colours of the categorical palette. A colour too close to the label colour is lightened or darkened until its label reads (WCAG AA).'
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
		// The mind map fills its root with nodeStroke: ink, so its label (the surface) always reads;
		// elsewhere it outlines boxes, the border role's job.
		nodeStroke: id === 'mindmap' ? c.ink : c.border,
		groupStroke: c.border,
		text: c.ink,
		groupText: c['ink-muted'],
		mutedText: c['ink-muted'],
		edge: c['ink-muted'],
		grid: c['ink-muted'],
		palette: chartPaletteWithAccent(c.accent!, base.palette.length ? base.palette : DEFAULT_CHART_PALETTE).map((color) => diagramReadableFill(color, base.paletteText, { color: c.surface!, amount: TIMELINE_EVENT_WASH }))
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
	table: (data: D) => UiTableProps;
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
		fallback(data: unknown) {
			const errors = validateJsonSchema(data, spec.props);
			if (errors.length) throw new Error(`${spec.id}: invalid data: ${errors.map((e) => `${e.path || '/'} ${e.message}`).join('; ')}`);
			return tableFallback(spec.table(data as D));
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
 * example, `contentHash`), a `render` to SVG at a size, theme and role colours, `toMermaid`, and
 * `fallback` to a `table` (flow: step and where it leads; timeline: period and events; mind map:
 * branch, topic and detail).
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
				table: flowTable,
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
				table: timelineTable,
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
				table: mindmapTable,
				label: (d) => d.title || `Mind map of ${d.root}: ${d.branches.map((b) => b.label).join(', ')}`
			})
		] as (Omit<DiagramUiComponent, 'descriptor'> & { contract: UiComponentContract; example: unknown })[];
		cache = parts.map(({ contract, example, ...rest }) => {
			const platforms: UiPlatformTarget[] = ['html-page'];
			const size = EXAMPLE_SIZES[rest.id];
			const renders = (['light', 'dark'] as const).map((theme) => rest.render(example, { ...size, theme }));
			const fallback = rest.fallback(example);
			const contentHash = hashValue({ id: rest.id, renderVersion: DIAGRAM_UI_RENDER_VERSIONS[rest.id], contract, platforms, example, renders, fallback });
			return { ...rest, descriptor: { implements: rest.id, group: 'data-visual', contract, platforms, swiftReady: false, example: example as Record<string, UiJsonValue>, fallback: fallback.implements, contentHash } };
		});
	}
	const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
	return cache.map((c) => ({ ...c, descriptor: clone(c.descriptor), colorRoleUse: { ...c.colorRoleUse }, defaultColors: clone(c.defaultColors) }));
}
