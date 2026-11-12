/**
 * House style for vector drawings (#779): the `vector.json` profile (the stroke widths and corner
 * radii allowed, and the colours and fonts art may use), its checks, and `check_vector_style` /
 * `fix_vector_style`.
 *
 * Findings target a node by id with the property and, when the fix is certain, the house value:
 * `{ node, property: "strokeWidth", value }`, `{ node, property: "corner", subpath, anchor, value }`,
 * `{ node, property: "fill" | "stroke" | "fontFamily" }`, or `{ background: true }`.
 */
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { StyleCheck, StyleDomain, StyleFinding, StyleResolver } from '../tools/style.js';
import type { StyleSurface, StyleSurfaceColor, StyleSurfaceFont } from '../tools/style-surface.js';
import { brandFonts, brandPalette } from '../tools/brand.js';
import { walkVectorNodes } from './geometry.js';
import type { VectorEditorController, VectorEditorState } from './controller.js';
import type { VectorDocument, VectorNode, VectorPaint, VectorPathNode, VectorTextNode } from './types.js';

type Finding = Omit<StyleFinding, 'check' | 'layer'>;

/** What the vector house-style checks read: the document (`VectorEditorState` is one). */
export interface VectorStyleState {
	document: VectorDocument;
}

/** The `vector.json` profile, after `$token` references are resolved. */
export interface VectorStyleProfile {
	/** Stroke widths allowed, in document units. */
	strokeWidths?: number[];
	/** Corner radii allowed (live corners), in document units. 0 (sharp) is always allowed. */
	cornerRadii?: number[];
	/** Colours art may use (for palette-only). Default: the brand's. */
	palette?: string[];
	/** Fonts text may use (for fonts-allowed). Default: the brand's. */
	fonts?: string[];
}

/** A finding's target. */
export type VectorStyleTarget =
	| { node: string; property: 'strokeWidth'; value?: number }
	| { node: string; property: 'corner'; subpath: number; anchor: number; value?: number }
	| { node: string; property: 'fill' | 'stroke' | 'fontFamily' }
	| { background: true };

const profileOf = (p: Readonly<Record<string, unknown>>) => p as VectorStyleProfile;
const nearest = (value: number, allowed: readonly number[]) => allowed.reduce((best, a) => (Math.abs(a - value) < Math.abs(best - value) ? a : best), allowed[0]);
const solid = (paint: VectorPaint | undefined): string | null => (typeof paint === 'string' && paint && paint !== 'none' && paint !== 'transparent' ? paint : null);
const hasStroke = (paint: VectorPaint | undefined) => paint !== undefined && paint !== null && paint !== 'none' && paint !== 'transparent';
const labelOf = (n: VectorNode) => (n.name ? `${n.type === 'text' ? 'Text' : 'Node'} ${n.id} ("${n.name}")` : `${n.type === 'text' ? 'Text' : 'Node'} ${n.id}`);
const painted = (n: VectorNode): n is VectorPathNode | VectorTextNode => n.type === 'path' || n.type === 'text';

const strokeWidths: StyleCheck<VectorStyleState> = {
	id: 'stroke-widths',
	description: 'Stroked paths and text use a house stroke width ("strokeWidths", in document units; the nearest is the fix).',
	run(state, profile) {
		const allowed = profileOf(profile).strokeWidths;
		if (!allowed?.length) throw new Error('the profile has no "strokeWidths".');
		const out: Finding[] = [];
		walkVectorNodes(state.document.nodes, (n) => {
			if (!painted(n) || !hasStroke(n.stroke)) return;
			const width = n.strokeWidth ?? 1;
			if (allowed.includes(width)) return;
			const want = nearest(width, allowed);
			out.push({ severity: 'warning' as const, message: `${labelOf(n)} has a ${width} stroke; the house widths are ${allowed.join(', ')}. Use ${want}.`, target: { node: n.id, property: 'strokeWidth', value: want } satisfies VectorStyleTarget });
		});
		return out;
	}
};

const cornerRadii: StyleCheck<VectorStyleState> = {
	id: 'corner-radii',
	description: 'Live corners use a house radius ("cornerRadii", in document units; sharp corners are always allowed, and the nearest is the fix).',
	run(state, profile) {
		const allowed = profileOf(profile).cornerRadii;
		if (!allowed?.length) throw new Error('the profile has no "cornerRadii".');
		const out: Finding[] = [];
		walkVectorNodes(state.document.nodes, (n) => {
			if (n.type !== 'path') return;
			const off: { subpath: number; anchor: number; radius: number }[] = [];
			n.subpaths.forEach((sp, s) =>
				sp.anchors.forEach((a, i) => {
					const r = a.corner?.radius ?? 0;
					if (r > 0 && !allowed.includes(r)) off.push({ subpath: s, anchor: i, radius: r });
				})
			);
			for (const o of off) {
				const want = nearest(o.radius, allowed);
				out.push({ severity: 'warning' as const, message: `${labelOf(n)} has a corner of radius ${o.radius} (subpath ${o.subpath}, anchor ${o.anchor}); the house radii are ${allowed.join(', ')}. Use ${want}.`, target: { node: n.id, property: 'corner', subpath: o.subpath, anchor: o.anchor, value: want } satisfies VectorStyleTarget });
			}
		});
		return out;
	}
};

/** The solid colours and fonts the drawing uses, for the shared checks. */
export function vectorStyleSurface(state: VectorStyleState): StyleSurface {
	const colors: StyleSurfaceColor[] = [];
	const fonts: StyleSurfaceFont[] = [];
	const background = solid(state.document.background);
	if (background) colors.push({ color: background, label: 'The artboard', target: { background: true } satisfies VectorStyleTarget, use: 'background' });
	walkVectorNodes(state.document.nodes, (n) => {
		if (!painted(n) || n.visible === false) return;
		const fill = solid(n.fill);
		const stroke = solid(n.stroke);
		if (n.type === 'text') {
			if (fill) colors.push({ color: fill, label: labelOf(n), target: { node: n.id, property: 'fill' } satisfies VectorStyleTarget, use: 'text', ...(background ? { background } : {}), fontSize: n.font.fontSize, bold: n.font.fontWeight >= 600 });
			fonts.push({ family: n.font.fontFamily, label: labelOf(n), target: { node: n.id, property: 'fontFamily' } satisfies VectorStyleTarget });
		} else if (fill) colors.push({ color: fill, label: labelOf(n), target: { node: n.id, property: 'fill' } satisfies VectorStyleTarget, use: 'fill' });
		if (stroke) colors.push({ color: stroke, label: `${labelOf(n)} stroke`, target: { node: n.id, property: 'stroke' } satisfies VectorStyleTarget, use: 'stroke' });
	});
	return { colors, fonts };
}

/** The vector house-style domain: register it with `createStyleResolver({ domains })`. */
export const vectorStyleDomain: StyleDomain<VectorStyleState> = {
	id: 'vector',
	title: 'Vector drawings',
	description: 'How vector art is drawn: the stroke widths and corner radii allowed, and the colours and fonts art may use.',
	profileSchema: {
		type: 'object',
		properties: {
			strokeWidths: { type: 'array', items: { type: 'number', exclusiveMinimum: 0 }, minItems: 1, description: 'Stroke widths allowed, in document units.' },
			cornerRadii: { type: 'array', items: { type: 'number', exclusiveMinimum: 0 }, minItems: 1, description: 'Corner radii allowed for live corners, in document units (sharp corners are always allowed).' },
			palette: { type: 'array', items: { type: 'string', minLength: 1, description: 'A CSS colour, or a { "$token": ... } reference.' }, description: 'Colours art may use (for palette-only). Default: the brand palette and roles.' },
			fonts: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Font families text may use (for fonts-allowed). Default: the brand fonts.' }
		},
		additionalProperties: false
	},
	checks: [strokeWidths, cornerRadii],
	surface: vectorStyleSurface,
	themeFromBrand: (brand) => {
		const palette = brandPalette(brand);
		const fonts = brandFonts(brand);
		return { ...(palette.length ? { palette } : {}), ...(fonts.length ? { fonts } : {}) };
	},
	example: {
		strokeWidths: [1, 2, 4],
		cornerRadii: [4, 8],
		checks: ['stroke-widths', 'corner-radii', 'palette-only', 'fonts-allowed']
	}
};

export interface VectorStyleToolProviderOptions {
	/** Provider id (unique per registry). Default `vector-style`. */
	id?: string;
	/** Tool-name prefix; defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Where the tools work: skills scoped elsewhere do not apply. Set by the host. */
	scope?: string;
	/** The drawing cannot be changed: `fix_vector_style` is hidden (a string is the reason). */
	readOnly?: boolean | string | (() => boolean | string);
}

/** The document with the certain fixes applied (stroke widths and corner radii by node id). */
function withFixes(doc: VectorDocument, widths: ReadonlyMap<string, number>, corners: ReadonlyMap<string, { subpath: number; anchor: number; value: number }[]>): VectorDocument {
	const map = (nodes: VectorNode[]): VectorNode[] =>
		nodes.map((n) => {
			let next: VectorNode = n;
			if (painted(n) && widths.has(n.id)) next = { ...n, strokeWidth: widths.get(n.id)! };
			const fix = corners.get(n.id);
			if (fix && next.type === 'path') {
				const p = next;
				next = {
					...p,
					subpaths: p.subpaths.map((sp, s) => ({
						...sp,
						anchors: sp.anchors.map((a, i) => {
							const f = fix.find((c) => c.subpath === s && c.anchor === i);
							return f && a.corner ? { ...a, corner: { ...a.corner, radius: f.value } } : a;
						})
					}))
				};
			}
			if (next.type === 'group') next = { ...next, children: map(next.children) };
			return next;
		});
	return { ...doc, nodes: map(doc.nodes) };
}

/**
 * `check_vector_style` and, while the drawing is editable, `fix_vector_style` (snaps stroke widths
 * and corner radii to the house values as one undo step).
 */
export function createVectorStyleToolProvider(controller: VectorEditorController, styles: StyleResolver, options: VectorStyleToolProviderOptions = {}): AgentToolProvider {
	if (!styles.domains.some((d) => d.id === 'vector')) throw new Error('The style resolver has no "vector" domain; add vectorStyleDomain to its domains.');
	const scope = options.scope !== undefined ? { scope: options.scope } : {};
	const readOnlyReason = (): string | null => {
		const r = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		if (!r) return null;
		return typeof r === 'string' ? r : 'This drawing is read-only.';
	};
	const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
	const run = () => styles.check('vector', controller.getState() as VectorEditorState, scope);

	const check: AgentTool = {
		name: 'check_vector_style',
		title: 'Check vector house style',
		description:
			'Checks the drawing against the house style (see get_style with domain "vector"): stroke-widths, corner-radii, and the brand\'s palette-only, min-contrast and fonts-allowed on solid fills, strokes, text and the artboard. Returns findings with a severity, a sentence saying how to fix it, a target ({ node, property: "strokeWidth", value } or { node, property: "corner", subpath, anchor, value } with the house value; { node, property: "fill" | "stroke" | "fontFamily" }; or { background: true }) and the layer that asked; the checks that ran and those skipped. fix_vector_style applies the certain fixes at once; recolour with vector.setStyle.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Check vector house style', ...READ },
		handler: async () => {
			const { style, ...report } = await run();
			return {
				...report,
				ok: report.findings.length === 0,
				...(style.skills.length ? {} : { note: 'No house style applies to vector drawings.' }),
				...(style.issues.length ? { issues: style.issues } : {})
			};
		}
	};

	const fix: AgentTool = {
		name: 'fix_vector_style',
		title: 'Fix vector house style',
		description:
			'Snaps every stroke width and live corner radius the house style names to its house value, as one undo step; colours and fonts are left for you (vector.setStyle, vector.setTextStyle). Returns { strokeWidths: { nodeId: width }, corners: [{ node, subpath, anchor, value }], left: findings it did not fix }. Run check_vector_style after.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Fix vector house style', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: async () => {
			const reason = readOnlyReason();
			if (reason) throw new Error(reason);
			const { findings } = await run();
			const widths = new Map<string, number>();
			const corners = new Map<string, { subpath: number; anchor: number; value: number }[]>();
			const left: StyleFinding[] = [];
			for (const f of findings) {
				const t = f.target as VectorStyleTarget | undefined;
				if (t && 'property' in t && t.property === 'strokeWidth' && t.value !== undefined) widths.set(t.node, t.value);
				else if (t && 'property' in t && t.property === 'corner' && t.value !== undefined) corners.set(t.node, [...(corners.get(t.node) ?? []), { subpath: t.subpath, anchor: t.anchor, value: t.value }]);
				else left.push(f);
			}
			if (widths.size || corners.size) {
				const selection = controller.getState().selection;
				controller.setDocument(withFixes(controller.getDocument(), widths, corners), { label: 'Apply House Style' });
				if (selection.length) controller.select(selection);
			}
			return { strokeWidths: Object.fromEntries(widths), corners: [...corners].flatMap(([node, list]) => list.map((c) => ({ node, ...c }))), left };
		}
	};

	return {
		id: options.id ?? 'vector-style',
		namespace: options.namespace,
		title: 'Vector house style',
		description: 'Check a vector drawing against the house style and snap stroke widths and corner radii to the house values.',
		skill: 'pixerate-vector',
		tools: () => (readOnlyReason() ? [check] : [check, fix])
	};
}
