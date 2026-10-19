// Family drawings follow Ursula's family canvases (src/react/canvases/*.tsx and
// src/react/canvas/familyCanvas.ts), drawn as framework-free marks so React, Svelte and the
// SVG export share one renderer per family.
import type { DiagramFamily, DiagramGraph, EditOp, MermaidDocument } from '../../diagram/types.js';
import { ensureDiagramLayout, type DiagramLayout, type DiagramLayoutOptions } from './layout.js';
import { BUILTIN_FAMILY_SCENES } from './families/index.js';
import { DIAGRAM_SCENE_LIGHT_THEME, DIAGRAM_TITLE_TARGET, estimateTextWidth, type DiagramMark, type DiagramSceneOptions, type DiagramScene, type DiagramSceneTheme, type DiagramTextMark, type FamilyScene } from './scene-kit.js';

export * from './scene-kit.js';

// Seeded from a static map (not self-registering modules): the package is `sideEffects: false`.
const scenes = new Map<DiagramFamily, FamilyScene>(Object.entries(BUILTIN_FAMILY_SCENES) as [DiagramFamily, FamilyScene][]);

/** Registers (or replaces) the drawing for a family. */
export function registerFamilyScene(family: DiagramFamily, scene: FamilyScene): void {
	scenes.set(family, scene);
}

export function getFamilyScene(family: DiagramFamily): FamilyScene | undefined {
	return scenes.get(family);
}

/** Whether a family is drawn as a scene (its own picture) instead of nodes and edges. */
export function hasFamilyScene(family: DiagramFamily): boolean {
	return scenes.has(family);
}

function markBounds(mark: DiagramMark): [number, number, number, number] | null {
	switch (mark.kind) {
		case 'rect':
			return [mark.x, mark.y, mark.x + mark.width, mark.y + mark.height];
		case 'circle':
			return [mark.cx - mark.r, mark.cy - mark.r, mark.cx + mark.r, mark.cy + mark.r];
		case 'line':
			return [Math.min(mark.x1, mark.x2), Math.min(mark.y1, mark.y2), Math.max(mark.x1, mark.x2), Math.max(mark.y1, mark.y2)];
		case 'text': {
			const w = estimateTextWidth(mark.text, mark.size);
			const x0 = mark.anchor === 'start' ? mark.x : mark.anchor === 'end' ? mark.x - w : mark.x - w / 2;
			const y0 = mark.baseline === 'top' ? mark.y : mark.baseline === 'bottom' ? mark.y - mark.size * 1.2 : mark.y - mark.size * 0.6;
			if (mark.rotate) {
				const r = Math.max(w, mark.size * 1.2);
				return [mark.x - r, mark.y - r, mark.x + r, mark.y + r];
			}
			return [x0, y0, x0 + w, y0 + mark.size * 1.2];
		}
		case 'path': {
			if (mark.box) return [mark.box.x, mark.box.y, mark.box.x + mark.box.width, mark.box.y + mark.box.height];
			// Absolute M / L / C / Q / Z paths list x, y pairs; arcs must give `box`.
			const nums = mark.d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi)?.map(Number) ?? [];
			if (nums.length < 2) return null;
			let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
			for (let i = 0; i + 1 < nums.length; i += 2) {
				x0 = Math.min(x0, nums[i]!);
				y0 = Math.min(y0, nums[i + 1]!);
				x1 = Math.max(x1, nums[i]!);
				y1 = Math.max(y1, nums[i + 1]!);
			}
			return [x0, y0, x1, y1];
		}
	}
}

/** Bounds of a list of marks (all zero when empty). */
export function diagramMarksBounds(marks: readonly DiagramMark[]): { x: number; y: number; width: number; height: number } {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const mark of marks) {
		const b = markBounds(mark);
		if (!b) continue;
		x0 = Math.min(x0, b[0]);
		y0 = Math.min(y0, b[1]);
		x1 = Math.max(x1, b[2]);
		y1 = Math.max(y1, b[3]);
	}
	if (x0 === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export interface MermaidSceneOptions extends DiagramSceneOptions, DiagramLayoutOptions {
	/** A layout to draw instead of computing one. */
	layout?: DiagramLayout;
}

/**
 * Draws a document as its family's own picture (pie wedges, Gantt bars on a date axis,
 * sequence lifelines, XY and radar charts…). Returns null for families drawn as plain nodes
 * and edges (flowchart, state, class, ER) and for text-only families.
 */
export function mermaidToScene(doc: MermaidDocument, options: MermaidSceneOptions = {}): DiagramScene | null {
	const scene = scenes.get(doc.family);
	if (!scene || doc.tier !== 'editable') return null;
	const layout = options.layout ?? ensureDiagramLayout(doc.graph, doc.meta, { family: doc.family, ...options });
	return familySceneFromLayout(doc.family, doc.graph, layout, options);
}

/** {@link mermaidToScene} for a graph and layout already at hand (e.g. a tween frame). */
export function familySceneFromLayout(
	family: DiagramFamily,
	graph: DiagramGraph,
	layout: DiagramLayout,
	options: DiagramSceneOptions = {}
): DiagramScene | null {
	const scene = scenes.get(family);
	if (!scene) return null;
	const theme = { ...DIAGRAM_SCENE_LIGHT_THEME, ...options.theme };
	const selection = new Set(options.selection ?? []);
	const marks = scene({ graph, layout, theme, selection }).map((m) => (m.target && selection.has(m.target) ? { ...m, selected: true } : m));
	return { family, ...diagramMarksBounds(marks), marks };
}

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v: number) => String(Math.round(v * 100) / 100);

/** SVG `dominant-baseline` for a text mark's baseline. */
export function diagramTextBaseline(baseline: DiagramTextMark['baseline']): 'hanging' | 'central' | 'text-after-edge' {
	return baseline === 'top' ? 'hanging' : baseline === 'bottom' ? 'text-after-edge' : 'central';
}

/** Ids the SVG export uses for arrow markers (`<defs>` holds both). */
export const DIAGRAM_MARKER_IDS = { arrow: 'pd-arrow-open', arrowclosed: 'pd-arrow-closed' } as const;

/** Serialises marks as SVG elements (no `<svg>` wrapper); markers refer to {@link DIAGRAM_MARKER_IDS}. */
export function diagramMarksToSvg(marks: readonly DiagramMark[], theme: Pick<DiagramSceneTheme, 'selection'> = DIAGRAM_SCENE_LIGHT_THEME): string {
	const out: string[] = [];
	for (const m of marks) {
		const common = `${m.target ? ` data-target="${esc(m.target)}"` : ''}${m.opacity !== undefined ? ` opacity="${num(m.opacity)}"` : ''}`;
		const sel = m.selected ? ` stroke="${esc(theme.selection)}" stroke-width="2"` : '';
		const markers = (mk: { markerEnd?: string; markerStart?: string }) =>
			`${mk.markerEnd ? ` marker-end="url(#${DIAGRAM_MARKER_IDS[mk.markerEnd as 'arrow']})"` : ''}${mk.markerStart ? ` marker-start="url(#${DIAGRAM_MARKER_IDS[mk.markerStart as 'arrow']})"` : ''}`;
		switch (m.kind) {
			case 'rect':
				out.push(
					`<rect x="${num(m.x)}" y="${num(m.y)}" width="${num(Math.max(0, m.width))}" height="${num(Math.max(0, m.height))}"${m.radius ? ` rx="${num(m.radius)}"` : ''} fill="${esc(m.fill)}"${sel || (m.stroke ? ` stroke="${esc(m.stroke)}" stroke-width="${num(m.strokeWidth ?? 1)}"` : '')}${m.dash ? ` stroke-dasharray="${m.dash}"` : ''}${common}/>`
				);
				break;
			case 'circle':
				out.push(
					`<circle cx="${num(m.cx)}" cy="${num(m.cy)}" r="${num(m.r)}" fill="${esc(m.fill)}"${sel || (m.stroke ? ` stroke="${esc(m.stroke)}" stroke-width="${num(m.strokeWidth ?? 1)}"` : '')}${common}/>`
				);
				break;
			case 'line':
				out.push(
					`<line x1="${num(m.x1)}" y1="${num(m.y1)}" x2="${num(m.x2)}" y2="${num(m.y2)}" stroke="${esc(m.selected ? theme.selection : m.stroke)}" stroke-width="${num(m.strokeWidth ?? 1)}"${m.dash ? ` stroke-dasharray="${m.dash}"` : ''}${markers(m)}${common}/>`
				);
				break;
			case 'path':
				out.push(
					`<path d="${m.d}" fill="${esc(m.fill ?? 'none')}"${sel || (m.stroke ? ` stroke="${esc(m.stroke)}" stroke-width="${num(m.strokeWidth ?? 1)}"` : '')}${m.dash ? ` stroke-dasharray="${m.dash}"` : ''}${markers(m)}${common}/>`
				);
				break;
			case 'text':
				out.push(
					`<text x="${num(m.x)}" y="${num(m.y)}" text-anchor="${m.anchor}" dominant-baseline="${diagramTextBaseline(m.baseline)}" font-size="${num(m.size)}"${m.weight ? ` font-weight="${m.weight}"` : ''}${m.italic ? ' font-style="italic"' : ''} fill="${esc(m.fill)}"${m.rotate ? ` transform="rotate(${num(m.rotate)} ${num(m.x)} ${num(m.y)})"` : ''}${common}>${esc(m.text)}</text>`
				);
				break;
		}
	}
	return out.join('');
}

/**
 * A scene theme that reads the page's `--background`, `--foreground`, `--muted-foreground`,
 * `--border` and `--primary` colour variables, with light fallbacks. The React and Svelte
 * scenes use it (they paint with `style`, where `var()` works); files and PNGs use
 * {@link DIAGRAM_SCENE_LIGHT_THEME} or the dark theme.
 */
export const CSS_VARIABLE_DIAGRAM_SCENE_THEME: DiagramSceneTheme = {
	...DIAGRAM_SCENE_LIGHT_THEME,
	background: 'var(--background, #ffffff)',
	nodeFill: 'var(--background, #ffffff)',
	nodeStroke: 'var(--foreground, #0f172a)',
	text: 'var(--foreground, #0f172a)',
	edge: 'var(--muted-foreground, #64748b)',
	edgeLabelBackground: 'var(--background, #ffffff)',
	groupFill: 'var(--muted, #f8fafc)',
	groupStroke: 'var(--border, #cbd5e1)',
	groupText: 'var(--muted-foreground, #475569)',
	grid: 'var(--border, #cbd5e1)',
	mutedText: 'var(--muted-foreground, #64748b)',
	selection: 'var(--primary, #2563eb)',
	fontFamily: 'inherit'
};

/**
 * The edit that renames what a scene mark targets: the title (`setTitle`), a group
 * (`renameGroup`), an edge (`setEdgeLabel`) or a node (`renameNode`). Null for an unknown
 * target. An empty title removes it. Shared by the React and Svelte scenes' double-click.
 */
export function diagramRenameOp(doc: Pick<MermaidDocument, 'graph'>, target: string, label: string): EditOp | null {
	const { graph } = doc;
	if (target === DIAGRAM_TITLE_TARGET) return { type: 'setTitle', title: label.trim() || undefined };
	if (graph.groups.some((g) => g.id === target)) return { type: 'renameGroup', id: target, label };
	if (graph.edges.some((e) => e.id === target)) return { type: 'setEdgeLabel', id: target, label };
	if (graph.nodes.some((n) => n.id === target)) return { type: 'renameNode', id: target, label };
	return null;
}

/** The text a rename of `target` starts from (title, group, edge or node label). */
export function diagramTargetLabel(doc: Pick<MermaidDocument, 'graph'>, target: string): string | null {
	const { graph } = doc;
	if (target === DIAGRAM_TITLE_TARGET) return graph.title ?? '';
	return graph.groups.find((g) => g.id === target)?.label ?? graph.edges.find((e) => e.id === target)?.label ?? graph.nodes.find((n) => n.id === target)?.label ?? null;
}
