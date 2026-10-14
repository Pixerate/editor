import React from 'react';
import { getShapeRenderData, isShapeDescription, type ShapeDescription } from '@pixerate/editor/canvas';

export interface ShapeNodeProps {
	/** Node data; `data.shape` holds the shape description. */
	data: { shape?: ShapeDescription; [key: string]: any };
	/** Node width / height (React Flow passes them to custom nodes). */
	width?: number;
	height?: number;
	selected?: boolean;
	className?: string;
	/** Rendered over the shape, e.g. React Flow `<Handle>`s or a label. */
	children?: React.ReactNode;
	[key: string]: any;
}

/**
 * Headless shape node: draws `data.shape` as one SVG path that fills the node box.
 * Register it as a React Flow node type (`nodeTypes={{ shape: ShapeNode }}`), or wrap it
 * to add handles. Strokes keep their width when the node is resized
 * (`vector-effect: non-scaling-stroke`). Renders nothing when `data.shape` is missing.
 */
export function ShapeNode({ data, width, height, selected, className = '', children }: ShapeNodeProps) {
	const shape = data?.shape;
	if (!isShapeDescription(shape)) return null;
	const render = getShapeRenderData(shape, { width, height });
	return (
		<div
			className={`pixerate-shape-node ${className}`.trim()}
			data-shape-kind={shape.kind}
			data-selected={selected ? 'true' : undefined}
			style={{ position: 'relative', width: '100%', height: '100%' }}
		>
			<svg
				viewBox={render.viewBox}
				preserveAspectRatio="none"
				width="100%"
				height="100%"
				style={{ display: 'block', overflow: 'visible' }}
				aria-hidden="true"
			>
				<path
					d={render.d}
					transform={render.transform}
					fill={render.fill}
					fillRule={render.fillRule}
					stroke={render.stroke}
					strokeWidth={render.strokeWidth}
					opacity={render.opacity}
					vectorEffect="non-scaling-stroke"
				/>
			</svg>
			{children}
		</div>
	);
}
