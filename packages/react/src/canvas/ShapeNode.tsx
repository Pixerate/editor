import React from 'react';
import { getShapeRenderData, isShapeDescription, type ShapeDescription } from '@pixerate/editor/canvas';
import { useShapeBrushstroke } from './useShapeBrushstroke.js';
import { CanvasNodeEffectLayer } from './CanvasEffects.js';

export interface ShapeNodeProps {
	/** Node data; `data.shape` holds the shape description. */
	data: { shape?: ShapeDescription; [key: string]: any };
	/** Node width / height (React Flow passes them to custom nodes). */
	width?: number;
	height?: number;
	selected?: boolean;
	/** Absolute canvas position (React Flow passes it): brushed strokes sample the paper grain there. */
	positionAbsoluteX?: number;
	positionAbsoluteY?: number;
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
 * A brushed stroke (`shape.brush`) is drawn as its paint-engine image (sharp at the zoom a
 * `ShapeNodeZoomProvider` gives), with the plain path shown until the image is ready. A provider
 * effect (`shape.effect`) is drawn inside the shape or over it when a `<CanvasEffectsProvider>`
 * gives a provider.
 */
export function ShapeNode({ id, data, width, height, selected, className = '', children, positionAbsoluteX, positionAbsoluteY }: ShapeNodeProps) {
	const shape = data?.shape;
	const brushImage = useShapeBrushstroke(isShapeDescription(shape) ? shape : null, width, height, { x: positionAbsoluteX ?? 0, y: positionAbsoluteY ?? 0 });
	if (!isShapeDescription(shape)) return null;
	const render = getShapeRenderData(shape, { width, height }, { id: id || data?.id });
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
				{(render.fillGradient || render.strokeGradient) && (
					<defs>
						{render.fillGradient && render.fillGradient.type === 'linear' && (
							<linearGradient id={render.fillGradient.id} {...render.fillGradient.attrs}>
								{render.fillGradient.stops.map((stop, i) => (
									<stop key={i} offset={stop.offset} stopColor={stop.stopColor} stopOpacity={stop.stopOpacity} />
								))}
							</linearGradient>
						)}
						{render.fillGradient && render.fillGradient.type === 'radial' && (
							<radialGradient id={render.fillGradient.id} {...render.fillGradient.attrs}>
								{render.fillGradient.stops.map((stop, i) => (
									<stop key={i} offset={stop.offset} stopColor={stop.stopColor} stopOpacity={stop.stopOpacity} />
								))}
							</radialGradient>
						)}
						{render.strokeGradient && render.strokeGradient.type === 'linear' && (
							<linearGradient id={render.strokeGradient.id} {...render.strokeGradient.attrs}>
								{render.strokeGradient.stops.map((stop, i) => (
									<stop key={i} offset={stop.offset} stopColor={stop.stopColor} stopOpacity={stop.stopOpacity} />
								))}
							</linearGradient>
						)}
						{render.strokeGradient && render.strokeGradient.type === 'radial' && (
							<radialGradient id={render.strokeGradient.id} {...render.strokeGradient.attrs}>
								{render.strokeGradient.stops.map((stop, i) => (
									<stop key={i} offset={stop.offset} stopColor={stop.stopColor} stopOpacity={stop.stopOpacity} />
								))}
							</radialGradient>
						)}
					</defs>
				)}
				{brushImage ? (
					<g transform={render.transform}>
						<image
							className="pixerate-shape-brushstroke"
							href={brushImage.href}
							x={brushImage.x}
							y={brushImage.y}
							width={brushImage.width}
							height={brushImage.height}
							preserveAspectRatio="none"
							opacity={render.opacity}
						/>
					</g>
				) : (
				<path
					d={render.d}
					transform={render.transform}
					fill={render.fill}
					fillRule={render.fillRule}
					stroke={render.stroke}
					strokeWidth={render.strokeWidth}
					strokeLinecap={render.strokeLinecap}
					strokeLinejoin={render.strokeLinejoin}
					opacity={render.opacity}
					vectorEffect="non-scaling-stroke"
				/>
				)}
			</svg>
			{shape.effect && width && height ? <CanvasNodeEffectLayer effect={shape.effect} width={width} height={height} clipPath={render.d} clipTransform={render.transform} /> : null}
			{children}
		</div>
	);
}
