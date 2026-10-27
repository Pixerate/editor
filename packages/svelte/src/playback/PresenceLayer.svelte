<script lang="ts">
	import { untrack } from 'svelte';
	import type { PresenceStore, PresenceState } from '@pixerate/editor/tools';

	type Point = { x: number; y: number };

	interface Props {
		/** The cursors to draw, e.g. from `createPlaybackSurface` or a director. */
		presence: PresenceStore;
		/**
		 * How surface coordinates map to this layer's pixels: a canvas viewport
		 * (`x * zoom + viewport.x`), or a function. Default: one to one.
		 */
		viewport?: { x: number; y: number; zoom: number } | ((point: Point) => Point);
		/** Clip the cursors to the layer's box (default true). `false` lets a cursor visit chrome outside it. */
		clip?: boolean;
		class?: string;
	}

	let { presence, viewport, clip = true, class: className = '' }: Props = $props();
	let view: PresenceState = $state.raw(untrack(() => presence.getState()));
	$effect(() => {
		view = presence.getState();
		return presence.subscribe((next) => {
			view = next;
		});
	});

	const map = $derived.by((): ((p: Point) => Point) => {
		const v = viewport;
		if (typeof v === 'function') return v;
		if (v) return (p) => ({ x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y });
		return (p) => p;
	});

	function ring(focus: { x: number; y: number; width: number; height: number }) {
		const tl = map(focus);
		const br = map({ x: focus.x + focus.width, y: focus.y + focus.height });
		return `left: ${tl.x - 4}px; top: ${tl.y - 4}px; width: ${br.x - tl.x + 8}px; height: ${br.y - tl.y + 8}px;`;
	}
</script>

<!--
	Agent cursors with their name tag or note, and a ring around what each one works on. Place it in
	a `position: relative` box over the surface. The `pixerate-presence` class keeps it out of
	snapshots and exports. Parity with React's `<PresenceLayer>`.
-->
{#if view.actors.length}
	<div class="pixerate-presence {className}" aria-hidden="true" data-testid="presence-layer" style="position: absolute; inset: 0; pointer-events: none; overflow: {clip ? 'hidden' : 'visible'}; z-index: 50;">
		{#each view.actors as a (a.id)}
			{#if a.focus}
				<div data-actor-focus={a.id} style="position: absolute; {ring(a.focus)} border-radius: 8px; border: 2px solid {a.color}; background: {a.color}14; transition: all 160ms ease-out;"></div>
			{/if}
			<div data-actor={a.id} style="position: absolute; left: 0; top: 0; transform: translate({map(a).x}px, {map(a).y}px);">
				<svg width="18" height="20" viewBox="0 0 12 18" style="display: block; transform-origin: 0 0; filter: drop-shadow(0 1px 2px rgba(0,0,0,.35)); {a.pressed ? 'transform: scale(0.85);' : ''}">
					<path d="M0,0 L0,14 L4,10.5 L7,17 L9.5,16 L6.5,9.5 L11.5,9.5 Z" style="fill: {a.color}; stroke: #ffffff; stroke-width: 1;" />
				</svg>
				<span style="position: absolute; left: 14px; top: 16px; display: flex; flex-direction: column; align-items: flex-start; gap: 4px;">
					<span style="white-space: nowrap; border-radius: 999px; padding: 1px 7px; font-size: 11px; font-weight: 600; color: #ffffff; background: {a.color};">{a.name}</span>
					{#if a.message}
						<span data-actor-message={a.id} style="width: max-content; max-width: 240px; border-radius: 8px; border-top-left-radius: 0; padding: 4px 8px; font-size: 12px; color: #1e293b; background: #ffffff; box-shadow: 0 4px 12px rgba(15,23,42,.18);">{a.message}</span>
					{/if}
				</span>
			</div>
		{/each}
	</div>
{/if}
