// Follows Ursula's MermaidStreamingView: nodes are held back until an edge places them,
// layouts are recomputed only when the structure changes, and the view tweens between
// layouts with `blendDiagramLayout`.
import { parseMermaid } from '../../diagram/document.js';
import type { DiagramGraph, MermaidDocument } from '../../diagram/types.js';
import { ensureDiagramLayout, type DiagramLayout, type DiagramLayoutOptions } from './layout.js';
import { connectedDiagramOnly } from './view.js';

export interface DiagramStreamResult {
	/** The diagram as far as it has arrived (its graph trimmed while incomplete). */
	document: MermaidDocument;
	/** Layout for `document.graph`, or `null` before any node can be placed. */
	layout: DiagramLayout | null;
	/** True when the layout differs from the previous result (start a tween). */
	relaid: boolean;
}

/** Structure only: labels can change without moving anything. */
function fingerprint(graph: DiagramGraph): string {
	return JSON.stringify([
		graph.direction,
		graph.nodes.map((n) => [n.id, n.parentId ?? '', n.shape, String(n.label).length > 24 ? 1 : 0]),
		graph.edges.map((e) => [e.source, e.target]),
		graph.groups.map((g) => [g.id, g.parentId ?? '', g.direction ?? ''])
	]);
}

/**
 * Turns Mermaid text that is still being written (e.g. streamed from a model) into a
 * diagram and a layout to draw. While incomplete, nodes no edge touches yet are held
 * back (a node usually arrives a line before the edge that places it, and showing it
 * alone makes the layout jump twice). Layouts are only recomputed when nodes, edges or
 * groups change, so label text streaming in does not move anything.
 */
export class DiagramStream {
	private lastKey = '';
	private layout: DiagramLayout | null = null;

	constructor(private readonly options: DiagramLayoutOptions = {}) {}

	/** Reads the source so far. `complete` when nothing more will arrive. */
	update(source: string, complete = false): DiagramStreamResult {
		const text = streamedDiagramText(source);
		const parsed = parseMermaid(text);
		const document = !complete ? { ...parsed, graph: connectedDiagramOnly(parsed.graph) } : parsed;
		if (document.tier !== 'editable' || !document.graph.nodes.length) return { document, layout: this.layout && complete ? null : this.layout, relaid: false };
		const key = fingerprint(document.graph);
		if (key === this.lastKey && this.layout) return { document, layout: this.layout, relaid: false };
		this.lastKey = key;
		this.layout = ensureDiagramLayout(document.graph, document.meta, { family: document.family, ...this.options });
		return { document, layout: this.layout, relaid: true };
	}

	/** Forgets the previous layout (a new source). */
	reset(): void {
		this.lastKey = '';
		this.layout = null;
	}
}

/**
 * The diagram text in a reply that is still arriving: the body of the first ```mermaid
 * (or unmarked) fence, even before it is closed, or the whole text when there is no fence.
 * Prose before the fence (a model's "Here is the plan:") is skipped.
 */
export function streamedDiagramText(source: string): string {
	const open = /(?:^|\n)[ ]{0,3}(`{3,}|~{3,})[ \t]*(mermaid|mmd)?[^\n`]*(?:\n|$)/i.exec(source);
	if (!open) return source;
	const rest = source.slice(open.index + open[0].length);
	const fence = open[1]!;
	const close = new RegExp(`(?:^|\\n)[ ]{0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*(?:\\n|$)`).exec(rest);
	return close ? rest.slice(0, close.index) : rest.replace(/\n[ ]{0,3}[`~]{1,2}$/, '');
}

/** Ease-out cubic, for layout tweens. */
export const easeDiagramTween = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);
