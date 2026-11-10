<script lang="ts">
	import {
		getCanvasEdgeAnimation,
		getCanvasEdgePath,
		resolveCanvasEdgeAnimation,
		type CanvasAnimatedEdgePathType,
		type CanvasEdgeAnimation,
		type Position
	} from '@pixerate/editor/canvas';
	import EdgeAnimation from './EdgeAnimation.svelte';

	/** The props Svelte Flow passes a custom edge (the subset `<AnimatedEdge>` uses). */
	interface Props {
		id: string;
		sourceX: number;
		sourceY: number;
		targetX: number;
		targetY: number;
		sourcePosition?: Position;
		targetPosition?: Position;
		/** `data.animation` is the animation; `data.pathType` the path style (default `default`, a bézier). */
		data?: { animation?: CanvasEdgeAnimation | null; pathType?: CanvasAnimatedEdgePathType; [key: string]: any };
		label?: string;
		labelStyle?: string;
		/** Inline CSS for the edge line (e.g. `stroke: #38bdf8`). */
		style?: string;
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
	 * A Svelte Flow edge that plays `data.animation` (travelling dots, marching dashes, a beam or a
	 * pulse) over its line. Register it as an edge type (`edgeTypes={{ animated: AnimatedEdge }}`) and
	 * give edges `type: "animated"`; `data.pathType` picks the path (`default`, `straight`, `step`,
	 * `smoothstep`, `simplebezier`), drawn as Svelte Flow draws it. An edge without an animation is a
	 * plain edge. Agents change animations with `createCanvasEdgeAnimationToolProvider`.
	 */
	let {
		id,
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
		data,
		label,
		labelStyle,
		style,
		markerStart,
		markerEnd,
		interactionWidth = 20,
		reducedMotion
	}: Props = $props();

	const edgePath = $derived(getCanvasEdgePath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, type: data?.pathType }));
	const animation = $derived(getCanvasEdgeAnimation({ data }));
	const stroke = $derived(style?.match(/(?:^|;)\s*stroke\s*:\s*([^;]+)/)?.[1]?.trim());
	const trackOpacity = $derived(animation ? resolveCanvasEdgeAnimation(animation).trackOpacity : 1);
	const lineStyle = $derived([style, trackOpacity !== 1 ? `stroke-opacity: ${trackOpacity}` : ''].filter(Boolean).join('; '));
</script>

<path {id} d={edgePath.path} fill="none" class="svelte-flow__edge-path" style={lineStyle} marker-start={markerStart} marker-end={markerEnd} />
{#if interactionWidth > 0}
	<path d={edgePath.path} fill="none" stroke-opacity="0" stroke-width={interactionWidth} class="svelte-flow__edge-interaction" />
{/if}
<EdgeAnimation {animation} path={edgePath.path} {id} stroke={stroke ?? 'var(--xy-edge-stroke, #b1b1b7)'} {reducedMotion} />
{#if label}
	<text x={edgePath.labelX} y={edgePath.labelY} text-anchor="middle" dominant-baseline="central" class="svelte-flow__edge-text" style={labelStyle}>{label}</text>
{/if}
