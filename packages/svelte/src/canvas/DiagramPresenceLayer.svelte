<script lang="ts">
	import { untrack } from 'svelte';
	import type { PresenceStore, PresenceState } from '@pixerate/editor/diagram';

	interface Props {
		presence: PresenceStore;
		/** The canvas viewport (Svelte Flow's `useViewport()`), to place cursors given in canvas coordinates. */
		viewport: { x: number; y: number; zoom: number };
		class?: string;
	}

	let { presence, viewport, class: className = '' }: Props = $props();
	let view: PresenceState = $state.raw(untrack(() => presence.getState()));
	$effect(() => {
		view = presence.getState();
		return presence.subscribe((next) => {
			view = next;
		});
	});
</script>

<!-- Agent cursors and their notes over a canvas, from a `PresenceStore` (see `DiagramDirector`). -->
{#if view.actors.length}
	<div class="pixerate-diagram-presence {className}" aria-hidden="true" style="position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 50;">
		{#each view.actors as a (a.id)}
			<div data-actor={a.id} style="position: absolute; left: 0; top: 0; transform: translate({a.x * viewport.zoom + viewport.x}px, {a.y * viewport.zoom + viewport.y}px);">
				<svg width="18" height="20" viewBox="0 0 12 18" style="display: block; transform-origin: 0 0; {a.pressed ? 'transform: scale(0.85);' : ''}">
					<path d="M0,0 L0,14 L4,10.5 L7,17 L9.5,16 L6.5,9.5 L11.5,9.5 Z" style="fill: {a.color}; stroke: #ffffff; stroke-width: 1;" />
				</svg>
				<span style="position: absolute; left: 14px; top: 16px; white-space: nowrap; border-radius: 4px; padding: 1px 6px; font-size: 11px; font-weight: 600; color: #ffffff; background: {a.color};">{a.message ?? a.name}</span>
			</div>
		{/each}
	</div>
{/if}
