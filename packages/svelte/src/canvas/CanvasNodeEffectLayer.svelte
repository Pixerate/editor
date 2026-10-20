<script lang="ts">
	import { untrack } from 'svelte';
	import { runCanvasNodeEffect, type CanvasShapeEffect } from '@pixerate/editor/canvas';
	import type { EffectProvider } from '@pixerate/editor/effects';

	interface Props {
		provider: EffectProvider;
		effect: CanvasShapeEffect;
		width: number;
		height: number;
		/** An SVG path (the node's own pixels) the fill is clipped to. */
		clipPath?: string;
		clipTransform?: string;
	}

	let { provider, effect: fx, width, height, clipPath, clipTransform }: Props = $props();
	let canvas = $state<HTMLCanvasElement | null>(null);
	let failed = $state(false);
	const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;
	const pw = $derived(Math.max(1, Math.round(width * dpr)));
	const ph = $derived(Math.max(1, Math.round(height * dpr)));
	const clipId = `pixerate-effect-clip-${Math.random().toString(36).slice(2)}`;

	$effect(() => {
		const target = canvas;
		const p = provider;
		const e = $state.snapshot(fx) as CanvasShapeEffect;
		void pw;
		void ph;
		if (!target) return;
		failed = false;
		const run = untrack(() => runCanvasNodeEffect({ provider: p, effect: e, target, onError: () => (failed = true) }));
		return () => run.stop();
	});
</script>

<!-- Draws a shape node's effect: `fill` inside the shape, `overlay` over the whole node. -->
{#if !failed && width > 0 && height > 0}
	{#if fx.mode === 'overlay' || !clipPath}
		<div style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:{fx.opacity ?? 1}">
			<canvas bind:this={canvas} width={pw} height={ph} style="width:100%;height:100%;display:block" data-canvas-effect={fx.effect}></canvas>
		</div>
	{:else}
		<svg style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:{fx.opacity ?? 1}" viewBox="0 0 {width} {height}" preserveAspectRatio="none" aria-hidden="true">
			<defs>
				<clipPath id={clipId}><path d={clipPath} transform={clipTransform} /></clipPath>
			</defs>
			<foreignObject x="0" y="0" {width} {height} clip-path="url(#{clipId})">
				<canvas bind:this={canvas} width={pw} height={ph} style="width:100%;height:100%;display:block" data-canvas-effect={fx.effect}></canvas>
			</foreignObject>
		</svg>
	{/if}
{/if}
