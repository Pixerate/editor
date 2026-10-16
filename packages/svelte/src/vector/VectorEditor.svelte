<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import type { VectorEditorController, VectorTool } from '@pixerate/editor/vector';
  import VectorCanvas from './VectorCanvas.svelte';
  import VectorStylePanel from './VectorStylePanel.svelte';
  import VectorToolbar from './VectorToolbar.svelte';

  interface Props {
    controller: VectorEditorController;
    /** Tools in the toolbar (default: all). */
    tools?: readonly VectorTool[];
    /** The style sidebar (default `true`). */
    showStylePanel?: boolean;
    /** Canvas height (default 520px). */
    height?: number | string;
    canvasProps?: Omit<ComponentProps<typeof VectorCanvas>, 'controller'>;
    class?: string;
  }

  let { controller, tools, showStylePanel = true, height = 520, canvasProps = {}, class: className = '' }: Props = $props();
</script>

<div class="flex flex-col gap-2 {className}" data-vector-editor="">
  <VectorToolbar {controller} {tools} />
  <div class="flex min-h-0 flex-col gap-2 md:flex-row">
    <div
      class="relative min-h-[320px] flex-1 overflow-hidden rounded-md border border-border bg-muted/40"
      style="height:{typeof height === 'number' ? `${height}px` : height}"
    >
      <VectorCanvas {controller} {...canvasProps} />
    </div>
    {#if showStylePanel}
      <VectorStylePanel {controller} class="w-full shrink-0 rounded-md border border-border p-3 md:w-56" />
    {/if}
  </div>
</div>
