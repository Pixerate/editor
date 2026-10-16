import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasDraw } from './useCanvasDraw.js';
import {
	strokePointsToPathData,
	resolveCanvasGradient,
	gradientToSvgDef,
	type CanvasNode,
	type CanvasViewport
} from '@pixerate/editor/canvas';

export interface CanvasDrawLayerProps<TNode extends CanvasNode = CanvasNode> {
	/** Draw state and controller actions from `useCanvasDraw`. */
	draw: CanvasDraw<TNode>;
	/** Current viewport (e.g. `useViewport()` from React Flow). */
	viewport?: CanvasViewport;
	/** Optional class name on the root SVG overlay element. */
	className?: string;
	/** Optional inline styles on the root SVG overlay element. */
	style?: React.CSSProperties;
	/** Cursor styling override when drawing or erasing. */
	cursor?: string;
	/** Eraser circle preview radius in screen pixels (default: 12). */
	eraserRadius?: number;
}

const DEFAULT_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };

/**
 * Overlay component for freehand drawing inside React Flow.
 * Renders an interactive SVG capturing drawing pointer events when `draw.tool !== 'select'`.
 * Also supports holding Spacebar to temporarily pan the canvas without switching tools.
 */
export function CanvasDrawLayer<TNode extends CanvasNode = CanvasNode>({
	draw,
	viewport = DEFAULT_VIEWPORT,
	className = '',
	style,
	cursor,
	eraserRadius = 12
}: CanvasDrawLayerProps<TNode>) {
	const svgRef = useRef<SVGSVGElement | null>(null);
	const [spaceHeld, setSpaceHeld] = useState(false);
	const [eraserPos, setEraserPos] = useState<[number, number] | null>(null);

	// Spacebar navigation override
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.code === 'Space' && !e.repeat) {
				const tag = (e.target as HTMLElement)?.tagName;
				if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) {
					return;
				}
				setSpaceHeld(true);
			}
		}
		function onKeyUp(e: KeyboardEvent) {
			if (e.code === 'Space') {
				setSpaceHeld(false);
			}
		}
		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('keyup', onKeyUp);
		return () => {
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('keyup', onKeyUp);
		};
	}, []);

	// Transform screen client coordinates to flow canvas coordinates
	const clientToFlow = useCallback(
		(clientX: number, clientY: number): [number, number] => {
			if (!svgRef.current) return [0, 0];
			const rect = svgRef.current.getBoundingClientRect();
			const screenX = clientX - rect.left;
			const screenY = clientY - rect.top;
			const flowX = (screenX - viewport.x) / viewport.zoom;
			const flowY = (screenY - viewport.y) / viewport.zoom;
			return [flowX, flowY];
		},
		[viewport.x, viewport.y, viewport.zoom]
	);

	const isDrawingMode = draw.tool !== 'select';
	const interactive = isDrawingMode && !spaceHeld;

	const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
		if (!interactive || e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		(e.target as Element).setPointerCapture?.(e.pointerId);

		const flowPt = clientToFlow(e.clientX, e.clientY);
		draw.startStroke(flowPt);

		if (draw.tool === 'eraser') {
			setEraserPos([e.clientX, e.clientY]);
		}
	};

	const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
		if (draw.tool === 'eraser' && !spaceHeld) {
			setEraserPos([e.clientX, e.clientY]);
		}

		if (!interactive) return;
		// If pointer is pressed down (or dragging)
		if (e.buttons === 1) {
			e.preventDefault();
			e.stopPropagation();
			const flowPt = clientToFlow(e.clientX, e.clientY);
			draw.continueStroke(flowPt);
		}
	};

	const handlePointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
		if (!interactive || e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		try {
			(e.target as Element).releasePointerCapture?.(e.pointerId);
		} catch {
			// ignore if already released
		}
		draw.endStroke();
	};

	const handlePointerLeave = () => {
		setEraserPos(null);
	};

	// Determine cursor style
	const resolvedCursor = cursor
		? cursor
		: spaceHeld
			? 'grab'
			: draw.tool === 'eraser'
				? 'crosshair'
				: draw.tool === 'pen' || draw.tool === 'highlighter'
					? 'crosshair'
					: 'default';

	// Render preview of active live stroke
	const strokePath = draw.activeStroke
		? strokePointsToPathData(draw.activeStroke.points)
		: null;

	const activeGradient = draw.activeStroke
		? resolveCanvasGradient(draw.activeStroke.style.gradient ?? draw.activeStroke.style.color)
		: null;
	const resolvedGradientDef = activeGradient
		? gradientToSvgDef(activeGradient, 'active-draw-stroke-gradient')
		: null;
	const strokePaint = resolvedGradientDef
		? `url(#${resolvedGradientDef.id})`
		: draw.activeStroke
			? (draw.activeStroke.style.color as string)
			: 'currentColor';

	return (
		<svg
			ref={svgRef}
			className={`pixerate-canvas-draw-layer ${className}`}
			style={{
				position: 'absolute',
				inset: 0,
				width: '100%',
				height: '100%',
				pointerEvents: interactive ? 'all' : 'none',
				cursor: interactive ? resolvedCursor : undefined,
				overflow: 'visible',
				zIndex: 20,
				touchAction: 'none',
				...style
			}}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
			onPointerLeave={handlePointerLeave}
		>
			{/* Gradient defs for active freehand stroke */}
			{resolvedGradientDef && (
				<defs>
					{resolvedGradientDef.type === 'linear' && (
						<linearGradient id={resolvedGradientDef.id} {...resolvedGradientDef.attrs}>
							{resolvedGradientDef.stops.map((stop, i) => (
								<stop key={i} offset={stop.offset} stopColor={stop.stopColor} stopOpacity={stop.stopOpacity} />
							))}
						</linearGradient>
					)}
					{resolvedGradientDef.type === 'radial' && (
						<radialGradient id={resolvedGradientDef.id} {...resolvedGradientDef.attrs}>
							{resolvedGradientDef.stops.map((stop, i) => (
								<stop key={i} offset={stop.offset} stopColor={stop.stopColor} stopOpacity={stop.stopOpacity} />
							))}
						</radialGradient>
					)}
				</defs>
			)}

			{/* Canvas-space items transformed by current React Flow viewport */}
			<g transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.zoom})`}>
				{draw.activeStroke && strokePath && (
					<path
						className="pixerate-canvas-draw-active"
						d={strokePath}
						fill="none"
						stroke={strokePaint}
						strokeWidth={draw.activeStroke.style.width}
						opacity={draw.activeStroke.style.opacity}
						strokeLinecap={draw.activeStroke.style.cap ?? 'round'}
						strokeLinejoin={draw.activeStroke.style.join ?? 'round'}
					/>
				)}
			</g>

			{/* Screen-space eraser cursor indicator */}
			{draw.tool === 'eraser' && eraserPos && svgRef.current && (
				<circle
					cx={eraserPos[0] - svgRef.current.getBoundingClientRect().left}
					cy={eraserPos[1] - svgRef.current.getBoundingClientRect().top}
					r={eraserRadius}
					fill="rgba(239, 68, 68, 0.15)"
					stroke="rgba(239, 68, 68, 0.8)"
					strokeWidth={1.5}
					strokeDasharray="3 3"
					pointerEvents="none"
				/>
			)}
		</svg>
	);
}
