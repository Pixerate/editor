<script lang="ts">
	import { getCanvasEdgeAnimationRender, type CanvasEdgeAnimation } from '@pixerate/editor/canvas';
	import { createPrefersReducedMotion } from './prefersReducedMotion.svelte.js';

	interface Props {
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
	 * along `path` with SMIL, so nothing runs per frame in JavaScript. Put it in your own Svelte Flow
	 * edge after `<BaseEdge>`, or use `<AnimatedEdge>`. It ignores the pointer.
	 */
	let { animation, path, id, stroke, reducedMotion }: Props = $props();

	const prefers = createPrefersReducedMotion();
	const render = $derived.by(() => {
		if (!animation) return null;
		try {
			return getCanvasEdgeAnimationRender(animation, { path, id, stroke, reducedMotion: reducedMotion ?? prefers.current });
		} catch {
			return null;
		}
	});
	const pathId = $derived(`pixerate-edge-path-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
</script>

{#if render}
	<g class="pixerate-edge-animation" data-edge-animation={render.kind} data-moving={render.moving ? 'true' : 'false'} style="pointer-events: none">
		<defs>
			<path id={pathId} d={path} />
			{#if render.glowFilter}
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
			{/if}
		</defs>
		{#each render.elements as el (el.key)}
			{#if el.type === 'dot'}
				{#if render.moving}
					<circle r={el.r} fill={el.fill} filter={el.filter}>
						<animateMotion
							dur="{el.motion.dur}s"
							begin="{el.motion.begin}s"
							repeatCount="indefinite"
							keyPoints={el.motion.keyPoints}
							keyTimes={el.motion.keyTimes}
							calcMode="linear"
						>
							<mpath href="#{pathId}" />
						</animateMotion>
					</circle>
				{:else}
					<circle cx={el.at.x} cy={el.at.y} r={el.r} fill={el.fill} filter={el.filter} />
				{/if}
			{:else}
				<path
					d={path}
					fill="none"
					stroke={el.stroke}
					stroke-width={el.strokeWidth}
					stroke-linecap={el.strokeLinecap}
					stroke-dasharray={el.strokeDasharray}
					stroke-dashoffset={el.strokeDashoffset}
					stroke-opacity={el.opacity}
					filter={el.filter}
				>
					{#if render.moving}
						{#each el.animate as a (a.attributeName)}
							<animate attributeName={a.attributeName} values={a.values} dur="{a.dur}s" begin="{a.begin}s" repeatCount="indefinite" />
						{/each}
					{/if}
				</path>
			{/if}
		{/each}
	</g>
{/if}
