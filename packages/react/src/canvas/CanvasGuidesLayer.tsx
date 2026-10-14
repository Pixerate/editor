import React from 'react';
import type { CanvasViewport, GuideLine } from '@pixerate/editor/canvas';

export interface CanvasGuidesLayerProps {
	/** Guide segments in flow coordinates (e.g. `arrange.guides`). */
	guides: GuideLine[];
	/** Current viewport (e.g. `useViewport()` from React Flow). */
	viewport?: CanvasViewport;
	/** Colour of edge and centre guides. */
	color?: string;
	/** Colour of equal-spacing guides. */
	spacingColor?: string;
	className?: string;
}

const DEFAULT_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };

/**
 * Smart-guide overlay for React Flow. Place it inside the flow container (it is absolutely
 * positioned over the whole pane) and pass the live viewport.
 */
export function CanvasGuidesLayer({
	guides,
	viewport = DEFAULT_VIEWPORT,
	color = '#f59e0b',
	spacingColor = '#ec4899',
	className = ''
}: CanvasGuidesLayerProps) {
	if (!guides || guides.length === 0) return null;
	const sx = (x: number) => x * viewport.zoom + viewport.x;
	const sy = (y: number) => y * viewport.zoom + viewport.y;

	return (
		<svg
			className={`pixerate-canvas-guides ${className}`}
			style={{
				position: 'absolute',
				inset: 0,
				width: '100%',
				height: '100%',
				pointerEvents: 'none',
				overflow: 'visible',
				zIndex: 10
			}}
			aria-hidden="true"
		>
			{guides.map((guide, i) => (
				<line
					key={i}
					data-kind={guide.kind}
					x1={sx(guide.x1)}
					y1={sy(guide.y1)}
					x2={sx(guide.x2)}
					y2={sy(guide.y2)}
					stroke={guide.kind === 'spacing' ? spacingColor : color}
					strokeWidth={1}
					strokeDasharray={guide.kind === 'centre' ? '4 3' : undefined}
					shapeRendering="crispEdges"
				/>
			))}
		</svg>
	);
}
