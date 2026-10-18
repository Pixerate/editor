import React, { useMemo } from 'react';
import { parseMermaid, type MermaidDocument } from '@pixerate/editor/diagram';
import { mermaidThumbnailSvg, type DiagramSvgOptions } from '@pixerate/editor/canvas';

export interface MermaidThumbnailProps extends DiagramSvgOptions {
	/** Mermaid text, or an already parsed document. */
	source: string | MermaidDocument;
	className?: string;
	/** Shown for families that cannot be drawn here (sequence, Gantt, …) and empty diagrams. */
	fallback?: React.ReactNode;
}

/**
 * A static preview of a flowchart, state, class or ER diagram (no canvas, no Mermaid runtime):
 * `mermaidThumbnailSvg` fitted inside `maxWidth` × `maxHeight` (default 240 × 160).
 */
export function MermaidThumbnail({ source, className = '', fallback = null, ...options }: MermaidThumbnailProps) {
	const doc = useMemo(() => (typeof source === 'string' ? parseMermaid(source) : source), [source]);
	const key = JSON.stringify(options);
	const drawn = useMemo(
		() => (doc.tier === 'editable' && doc.graph.nodes.length ? mermaidThumbnailSvg(doc, options) : null),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[doc, key]
	);
	if (!drawn) return <>{fallback}</>;
	// The SVG is built by mermaidToSvg with every label escaped.
	return <span className={`pixerate-diagram-thumbnail ${className}`.trim()} style={{ display: 'inline-block', lineHeight: 0 }} dangerouslySetInnerHTML={{ __html: drawn.svg }} />;
}
