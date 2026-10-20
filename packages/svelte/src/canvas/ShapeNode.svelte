<script lang="ts">
	import type { Snippet } from 'svelte';
	import {
		brushstrokeScaleBucket,
		getShapeRenderData,
		isBrushedShape,
		isShapeDescription,
		renderShapeBrushstroke,
		type CanvasBrushstrokeImage,
		type ShapeDescription
	} from '@pixerate/editor/canvas';
	import { getShapeNodeZoom } from './shapeBrushstroke.svelte.js';
	import { getCanvasEffectsProvider } from './canvasEffects.svelte.js';
	import CanvasNodeEffectLayer from './CanvasNodeEffectLayer.svelte';

	interface Props {
		/** Unique node id (passed by SvelteFlow or user). */
		id?: string;
		/** Node data; `data.shape` holds the shape description. */
		data: { shape?: ShapeDescription; [key: string]: any };
		/** Node width / height (SvelteFlow passes them to custom nodes). */
		width?: number;
		height?: number;
		selected?: boolean;
		/** Absolute canvas position (SvelteFlow passes it): brushed strokes sample the paper grain there. */
		positionAbsoluteX?: number;
		positionAbsoluteY?: number;
		class?: string;
		/** Rendered over the shape, e.g. SvelteFlow `<Handle>`s or a label. */
		children?: Snippet;
		[key: string]: any;
	}

	let { id, data, width, height, selected = false, class: className = '', children, positionAbsoluteX = 0, positionAbsoluteY = 0 }: Props = $props();

	const shape = $derived(isShapeDescription(data?.shape) ? data.shape : null);
	const effectsProvider = getCanvasEffectsProvider();
	const render = $derived(shape ? getShapeRenderData(shape, { width, height }, { id: id || data?.id }) : null);

	// Brushed strokes: the paint-engine image at the bucketed zoom (the plain path until it is ready).
	const zoom = getShapeNodeZoom();
	const brushed = $derived(isBrushedShape(shape) ? shape : null);
	const brushScale = $derived.by(() => {
		const vb = brushed?.viewBox;
		const nodeScale = vb && width && height && vb[2] > 0 && vb[3] > 0 ? Math.max(width / vb[2], height / vb[3]) : 1;
		return brushstrokeScaleBucket(zoom() * nodeScale, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
	});
	let brushImage = $state.raw<CanvasBrushstrokeImage | null>(null);
	$effect(() => {
		const target = brushed;
		const scale = brushScale;
		const vb = target?.viewBox;
		const unit = vb && width && vb[2] > 0 ? width / vb[2] : 1;
		// Path (0, 0) on the canvas, in whole units so small drags do not re-render.
		const origin = { x: Math.round(positionAbsoluteX - (vb?.[0] ?? 0) * unit), y: Math.round(positionAbsoluteY - (vb?.[1] ?? 0) * unit) };
		if (!target) {
			brushImage = null;
			return;
		}
		let live = true;
		renderShapeBrushstroke(target, { scale, origin, unit }).then(
			(img) => {
				if (live) brushImage = img;
			},
			(error) => {
				if (!live) return;
				brushImage = null;
				console.warn('[pixerate] brushed stroke not rendered:', error instanceof Error ? error.message : error);
			}
		);
		return () => {
			live = false;
		};
	});
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
			{#if render.fillGradient || render.strokeGradient}
				<defs>
					{#if render.fillGradient && render.fillGradient.type === 'linear'}
						<linearGradient id={render.fillGradient.id} {...render.fillGradient.attrs}>
							{#each render.fillGradient.stops as stop}
								<stop offset={stop.offset} stop-color={stop.stopColor} stop-opacity={stop.stopOpacity} />
							{/each}
						</linearGradient>
					{/if}
					{#if render.fillGradient && render.fillGradient.type === 'radial'}
						<radialGradient id={render.fillGradient.id} {...render.fillGradient.attrs}>
							{#each render.fillGradient.stops as stop}
								<stop offset={stop.offset} stop-color={stop.stopColor} stop-opacity={stop.stopOpacity} />
							{/each}
						</radialGradient>
					{/if}
					{#if render.strokeGradient && render.strokeGradient.type === 'linear'}
						<linearGradient id={render.strokeGradient.id} {...render.strokeGradient.attrs}>
							{#each render.strokeGradient.stops as stop}
								<stop offset={stop.offset} stop-color={stop.stopColor} stop-opacity={stop.stopOpacity} />
							{/each}
						</linearGradient>
					{/if}
					{#if render.strokeGradient && render.strokeGradient.type === 'radial'}
						<radialGradient id={render.strokeGradient.id} {...render.strokeGradient.attrs}>
							{#each render.strokeGradient.stops as stop}
								<stop offset={stop.offset} stop-color={stop.stopColor} stop-opacity={stop.stopOpacity} />
							{/each}
						</radialGradient>
					{/if}
				</defs>
			{/if}
			{#if brushImage}
				<g transform={render.transform}>
					<image
						class="pixerate-shape-brushstroke"
						href={brushImage.href}
						x={brushImage.x}
						y={brushImage.y}
						width={brushImage.width}
						height={brushImage.height}
						preserveAspectRatio="none"
						opacity={render.opacity}
					/>
				</g>
			{:else}
			<path
				d={render.d}
				transform={render.transform}
				fill={render.fill}
				fill-rule={render.fillRule}
				stroke={render.stroke}
				stroke-width={render.strokeWidth}
				stroke-linecap={render.strokeLinecap}
				stroke-linejoin={render.strokeLinejoin}
				opacity={render.opacity}
				vector-effect="non-scaling-stroke"
			/>
			{/if}
		</svg>
		{#if shape?.effect && effectsProvider && render && width && height}
			<CanvasNodeEffectLayer provider={effectsProvider} effect={shape.effect} {width} {height} clipPath={render.d} clipTransform={render.transform} />
		{/if}
		{@render children?.()}
	</div>
{/if}
