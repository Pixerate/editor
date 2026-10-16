<script lang="ts">
	import type { CanvasNode } from './types.js';
	import type { CanvasDraw } from './createCanvasDraw.svelte.js';
	import {
		strokePointsToPathData,
		resolveCanvasGradient,
		gradientToSvgDef,
		type CanvasViewport
	} from '@pixerate/editor/canvas';

	interface Props<TNode extends CanvasNode = CanvasNode> {
		/** Draw state and controller actions from `createCanvasDraw`. */
		draw: CanvasDraw<TNode>;
		/** Current viewport (`useSvelteFlow().getViewport()` or the `viewport` binding). */
		viewport?: CanvasViewport;
		/** Optional class name on the root SVG overlay element. */
		class?: string;
		/** Cursor styling override when drawing or erasing. */
		cursor?: string;
		/** Eraser circle preview radius in screen pixels (default: 12). */
		eraserRadius?: number;
	}

	let {
		draw,
		viewport = { x: 0, y: 0, zoom: 1 },
		class: className = '',
		cursor,
		eraserRadius = 12
	}: Props = $props();

	let svgEl = $state<SVGSVGElement | null>(null);
	let spaceHeld = $state(false);
	let eraserPos = $state<[number, number] | null>(null);

	function onKeyDown(e: KeyboardEvent) {
		if (e.code === 'Space' && !e.repeat) {
			const tag = (e.target as HTMLElement)?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) {
				return;
			}
			spaceHeld = true;
		}
	}

	function onKeyUp(e: KeyboardEvent) {
		if (e.code === 'Space') {
			spaceHeld = false;
		}
	}

	$effect(() => {
		if (typeof window === 'undefined') return;
		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('keyup', onKeyUp);
		return () => {
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('keyup', onKeyUp);
		};
	});

	function clientToFlow(clientX: number, clientY: number): [number, number] {
		if (!svgEl) return [0, 0];
		const rect = svgEl.getBoundingClientRect();
		const screenX = clientX - rect.left;
		const screenY = clientY - rect.top;
		const flowX = (screenX - viewport.x) / viewport.zoom;
		const flowY = (screenY - viewport.y) / viewport.zoom;
		return [flowX, flowY];
	}

	let isDrawingMode = $derived(draw.tool !== 'select');
	let interactive = $derived(isDrawingMode && !spaceHeld);

	let resolvedCursor = $derived(
		cursor
			? cursor
			: spaceHeld
				? 'grab'
				: draw.tool === 'eraser'
					? 'crosshair'
					: draw.tool === 'pen' || draw.tool === 'highlighter'
						? 'crosshair'
						: 'default'
	);

	let strokePath = $derived(
		draw.activeStroke ? strokePointsToPathData(draw.activeStroke.points) : null
	);

	let activeGradient = $derived(
		draw.activeStroke
			? resolveCanvasGradient(draw.activeStroke.style.gradient ?? draw.activeStroke.style.color)
			: null
	);
	let resolvedGradientDef = $derived(
		activeGradient ? gradientToSvgDef(activeGradient, 'active-draw-stroke-gradient-svelte') : null
	);
	let strokePaint = $derived(
		resolvedGradientDef
			? `url(#${resolvedGradientDef.id})`
			: draw.activeStroke
				? (draw.activeStroke.style.color as string)
				: 'currentColor'
	);

	function handlePointerDown(e: PointerEvent) {
		if (!interactive || e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		(e.target as Element).setPointerCapture?.(e.pointerId);

		const flowPt = clientToFlow(e.clientX, e.clientY);
		draw.startStroke(flowPt);

		if (draw.tool === 'eraser') {
			eraserPos = [e.clientX, e.clientY];
		}
	}

	function handlePointerMove(e: PointerEvent) {
		if (draw.tool === 'eraser' && !spaceHeld) {
			eraserPos = [e.clientX, e.clientY];
		}

		if (!interactive) return;
		if (e.buttons === 1) {
			e.preventDefault();
			e.stopPropagation();
			const flowPt = clientToFlow(e.clientX, e.clientY);
			draw.continueStroke(flowPt);
		}
	}

	function handlePointerUp(e: PointerEvent) {
		if (!interactive || e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		try {
			(e.target as Element).releasePointerCapture?.(e.pointerId);
		} catch {
			// ignore
		}
		draw.endStroke();
	}

	function handlePointerLeave() {
		eraserPos = null;
	}
</script>

<svg
	bind:this={svgEl}
	role="presentation"
	class="pixerate-canvas-draw-layer {className}"
	style="position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: {interactive ? 'all' : 'none'}; cursor: {interactive ? resolvedCursor : 'default'}; overflow: visible; z-index: 20; touch-action: none;"
	onpointerdown={handlePointerDown}
	onpointermove={handlePointerMove}
	onpointerup={handlePointerUp}
	onpointerleave={handlePointerLeave}
>
	{#if resolvedGradientDef}
		<defs>
			{#if resolvedGradientDef.type === 'linear'}
				<linearGradient id={resolvedGradientDef.id} {...resolvedGradientDef.attrs}>
					{#each resolvedGradientDef.stops as stop}
						<stop offset={stop.offset} stop-color={stop.stopColor} stop-opacity={stop.stopOpacity} />
					{/each}
				</linearGradient>
			{/if}
			{#if resolvedGradientDef.type === 'radial'}
				<radialGradient id={resolvedGradientDef.id} {...resolvedGradientDef.attrs}>
					{#each resolvedGradientDef.stops as stop}
						<stop offset={stop.offset} stop-color={stop.stopColor} stop-opacity={stop.stopOpacity} />
					{/each}
				</radialGradient>
			{/if}
		</defs>
	{/if}

	<g transform="translate({viewport.x}, {viewport.y}) scale({viewport.zoom})">
		{#if draw.activeStroke && strokePath}
			<path
				d={strokePath}
				fill="none"
				stroke={strokePaint}
				stroke-width={draw.activeStroke.style.width}
				opacity={draw.activeStroke.style.opacity}
				stroke-linecap={draw.activeStroke.style.cap ?? 'round'}
				stroke-linejoin={draw.activeStroke.style.join ?? 'round'}
			/>
		{/if}
	</g>

	{#if draw.tool === 'eraser' && eraserPos && svgEl}
		{@const rect = svgEl.getBoundingClientRect()}
		<circle
			cx={eraserPos[0] - rect.left}
			cy={eraserPos[1] - rect.top}
			r={eraserRadius}
			fill="rgba(239, 68, 68, 0.15)"
			stroke="rgba(239, 68, 68, 0.8)"
			stroke-width="1.5"
			stroke-dasharray="3 3"
			pointer-events="none"
		/>
	{/if}
</svg>
