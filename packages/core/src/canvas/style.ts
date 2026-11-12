/**
 * House style for the canvas (#779): the `canvas.json` profile (corner radii, stroke widths and
 * font sizes allowed, a position grid, and the colours and fonts nodes may use), its checks,
 * and `check_canvas_style` / `fix_canvas_style`.
 *
 * Node properties are read and written through `CANVAS_TOKEN_PROPERTIES`, so style strings
 * (SvelteFlow) and style objects (React Flow) and shape paints all work. Findings target a node
 * by id with the property and the certain value (`{ node, property, value }`).
 */
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { StyleCheck, StyleDomain, StyleFinding, StyleResolver } from '../tools/style.js';
import type { StyleSurface, StyleSurfaceColor } from '../tools/style-surface.js';
import { brandFonts, brandPalette } from '../tools/brand.js';
import { CANVAS_TOKEN_PROPERTIES, readNodeStyleProperty } from './tokenBindings.js';
import type { ArrangeHistoryTarget } from './arrangeController.js';
import type { CanvasNode } from './types.js';

type Finding = Omit<StyleFinding, 'check' | 'layer'>;

/** What the canvas house-style checks read. */
export interface CanvasStyleState {
	nodes: readonly CanvasNode[];
}

/** The `canvas.json` profile, after `$token` references are resolved. */
export interface CanvasStyleProfile {
	/** Corner radii allowed, in flow units. */
	cornerRadii?: number[];
	/** Stroke widths allowed, in flow units. */
	strokeWidths?: number[];
	/** Font sizes allowed, in px (a type scale). */
	fontSizes?: number[];
	/** Node positions on a grid of this many flow units. */
	grid?: number;
	/** Colours nodes may use (for palette-only). Default: the brand's. */
	palette?: string[];
	/** Fonts nodes may use (for fonts-allowed). Default: the brand's. */
	fonts?: string[];
}

/** A finding's target: a node property and the value to set when the fix is certain. */
export interface CanvasStyleTarget {
	node: string;
	property: string;
	value?: number | { x: number; y: number };
}

const profileOf = (p: Readonly<Record<string, unknown>>) => p as CanvasStyleProfile;
const prop = (key: string) => CANVAS_TOKEN_PROPERTIES.find((p) => p.key === key)!;
const label = (node: CanvasNode) => {
	const text = typeof node.data?.label === 'string' ? node.data.label : typeof node.data?.text === 'string' ? node.data.text : '';
	return text ? `Node ${node.id} ("${text.length > 30 ? `${text.slice(0, 27)}...` : text}")` : `Node ${node.id}`;
};
const nearest = (value: number, allowed: readonly number[]) => allowed.reduce((best, a) => (Math.abs(a - value) < Math.abs(best - value) ? a : best), allowed[0]);

/** A check that a numeric property takes one of the profile's values. */
function allowedValues(id: string, key: string, field: keyof CanvasStyleProfile, what: string, unit: string): StyleCheck<CanvasStyleState> {
	return {
		id,
		description: `${what} take one of the house values ("${field}", in ${unit}).`,
		run(state, profile) {
			const allowed = profileOf(profile)[field] as number[] | undefined;
			if (!allowed?.length) throw new Error(`the profile has no "${field}".`);
			const p = prop(key);
			const out: Finding[] = [];
			for (const node of state.nodes) {
				if (!p.appliesTo(node)) continue;
				const v = p.read(node);
				if (typeof v !== 'number' || allowed.some((a) => Math.abs(a - v) < 1e-6)) continue;
				const want = nearest(v, allowed);
				out.push({ severity: 'info' as const, message: `${label(node)} has a ${what.toLowerCase().replace(/s$/, '')} of ${v}; the house values are ${allowed.join(', ')}. Use ${want}.`, target: { node: node.id, property: key, value: want } satisfies CanvasStyleTarget });
			}
			return out;
		}
	};
}

const grid: StyleCheck<CanvasStyleState> = {
	id: 'grid',
	description: 'Node positions sit on the house grid ("grid", in flow units), so edges and spacing line up.',
	run(state, profile) {
		const step = profileOf(profile).grid;
		if (!step) throw new Error('the profile has no "grid".');
		const snap = (v: number) => Math.round(v / step) * step;
		const out: Finding[] = [];
		for (const node of state.nodes) {
			if (node.parentId) continue; // children sit on their parent's own grid
			const { x, y } = node.position;
			if (Math.abs(snap(x) - x) < 1e-6 && Math.abs(snap(y) - y) < 1e-6) continue;
			out.push({ severity: 'info' as const, message: `${label(node)} is at ${x}, ${y}, off the ${step}-unit grid; move it to ${snap(x)}, ${snap(y)}.`, target: { node: node.id, property: 'position', value: { x: snap(x), y: snap(y) } } satisfies CanvasStyleTarget });
		}
		return out;
	}
};

/** The colours and fonts the canvas nodes use, for the shared checks. */
export function canvasStyleSurface(state: CanvasStyleState): StyleSurface {
	const colors: StyleSurfaceColor[] = [];
	const fonts: StyleSurface['fonts'] = [];
	for (const node of state.nodes) {
		const name = label(node);
		const fill = prop('fill');
		const stroke = prop('stroke');
		const text = prop('textColor');
		const fillValue = fill.appliesTo(node) ? fill.read(node) : undefined;
		if (typeof fillValue === 'string' && fillValue) colors.push({ color: fillValue, label: `${name} fill`, target: { node: node.id, property: 'fill' }, use: 'background' });
		const strokeValue = stroke.appliesTo(node) ? stroke.read(node) : undefined;
		if (typeof strokeValue === 'string' && strokeValue) colors.push({ color: strokeValue, label: `${name} stroke`, target: { node: node.id, property: 'stroke' }, use: 'stroke' });
		const textValue = text.appliesTo(node) ? text.read(node) : undefined;
		if (typeof textValue === 'string' && textValue) {
			const size = prop('fontSize').read(node);
			colors.push({ color: textValue, label: `${name} text`, target: { node: node.id, property: 'textColor' }, use: 'text', ...(typeof fillValue === 'string' && fillValue ? { background: fillValue } : {}), ...(typeof size === 'number' ? { fontSize: size } : {}) });
		}
		const family = readNodeStyleProperty(node.style, 'fontFamily');
		if (typeof family === 'string' && family) fonts.push({ family, label: name, target: { node: node.id, property: 'fontFamily' } });
	}
	return { colors, fonts };
}

/** The canvas house-style domain: register it with `createStyleResolver({ domains })`. */
export const canvasStyleDomain: StyleDomain<CanvasStyleState> = {
	id: 'canvas',
	title: 'Canvas',
	description: 'How canvas boards look: the corner radii, stroke widths and font sizes allowed, a position grid, and the colours and fonts nodes may use.',
	profileSchema: {
		type: 'object',
		properties: {
			cornerRadii: { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 1, description: 'Corner radii allowed, in flow units, e.g. [0, 4, 8].' },
			strokeWidths: { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 1, description: 'Stroke widths allowed, in flow units, e.g. [1, 2].' },
			fontSizes: { type: 'array', items: { type: 'number', exclusiveMinimum: 0 }, minItems: 1, description: 'Font sizes allowed, in px (a type scale), e.g. [12, 14, 16, 20, 24, 32].' },
			grid: { type: 'number', exclusiveMinimum: 0, description: 'Grid step for node positions, in flow units, e.g. 8.' },
			palette: { type: 'array', items: { type: 'string', minLength: 1, description: 'A CSS colour, or a { "$token": ... } reference.' }, description: 'Colours nodes may use (for palette-only). Default: the brand palette and roles.' },
			fonts: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Fonts nodes may use (for fonts-allowed). Default: the brand fonts.' }
		},
		additionalProperties: false
	},
	checks: [allowedValues('corner-radii', 'cornerRadius', 'cornerRadii', 'Corner radii', 'flow units'), allowedValues('stroke-widths', 'strokeWidth', 'strokeWidths', 'Stroke widths', 'flow units'), allowedValues('font-sizes', 'fontSize', 'fontSizes', 'Font sizes', 'px'), grid],
	surface: canvasStyleSurface,
	themeFromBrand: (brand) => {
		const palette = brandPalette(brand);
		const fonts = brandFonts(brand);
		return { ...(palette.length ? { palette } : {}), ...(fonts.length ? { fonts } : {}) };
	},
	example: {
		cornerRadii: [0, 4, 8],
		strokeWidths: [1, 2],
		fontSizes: [12, 14, 16, 20, 24, 32],
		grid: 8,
		checks: ['corner-radii', 'stroke-widths', 'font-sizes', 'grid', 'palette-only', 'min-contrast']
	}
};

export interface CanvasStyleToolProviderOptions<TNode extends CanvasNode = CanvasNode> {
	/** The canvas nodes (as `createCanvasArrangeController` takes them). */
	getNodes: () => TNode[];
	/** Replaces the nodes (one call per fix, so one render). */
	setNodes: (nodes: TNode[]) => void;
	/** When set, `fix_canvas_style` is recorded as one undoable command. */
	history?: ArrangeHistoryTarget;
	/** Provider id (unique per registry). Default `canvas-style`. */
	id?: string;
	/** Tool-name prefix; defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Where the tools work: skills scoped elsewhere do not apply. Set by the host. */
	scope?: string;
	/** The canvas cannot be changed: `fix_canvas_style` is hidden (a string is the reason). */
	readOnly?: boolean | string | (() => boolean | string);
}

/**
 * `check_canvas_style` and, while the canvas is editable, `fix_canvas_style` (snaps radii,
 * stroke widths, font sizes and positions to the house values, as one undo step).
 */
export function createCanvasStyleToolProvider<TNode extends CanvasNode>(styles: StyleResolver, options: CanvasStyleToolProviderOptions<TNode>): AgentToolProvider {
	if (!styles.domains.some((d) => d.id === 'canvas')) throw new Error('The style resolver has no "canvas" domain; add canvasStyleDomain to its domains.');
	const scope = options.scope !== undefined ? { scope: options.scope } : {};
	const readOnlyReason = (): string | null => {
		const r = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		if (!r) return null;
		return typeof r === 'string' ? r : 'This canvas is read-only.';
	};
	const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
	const run = () => styles.check('canvas', { nodes: options.getNodes() } satisfies CanvasStyleState, scope);
	const certain = (f: StyleFinding) => (f.target as CanvasStyleTarget | undefined)?.value !== undefined;

	const check: AgentTool = {
		name: 'check_canvas_style',
		title: 'Check canvas house style',
		description:
			'Checks the canvas against the house style (see get_style with domain "canvas"): runs the checks its profile turns on (corner-radii, stroke-widths, font-sizes, grid, and the brand\'s palette-only, min-contrast and fonts-allowed on fills, strokes, text colours and fonts). Returns findings with a severity, a sentence saying how to fix it, a target { node, property, value? } (the value to set when the fix is certain) and the layer that asked; the checks that ran and those skipped. fix_canvas_style applies the certain fixes at once.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Check canvas house style', ...READ },
		handler: async () => {
			const { style, ...report } = await run();
			return {
				...report,
				ok: report.findings.length === 0,
				fixable: report.findings.filter(certain).length,
				...(style.skills.length ? {} : { note: 'No house style applies to the canvas.' }),
				...(style.issues.length ? { issues: style.issues } : {})
			};
		}
	};

	const fix: AgentTool = {
		name: 'fix_canvas_style',
		title: 'Fix canvas house style',
		description:
			'Applies every certain house-style fix as one undo step: corner radii, stroke widths and font sizes snapped to the nearest house value, and positions snapped to the grid. Returns how many it fixed and the findings left for you (colours and fonts: change them with the canvas tools). Run check_canvas_style after.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Fix canvas house style', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: async () => {
			const reason = readOnlyReason();
			if (reason) throw new Error(reason);
			const { findings } = await run();
			const before = options.getNodes();
			const byId = new Map(before.map((n) => [n.id, n as CanvasNode]));
			let fixed = 0;
			const left: StyleFinding[] = [];
			for (const f of findings) {
				const t = f.target as CanvasStyleTarget | undefined;
				const node = t ? byId.get(t.node) : undefined;
				if (!t || t.value === undefined || !node) {
					left.push(f);
					continue;
				}
				if (t.property === 'position' && typeof t.value === 'object') byId.set(node.id, { ...node, position: { ...t.value } });
				else {
					const p = CANVAS_TOKEN_PROPERTIES.find((x) => x.key === t.property);
					if (!p || typeof t.value !== 'number') {
						left.push(f);
						continue;
					}
					byId.set(node.id, p.write(node, t.value));
				}
				fixed++;
			}
			if (fixed) {
				const after = before.map((n) => byId.get(n.id) as TNode);
				const apply = () => options.setNodes(after);
				const undo = () => options.setNodes(before);
				if (options.history) options.history.execute({ name: 'Apply house style', execute: apply, undo });
				else apply();
			}
			return { fixed, left };
		}
	};

	return {
		id: options.id ?? 'canvas-style',
		namespace: options.namespace,
		title: 'Canvas house style',
		description: 'Check a canvas against the house style and apply its certain fixes.',
		skill: 'pixerate-canvas',
		tools: () => (readOnlyReason() ? [check] : [check, fix])
	};
}
