import React from 'react';
import { MERMAID_SHAPE_PAINT, mermaidLabelLines, mermaidNodeMembers, mermaidNodePaint, mermaidShapePaths } from '@pixerate/editor/canvas';

/** Node data as `mermaidToCanvas` produces it. */
export interface MermaidDiagramNodeData {
	node?: { id: string; label: string; shape: string; data?: Record<string, unknown> };
	group?: { id: string; label: string };
	resolvedStyles?: Record<string, string>;
	[key: string]: unknown;
}

export interface MermaidDiagramNodeProps {
	id?: string;
	data: MermaidDiagramNodeData;
	width?: number;
	height?: number;
	selected?: boolean;
	className?: string;
	/** Rendered over the node, e.g. React Flow `<Handle>`s. */
	children?: React.ReactNode;
	[key: string]: unknown;
}

/** Mermaid `style` / `classDef` declarations as the CSS the node paints with. */
export function mermaidNodeStyle(styles: Record<string, string> = {}, selected = false): React.CSSProperties {
	const paint = mermaidNodePaint(styles, selected);
	const { color, 'stroke-width': strokeWidth, 'stroke-dasharray': strokeDasharray, ...vars } = paint;
	return { ...vars, color, strokeWidth, strokeDasharray } as React.CSSProperties;
}

/**
 * Headless Mermaid node: draws the node's shape (flowchart, state, class, ER) as SVG with
 * its label, painted from its Mermaid styles. Register it as the `mermaid-node` React Flow
 * node type and pass `<Handle>`s as children.
 */
export function MermaidDiagramNode({ data, width = 160, height = 56, selected, className = '', children }: MermaidDiagramNodeProps) {
	const node = data.node;
	if (!node) return null;
	const members = mermaidNodeMembers(node.data);
	return (
		<div
			className={`pixerate-diagram-node ${className}`.trim()}
			data-shape={node.shape}
			data-selected={selected ? 'true' : undefined}
			style={{ position: 'relative', width: '100%', height: '100%', ...mermaidNodeStyle(data.resolvedStyles, selected) }}
		>
			<svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" width="100%" height="100%" style={{ position: 'absolute', inset: 0, overflow: 'visible' }} aria-hidden="true">
				{mermaidShapePaths(node.shape, width, height).map((path, i) => (
					<path key={i} d={path.d} style={{ ...MERMAID_SHAPE_PAINT[path.paint], vectorEffect: 'non-scaling-stroke' }} />
				))}
			</svg>
			<div
				style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: members.length ? 'flex-start' : 'center', height: '100%', padding: '6px 10px', boxSizing: 'border-box', fontSize: 13, lineHeight: 1.3, textAlign: 'center', pointerEvents: 'none' }}
			>
				{mermaidLabelLines(node.label).map((line, i) => (
					<span key={i} style={{ fontWeight: members.length ? 600 : undefined }}>
						{line}
					</span>
				))}
				{members.length > 0 && (
					<div style={{ alignSelf: 'stretch', marginTop: 4, paddingTop: 4, borderTop: '1px solid var(--pixerate-diagram-node-border)', textAlign: 'left', fontSize: 12 }}>
						{members.map((m, i) => (
							<div key={i}>{m}</div>
						))}
					</div>
				)}
			</div>
			{children}
		</div>
	);
}

/** Headless Mermaid group (subgraph, composite state, namespace): a titled frame. Register as `mermaid-group`. */
export function MermaidDiagramGroup({ data, selected, className = '', children }: MermaidDiagramNodeProps) {
	const group = data.group;
	if (!group) return null;
	return (
		<div
			className={`pixerate-diagram-group ${className}`.trim()}
			data-selected={selected ? 'true' : undefined}
			style={{
				width: '100%',
				height: '100%',
				boxSizing: 'border-box',
				borderRadius: 8,
				border: `1px ${selected ? 'solid' : 'dashed'} ${selected ? 'var(--primary, #2563eb)' : (data.resolvedStyles?.stroke ?? 'var(--border, #cbd5e1)')}`,
				background: data.resolvedStyles?.fill ?? 'var(--muted, rgba(148, 163, 184, 0.08))',
				color: data.resolvedStyles?.color ?? 'var(--muted-foreground, #475569)'
			}}
		>
			<div style={{ padding: '6px 10px', fontSize: 12, fontWeight: 600 }}>{mermaidLabelLines(group.label).join(' ')}</div>
			{children}
		</div>
	);
}
