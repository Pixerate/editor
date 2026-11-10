import React, { useEffect, useMemo, useState } from 'react';
import {
	getCanvasEdgeAnimation,
	getCanvasEdgeAnimationRender,
	getCanvasEdgePath,
	resolveCanvasEdgeAnimation,
	type CanvasAnimatedEdgePathType,
	type CanvasEdgeAnimation,
	type Position
} from '@pixerate/editor/canvas';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** True while the user asks for reduced motion (`prefers-reduced-motion: reduce`). */
export function usePrefersReducedMotion(): boolean {
	const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION).matches);
	useEffect(() => {
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
		const query = window.matchMedia(REDUCED_MOTION);
		const update = () => setReduced(query.matches);
		update();
		query.addEventListener?.('change', update);
		return () => query.removeEventListener?.('change', update);
	}, []);
	return reduced;
}

export interface EdgeAnimationProps {
	/** The animation (`edge.data.animation`). Renders nothing when null. */
	animation: CanvasEdgeAnimation | null | undefined;
	/** SVG path data of the edge, as your edge draws it. */
	path: string;
	/** Edge id: keeps glow filter ids unique. */
	id: string;
	/** Colour when the animation has none (the edge's stroke). Default `currentColor`. */
	stroke?: string;
	/** Hold the first frame. Default: follow `prefers-reduced-motion`. */
	reducedMotion?: boolean;
}

/**
 * The moving part of an animated edge (dots, dashes, a beam or a pulse) as an SVG `<g>`, drawn
 * along `path` with SMIL, so nothing runs per frame in JavaScript. Put it in your own React Flow
 * edge after `<BaseEdge>`, or use `<AnimatedEdge>`. It ignores the pointer.
 */
export function EdgeAnimation({ animation, path, id, stroke, reducedMotion }: EdgeAnimationProps) {
	const prefersReduced = usePrefersReducedMotion();
	const render = useMemo(() => {
		if (!animation) return null;
		try {
			return getCanvasEdgeAnimationRender(animation, { path, id, stroke, reducedMotion: reducedMotion ?? prefersReduced });
		} catch {
			return null;
		}
	}, [animation, path, id, stroke, reducedMotion, prefersReduced]);
	if (!render) return null;
	const pathId = `pixerate-edge-path-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
	return (
		<g className="pixerate-edge-animation" data-edge-animation={render.kind} data-moving={render.moving ? 'true' : 'false'} style={{ pointerEvents: 'none' }}>
			<defs>
				<path id={pathId} d={path} />
				{render.glowFilter && (
					<filter
						id={render.glowFilter.id}
						filterUnits="userSpaceOnUse"
						x={render.glowFilter.x}
						y={render.glowFilter.y}
						width={render.glowFilter.width}
						height={render.glowFilter.height}
					>
						<feGaussianBlur stdDeviation={render.glowFilter.stdDeviation} result="blur" />
						<feMerge>
							<feMergeNode in="blur" />
							<feMergeNode in="SourceGraphic" />
						</feMerge>
					</filter>
				)}
			</defs>
			{render.elements.map((el) =>
				el.type === 'dot' ? (
					render.moving ? (
						<circle key={el.key} r={el.r} fill={el.fill} filter={el.filter}>
							<animateMotion
								dur={`${el.motion.dur}s`}
								begin={`${el.motion.begin}s`}
								repeatCount="indefinite"
								keyPoints={el.motion.keyPoints}
								keyTimes={el.motion.keyTimes}
								calcMode="linear"
							>
								<mpath href={`#${pathId}`} />
							</animateMotion>
						</circle>
					) : (
						<circle key={el.key} cx={el.at.x} cy={el.at.y} r={el.r} fill={el.fill} filter={el.filter} />
					)
				) : (
					<path
						key={el.key}
						d={path}
						fill="none"
						stroke={el.stroke}
						strokeWidth={el.strokeWidth}
						strokeLinecap={el.strokeLinecap}
						strokeDasharray={el.strokeDasharray}
						strokeDashoffset={el.strokeDashoffset}
						strokeOpacity={el.opacity}
						filter={el.filter}
					>
						{render.moving &&
							el.animate.map((a) => (
								<animate key={a.attributeName} attributeName={a.attributeName} values={a.values} dur={`${a.dur}s`} begin={`${a.begin}s`} repeatCount="indefinite" />
							))}
					</path>
				)
			)}
		</g>
	);
}

/** The props React Flow passes a custom edge (the subset `<AnimatedEdge>` uses). */
export interface AnimatedEdgeProps {
	id: string;
	sourceX: number;
	sourceY: number;
	targetX: number;
	targetY: number;
	sourcePosition?: Position;
	targetPosition?: Position;
	/** `data.animation` is the animation; `data.pathType` the path style (default `default`, a bézier). */
	data?: { animation?: CanvasEdgeAnimation | null; pathType?: CanvasAnimatedEdgePathType; [key: string]: any };
	label?: React.ReactNode;
	labelStyle?: React.CSSProperties;
	style?: React.CSSProperties;
	markerStart?: string;
	markerEnd?: string;
	selected?: boolean;
	/** Width of the invisible line that takes the pointer. Default 20. */
	interactionWidth?: number;
	/** Hold the first frame. Default: follow `prefers-reduced-motion`. */
	reducedMotion?: boolean;
	[key: string]: any;
}

/**
 * A React Flow edge that plays `data.animation` (travelling dots, marching dashes, a beam or a
 * pulse) over its line. Register it as an edge type (`edgeTypes={{ animated: AnimatedEdge }}`) and
 * give edges `type: "animated"`; `data.pathType` picks the path (`default`, `straight`, `step`,
 * `smoothstep`, `simplebezier`), drawn as React Flow draws it. An edge without an animation is a
 * plain edge. Agents change animations with `createCanvasEdgeAnimationToolProvider`.
 */
export function AnimatedEdge(props: AnimatedEdgeProps) {
	const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, label, labelStyle, style, markerStart, markerEnd, interactionWidth = 20, reducedMotion } = props;
	const { path, labelX, labelY } = getCanvasEdgePath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, type: data?.pathType });
	const animation = getCanvasEdgeAnimation({ data });
	const stroke = typeof style?.stroke === 'string' ? style.stroke : undefined;
	const trackOpacity = animation ? resolveCanvasEdgeAnimation(animation).trackOpacity : 1;
	return (
		<>
			<path
				id={id}
				d={path}
				fill="none"
				className="react-flow__edge-path"
				style={{ ...style, ...(trackOpacity !== 1 ? { strokeOpacity: trackOpacity } : {}) }}
				markerStart={markerStart}
				markerEnd={markerEnd}
			/>
			{interactionWidth > 0 && <path d={path} fill="none" strokeOpacity={0} strokeWidth={interactionWidth} className="react-flow__edge-interaction" />}
			<EdgeAnimation animation={animation} path={path} id={id} stroke={stroke ?? 'var(--xy-edge-stroke, #b1b1b7)'} reducedMotion={reducedMotion} />
			{label !== undefined && label !== null && label !== '' && (
				<text x={labelX} y={labelY} textAnchor="middle" dominantBaseline="central" className="react-flow__edge-text" style={labelStyle}>
					{label}
				</text>
			)}
		</>
	);
}
