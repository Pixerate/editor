/**
 * House style for diagrams (#779): the `diagram.json` profile (layout direction, label case and
 * length, the node shapes allowed, a size limit, the colours and fonts node styles may use),
 * its checks, and `check_diagram_style` / `fix_diagram_style`.
 *
 * The domain works on the family-independent `DiagramGraph`. Findings target a node, edge or
 * group by id (`{ node: "A" }`), with the certain fix (`label`, `direction`) when there is one.
 */
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { StyleCheck, StyleDomain, StyleFinding, StyleResolver } from '../tools/style.js';
import type { StyleSurface, StyleSurfaceColor } from '../tools/style-surface.js';
import { brandFonts, brandPalette } from '../tools/brand.js';
import { TEXT_CASES, applyTextCase } from '../tools/text-case.js';
import { DIRECTIONS, type DiagramGraph, type EditOp } from './types.js';
import type { DiagramController } from './controller.js';

type Finding = Omit<StyleFinding, 'check' | 'layer'>;

/** The `diagram.json` profile, after `$token` references are resolved. */
export interface DiagramStyleProfile {
	/** Layout directions allowed (the first is the house default), e.g. ["LR"]. */
	directions?: string[];
	labelCase?: 'sentence' | 'title' | 'upper';
	properNouns?: string[];
	/** Longest node or edge label, in characters. */
	maxLabelLength?: number;
	/** Most nodes in one diagram (split bigger ones). */
	maxNodes?: number;
	/** Node shapes allowed (`rect`, `diam`, `cyl`, ...). */
	shapes?: string[];
	/** Colours node and edge styles may use (for palette-only). Default: the brand's. */
	palette?: string[];
	/** Fonts allowed in styles (for fonts-allowed). Default: the brand's. */
	fonts?: string[];
}

/** A finding's target: a node, edge or group, or the diagram, with the certain fix. */
export type DiagramStyleTarget = { node: string; label?: string } | { edge: string; label?: string } | { group: string; label?: string } | { diagram: true; direction?: string };

const profileOf = (p: Readonly<Record<string, unknown>>) => p as DiagramStyleProfile;
const plain = (label: string) => label.replace(/^"|"$/g, '').replace(/^`|`$/g, '');

const direction: StyleCheck<DiagramGraph> = {
	id: 'direction',
	description: 'The diagram flows in a house direction ("directions": the first is the default), e.g. ["LR"]. TD and TB count as the same.',
	run(graph, profile) {
		const allowed = profileOf(profile).directions;
		if (!allowed?.length) throw new Error('the profile has no "directions".');
		const norm = (d: string) => (d === 'TD' ? 'TB' : d);
		if (!graph.direction || allowed.map(norm).includes(norm(graph.direction))) return [];
		return [{ severity: 'warning' as const, message: `The diagram flows ${graph.direction}; the house style uses ${allowed.join(' or ')}. Set it with set_diagram_direction.`, target: { diagram: true, direction: allowed[0] } satisfies DiagramStyleTarget }];
	}
};

const labelCase: StyleCheck<DiagramGraph> = {
	id: 'label-case',
	description: 'Node, group and edge labels use the house case ("labelCase"), keeping acronyms, words with digits and "properNouns". Markdown and quoted labels are compared as text.',
	run(graph, profile) {
		const { labelCase: kind, properNouns = [] } = profileOf(profile);
		if (!kind) throw new Error('the profile has no "labelCase".');
		const out: Finding[] = [];
		const one = (label: string | undefined, target: (fixed: string) => DiagramStyleTarget, what: string) => {
			if (!label?.trim() || /[<{[]/.test(label)) return;
			const text = plain(label);
			const want = applyTextCase(text, kind, properNouns);
			if (want !== text) out.push({ severity: 'info' as const, message: `${what} "${text}" is not in ${kind} case; write "${want}".`, target: target(want) });
		};
		for (const n of graph.nodes) if (n.label !== n.id) one(n.label, (label) => ({ node: n.id, label }), `Node ${n.id}`);
		for (const g of graph.groups) one(g.label, (label) => ({ group: g.id, label }), `Group ${g.id}`);
		for (const e of graph.edges) one(e.label, (label) => ({ edge: e.id, label }), `Edge ${e.id}`);
		return out;
	}
};

const labelLength: StyleCheck<DiagramGraph> = {
	id: 'label-length',
	description: 'Labels stay short ("maxLabelLength" characters): long text belongs in a note or the document around the diagram.',
	run(graph, profile) {
		const max = profileOf(profile).maxLabelLength;
		if (!max) throw new Error('the profile has no "maxLabelLength".');
		const out: Finding[] = [];
		for (const n of graph.nodes) if (plain(n.label).length > max) out.push({ severity: 'warning' as const, message: `Node ${n.id} has a ${plain(n.label).length}-character label; keep labels to ${max}.`, target: { node: n.id } satisfies DiagramStyleTarget });
		for (const e of graph.edges) if (e.label && plain(e.label).length > max) out.push({ severity: 'warning' as const, message: `Edge ${e.id} has a ${plain(e.label).length}-character label; keep labels to ${max}.`, target: { edge: e.id } satisfies DiagramStyleTarget });
		return out;
	}
};

const maxNodes: StyleCheck<DiagramGraph> = {
	id: 'max-nodes',
	description: 'A diagram has at most "maxNodes" nodes; split a bigger one or group its parts.',
	run(graph, profile) {
		const max = profileOf(profile).maxNodes;
		if (!max) throw new Error('the profile has no "maxNodes".');
		if (graph.nodes.length <= max) return [];
		return [{ severity: 'warning' as const, message: `The diagram has ${graph.nodes.length} nodes; the house style keeps diagrams to ${max}. Split it or group nodes.`, target: { diagram: true } satisfies DiagramStyleTarget }];
	}
};

const allowedShapes: StyleCheck<DiagramGraph> = {
	id: 'allowed-shapes',
	description: 'Nodes use only the house shapes ("shapes", e.g. ["rect", "diam", "cyl"]).',
	run(graph, profile) {
		const shapes = profileOf(profile).shapes;
		if (!shapes?.length) throw new Error('the profile has no "shapes".');
		return graph.nodes
			.filter((n) => !shapes.includes(n.shape))
			.map((n) => ({ severity: 'warning' as const, message: `Node ${n.id} is a ${n.shape}; the house shapes are ${shapes.join(', ')}. Change it with set_diagram_node_shape.`, target: { node: n.id } satisfies DiagramStyleTarget }));
	}
};

/** `fill:#fff` style declarations as a map. */
const declarations = (styles: readonly string[]) => {
	const out: Record<string, string> = {};
	for (const s of styles) {
		const i = s.indexOf(':');
		if (i > 0) out[s.slice(0, i).trim().toLowerCase()] = s.slice(i + 1).trim().replace(/\s*!important$/, '');
	}
	return out;
};

/** The colours and fonts a diagram's node, group and edge styles (and their classes) use. */
export function diagramStyleSurface(graph: DiagramGraph): StyleSurface {
	const colors: StyleSurfaceColor[] = [];
	const fonts: StyleSurface['fonts'] = [];
	const add = (styles: readonly string[], classes: readonly string[], label: string, target: DiagramStyleTarget) => {
		const d = { ...Object.assign({}, ...classes.map((c) => declarations(graph.classDefs[c] ?? []))), ...declarations(styles) } as Record<string, string>;
		if (d.fill) colors.push({ color: d.fill, label: `${label} fill`, target, use: 'background' });
		if (d.stroke) colors.push({ color: d.stroke, label: `${label} stroke`, target, use: 'stroke' });
		if (d.color) colors.push({ color: d.color, label: `${label} text`, target, use: 'text', ...(d.fill ? { background: d.fill } : {}) });
		if (d['font-family']) fonts.push({ family: d['font-family'], label, target });
	};
	for (const n of graph.nodes) add(n.styles, n.classes, `Node ${n.id}`, { node: n.id });
	for (const g of graph.groups) add(g.styles, g.classes, `Group ${g.id}`, { group: g.id });
	for (const e of graph.edges) add(e.styles, e.classes, `Edge ${e.id}`, { edge: e.id });
	return { colors, fonts };
}

/** The diagram house-style domain: register it with `createStyleResolver({ domains })`. */
export const diagramStyleDomain: StyleDomain<DiagramGraph> = {
	id: 'diagram',
	title: 'Diagrams',
	description: 'How diagrams read: layout direction, label case and length, the node shapes allowed, a size limit, and the colours and fonts node styles may use.',
	profileSchema: {
		type: 'object',
		properties: {
			directions: { type: 'array', items: { type: 'string', enum: [...DIRECTIONS] }, minItems: 1, description: 'Layout directions allowed; the first is the house default.' },
			labelCase: { type: 'string', enum: [...TEXT_CASES], description: 'Case for labels: "sentence", "title" or "upper".' },
			properNouns: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Names written exactly as given in any label case.' },
			maxLabelLength: { type: 'integer', minimum: 4, maximum: 200, description: 'Longest label, in characters.' },
			maxNodes: { type: 'integer', minimum: 2, maximum: 1000, description: 'Most nodes in one diagram.' },
			shapes: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, description: 'Node shapes allowed (rect, round, stadium, diam, hex, cyl, circle, ...).' },
			palette: { type: 'array', items: { type: 'string', minLength: 1, description: 'A CSS colour, or a { "$token": ... } reference.' }, description: 'Colours styles may use (for palette-only). Default: the brand palette and roles.' },
			fonts: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Fonts styles may use (for fonts-allowed). Default: the brand fonts.' }
		},
		additionalProperties: false
	},
	checks: [direction, labelCase, labelLength, maxNodes, allowedShapes],
	surface: diagramStyleSurface,
	themeFromBrand: (brand) => {
		const palette = brandPalette(brand);
		const fonts = brandFonts(brand);
		return { ...(palette.length ? { palette } : {}), ...(fonts.length ? { fonts } : {}) };
	},
	example: {
		directions: ['LR', 'TB'],
		labelCase: 'sentence',
		maxLabelLength: 40,
		maxNodes: 25,
		shapes: ['rect', 'round', 'diam', 'cyl', 'stadium'],
		checks: ['direction', 'label-case', 'label-length', 'max-nodes', 'allowed-shapes', 'palette-only', 'min-contrast']
	}
};

export interface DiagramStyleToolProviderOptions {
	/** Provider id (unique per registry). Default `diagram-style`. */
	id?: string;
	/** Tool-name prefix; defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Where the tools work (`report`, ...): skills scoped elsewhere do not apply. Set by the host. */
	scope?: string;
	/** The diagram cannot be changed: `fix_diagram_style` is hidden (a string is the reason). The controller's own read-only state counts too. */
	readOnly?: boolean | string | (() => boolean | string);
}

/**
 * `check_diagram_style` and, while the diagram is editable, `fix_diagram_style` (applies the
 * certain fixes, label case and direction, as one undo step).
 */
export function createDiagramStyleToolProvider(controller: DiagramController, styles: StyleResolver, options: DiagramStyleToolProviderOptions = {}): AgentToolProvider {
	if (!styles.domains.some((d) => d.id === 'diagram')) throw new Error('The style resolver has no "diagram" domain; add diagramStyleDomain to its domains.');
	const scope = options.scope !== undefined ? { scope: options.scope } : {};
	const readOnlyReason = (): string | null => {
		const r = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		if (r) return typeof r === 'string' ? r : 'This diagram is read-only.';
		return controller.getState().editable ? null : 'This diagram cannot be edited here.';
	};
	const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
	const run = () => styles.check('diagram', controller.getDocument().graph, scope);
	const opFor = (t: DiagramStyleTarget | undefined): EditOp | undefined => {
		if (!t) return undefined;
		if ('node' in t && t.label !== undefined) return { type: 'renameNode', id: t.node, label: t.label };
		if ('group' in t && t.label !== undefined) return { type: 'renameGroup', id: t.group, label: t.label };
		if ('edge' in t && t.label !== undefined) return { type: 'setEdgeLabel', id: t.edge, label: t.label };
		if ('diagram' in t && t.direction !== undefined) return { type: 'setDirection', direction: t.direction };
		return undefined;
	};

	const check: AgentTool = {
		name: 'check_diagram_style',
		title: 'Check diagram house style',
		description:
			'Checks the diagram against the house style (see get_style with domain "diagram"): runs the checks its profile turns on (direction, label-case, label-length, max-nodes, allowed-shapes, and the brand\'s palette-only, min-contrast and fonts-allowed on node styles). Returns findings with a severity, a sentence saying how to fix it, a target ({ node | edge | group: id } with the label to set when certain, or { diagram: true } with the direction) and the layer that asked; the checks that ran and those skipped. fix_diagram_style applies the certain fixes at once.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Check diagram house style', ...READ },
		handler: async () => {
			const { style, ...report } = await run();
			return {
				...report,
				ok: report.findings.length === 0,
				fixable: report.findings.filter((f) => opFor(f.target as DiagramStyleTarget)).length,
				...(style.skills.length ? {} : { note: 'No house style applies to diagrams.' }),
				...(style.issues.length ? { issues: style.issues } : {})
			};
		}
	};

	const fix: AgentTool = {
		name: 'fix_diagram_style',
		title: 'Fix diagram house style',
		description:
			'Applies every certain house-style fix as one undo step: labels in the house case and the house direction. Returns how many it fixed and the findings left for you (long labels, too many nodes, other shapes, colours: fix those with the diagram tools). Run check_diagram_style after.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Fix diagram house style', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: async () => {
			const reason = readOnlyReason();
			if (reason) throw new Error(reason);
			const { findings } = await run();
			const ops: EditOp[] = [];
			const left: StyleFinding[] = [];
			for (const f of findings) {
				const op = opFor(f.target as DiagramStyleTarget);
				if (op) ops.push(op);
				else left.push(f);
			}
			if (ops.length) {
				const result = controller.apply(ops, 'Apply house style');
				if (!result.ok) throw new Error(`The house style could not be applied: ${result.message}`);
			}
			return { fixed: ops.length, left };
		}
	};

	return {
		id: options.id ?? 'diagram-style',
		namespace: options.namespace,
		title: 'Diagram house style',
		description: 'Check a diagram against the house style and apply its certain fixes.',
		skill: 'pixerate-diagram',
		tools: () => (readOnlyReason() ? [check] : [check, fix]),
		subscribe: (notify) => {
			let last = readOnlyReason();
			return controller.subscribe(() => {
				const now = readOnlyReason();
				if (now !== last) {
					last = now;
					notify();
				}
			});
		}
	};
}
