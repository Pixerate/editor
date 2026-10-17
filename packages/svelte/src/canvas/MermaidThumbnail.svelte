<script lang="ts">
	import type { Snippet } from 'svelte';
	import { parseMermaid, type MermaidDocument } from '@pixerate/editor/diagram';
	import { mermaidThumbnailSvg, type DiagramSvgOptions } from '@pixerate/editor/canvas';

	interface Props extends DiagramSvgOptions {
		/** Mermaid text, or an already parsed document. */
		source: string | MermaidDocument;
		class?: string;
		/** Shown for families that cannot be drawn here (sequence, Gantt, …) and empty diagrams. */
		fallback?: Snippet;
	}

	let { source, class: className = '', fallback, ...options }: Props = $props();
	const doc = $derived(typeof source === 'string' ? parseMermaid(source) : source);
	const drawn = $derived(doc.tier === 'editable' && doc.graph.nodes.length ? mermaidThumbnailSvg(doc, options) : null);
</script>

<!--
	A static preview of a flowchart, state, class or ER diagram (no canvas, no Mermaid runtime):
	`mermaidThumbnailSvg` fitted inside `maxWidth` × `maxHeight` (default 240 × 160).
	The SVG is built by mermaidToSvg with every label escaped.
-->
{#if drawn}
	<span class="pixerate-diagram-thumbnail {className}" style="display: inline-block; line-height: 0;">{@html drawn.svg}</span>
{:else}
	{@render fallback?.()}
{/if}
