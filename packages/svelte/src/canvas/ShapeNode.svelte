<script lang="ts">
	import type { Snippet } from 'svelte';
	import { getShapeRenderData, isShapeDescription, type ShapeDescription } from '@pixerate/editor/canvas';

	interface Props {
		/** Node data; `data.shape` holds the shape description. */
		data: { shape?: ShapeDescription; [key: string]: any };
		/** Node width / height (SvelteFlow passes them to custom nodes). */
		width?: number;
		height?: number;
		selected?: boolean;
		class?: string;
		/** Rendered over the shape, e.g. SvelteFlow `<Handle>`s or a label. */
		children?: Snippet;
		[key: string]: any;
	}

	let { data, width, height, selected = false, class: className = '', children }: Props = $props();

	const shape = $derived(isShapeDescription(data?.shape) ? data.shape : null);
	const render = $derived(shape ? getShapeRenderData(shape, { width, height }) : null);
</script>

<!--
	Headless shape node: draws `data.shape` as one SVG path that fills the node box.
	Register it as a SvelteFlow node type (`nodeTypes={{ shape: ShapeNode }}`), or wrap it
	to add handles. Strokes keep their width when the node is resized.
-->
{#if shape && render}
	<div
		class="pixerate-shape-node {className}"
		data-shape-kind={shape.kind}
		data-selected={selected ? 'true' : undefined}
		style="position: relative; width: 100%; height: 100%;"
	>
		<svg
			viewBox={render.viewBox}
			preserveAspectRatio="none"
			width="100%"
			height="100%"
			style="display: block; overflow: visible;"
			aria-hidden="true"
		>
			<path
				d={render.d}
				transform={render.transform}
				fill={render.fill}
				fill-rule={render.fillRule}
				stroke={render.stroke}
				stroke-width={render.strokeWidth}
				opacity={render.opacity}
				vector-effect="non-scaling-stroke"
			/>
		</svg>
		{@render children?.()}
	</div>
{/if}
