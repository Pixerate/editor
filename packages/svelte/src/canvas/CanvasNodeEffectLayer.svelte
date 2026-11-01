<script lang="ts">
	import { untrack } from 'svelte';
	import { CANVAS_EFFECT_MISSING_PATTERN, canvasEffectErrorReason, canvasEffectStatus, runCanvasNodeEffect, type CanvasShapeEffect } from '@pixerate/editor/canvas';
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
	let failed = $state<string | null>(null);
	const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;
	const pw = $derived(Math.max(1, Math.round(width * dpr)));
	const ph = $derived(Math.max(1, Math.round(height * dpr)));
	const clipId = `pixerate-effect-clip-${Math.random().toString(36).slice(2)}`;
	const missingId = `pixerate-effect-missing-${Math.random().toString(36).slice(2)}`;
	const status = $derived(canvasEffectStatus(fx, provider));
	const missing = $derived(!status.ok ? status.reason : failed);

	$effect(() => {
		const target = canvas;
		const p = provider;
		const e = $state.snapshot(fx) as CanvasShapeEffect;
		void pw;
		void ph;
		if (!target || !canvasEffectStatus(e, p).ok) return;
		failed = null;
		const run = untrack(() => runCanvasNodeEffect({ provider: p, effect: e, target, onError: (err) => (failed = canvasEffectErrorReason(e, err)) }));
		return () => run.stop();
	});
</script>

<!-- Draws a shape node's effect: `fill` inside the shape, `overlay` over the whole node; a faint hatch with the reason when it cannot be drawn. -->
{#if missing && width > 0 && height > 0}
	{#if fx.mode === 'overlay' || !clipPath}
		<div role="img" aria-label={missing} title={missing} data-canvas-effect-missing={fx.effect} style="position:absolute;inset:0;pointer-events:none;background:{CANVAS_EFFECT_MISSING_PATTERN}"></div>
	{:else}
		<svg role="img" aria-label={missing} data-canvas-effect-missing={fx.effect} style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none" viewBox="0 0 {width} {height}" preserveAspectRatio="none">
			<title>{missing}</title>
			<defs>
				<pattern id={missingId} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="8" fill="rgba(128,128,128,0.28)" /></pattern>
			</defs>
			<path d={clipPath} transform={clipTransform} fill="url(#{missingId})" />
		</svg>
	{/if}
{:else if width > 0 && height > 0}
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
