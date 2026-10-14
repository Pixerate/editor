<script lang="ts">
	import type { CanvasViewport, GuideLine } from '@pixerate/editor/canvas';

	interface Props {
		/** Guide segments in flow coordinates (e.g. `arrange.guides`). */
		guides: GuideLine[];
		/** Current viewport (`useSvelteFlow().getViewport()` or the `viewport` binding). */
		viewport?: CanvasViewport;
		/** Colour of edge and centre guides. */
		color?: string;
		/** Colour of equal-spacing guides. */
		spacingColor?: string;
		/** Colour of measuring lines, their labels and extension lines. */
		measureColor?: string;
		class?: string;
	}

	let {
		guides = [],
		viewport = { x: 0, y: 0, zoom: 1 },
		color = '#f59e0b',
		spacingColor = '#ec4899',
		measureColor = '#ef4444',
		class: className = ''
	}: Props = $props();

	const toScreen = (x: number, y: number) => ({
		x: x * viewport.zoom + viewport.x,
		y: y * viewport.zoom + viewport.y
	});
</script>

{#if guides.length > 0}
	<svg
		class="pixerate-canvas-guides {className}"
		style="position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; z-index: 10;"
		aria-hidden="true"
	>
		{#each guides as guide, i (i)}
			{@const a = toScreen(guide.x1, guide.y1)}
			{@const b = toScreen(guide.x2, guide.y2)}
			<line
				data-kind={guide.kind}
				x1={a.x}
				y1={a.y}
				x2={b.x}
				y2={b.y}
				stroke={guide.kind === 'measure' || guide.kind === 'extension'
					? measureColor
					: guide.kind === 'spacing'
						? spacingColor
						: color}
				stroke-width="1"
				stroke-dasharray={guide.kind === 'centre' ? '4 3' : guide.kind === 'extension' ? '3 3' : undefined}
				shape-rendering="crispEdges"
			/>
		{/each}
		{#each guides as guide, i (i)}
			{#if guide.label}
				{@const mid = toScreen((guide.x1 + guide.x2) / 2, (guide.y1 + guide.y2) / 2)}
				{@const vertical = guide.orientation === 'vertical'}
				{@const width = guide.label.length * 6.5 + 8}
				<!-- Labels sit beside vertical lines and below horizontal ones. -->
				<g
					class="pixerate-canvas-guides__label"
					data-label={guide.label}
					transform="translate({vertical ? mid.x + 4 : mid.x - width / 2} {vertical ? mid.y - 8 : mid.y + 4})"
				>
					<rect {width} height="16" rx="3" fill={measureColor} />
					<text
						x={width / 2}
						y="11.5"
						text-anchor="middle"
						font-size="11"
						font-family="system-ui, sans-serif"
						fill="#fff">{guide.label}</text
					>
				</g>
			{/if}
		{/each}
	</svg>
{/if}
