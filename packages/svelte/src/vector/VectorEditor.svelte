<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import type { VectorEditorController, VectorTool } from '@pixerate/editor/vector';
  import VectorCanvas from './VectorCanvas.svelte';
  import VectorStylePanel from './VectorStylePanel.svelte';
  import VectorToolbar from './VectorToolbar.svelte';
  import type { EffectProvider } from '@pixerate/editor/effects';
  import { useEffects } from '../effects/effects.svelte.js';
  import VectorProviderEffectsPanel from './VectorProviderEffectsPanel.svelte';

  interface Props {
    controller: VectorEditorController;
    /** Tools in the toolbar (default: all). */
    tools?: readonly VectorTool[];
    /** The style sidebar (default `true`). */
    showStylePanel?: boolean;
    /** Canvas height (default 520px). */
    height?: number | string;
    canvasProps?: Omit<ComponentProps<typeof VectorCanvas>, 'controller'>;
    /**
     * An effects provider (see `@pixerate/editor/effects`), registered with the controller while
     * mounted: provider vector effects as groups, with an Effects section under the style panel.
     * Optional: without one the editor is as before.
     */
    effects?: EffectProvider | null;
    class?: string;
  }

  let { controller, tools, showStylePanel = true, height = 520, canvasProps = {}, effects, class: className = '' }: Props = $props();
  useEffects(() => controller, () => effects);
  const effectsShown = $derived(!!effects || controller.vectorEffectGroups().length > 0);
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
      <div class="flex w-full shrink-0 flex-col gap-2 md:w-56">
        <VectorStylePanel {controller} class="rounded-md border border-border p-3" />
        {#if effectsShown}<VectorProviderEffectsPanel {controller} class="rounded-md border border-border p-3" />{/if}
      </div>
    {/if}
  </div>
</div>
