<script lang="ts">
  import {
    VECTOR_CONNECTOR_ROUTES,
    VECTOR_CONNECTOR_ROUTE_LABELS,
    VECTOR_CONNECTOR_SIDES,
    VECTOR_CONNECTOR_SIDE_LABELS,
    getVectorConnectorPanel,
    type VectorConnectorRoute,
    type VectorConnectorSide,
    type VectorEditorController
  } from '@pixerate/editor/vector';
  import { vectorStateOf } from './subscribe.svelte.js';

  /**
   * The selected connector: its route (straight, elbow, curved), the elbow corner radius, and for
   * each glued end the side it meets (Auto: the side facing the other end) and Unglue. Each change
   * is one undo step.
   */
  interface Props {
    controller: VectorEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();

  const store = vectorStateOf(() => controller);
  const view = $derived(store.current);
  const panel = $derived(getVectorConnectorPanel(view));
  const ids = $derived(panel ? [panel.id] : []);
  const ends = $derived(
    panel
      ? [
          { key: 'start' as const, label: 'Start', e: panel.start },
          { key: 'end' as const, label: 'End', e: panel.end }
        ]
      : []
  );

  const buttonClass =
    'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40';
  const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
  const numberClass = 'h-7 w-16 rounded border border-border bg-background px-1.5 text-xs';
</script>

{#if panel}
  <div class="space-y-2 {className}" data-vector-connector-panel={panel.id} aria-label="Connector">
    <div class="flex items-center gap-1">
      <span class="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Connector</span>
      <select aria-label="Connector route" class={selectClass} value={panel.route} onchange={(e) => controller.setConnector({ route: e.currentTarget.value as VectorConnectorRoute }, { ids })}>
        {#each VECTOR_CONNECTOR_ROUTES as r (r)}<option value={r}>{VECTOR_CONNECTOR_ROUTE_LABELS[r]}</option>{/each}
      </select>
      {#if panel.route === 'elbow'}
        <input
          type="number"
          min="0"
          step="1"
          aria-label="Elbow radius"
          title="Corner radius of the bends"
          class={numberClass}
          value={panel.radius}
          oninput={(e) => {
            const n = parseFloat(e.currentTarget.value);
            if (Number.isFinite(n) && n >= 0) controller.setConnector({ radius: n }, { ids });
          }}
        />
      {/if}
    </div>
    {#each ends as { key, label, e } (key)}
      <div class="flex items-center gap-1" data-vector-connector-end={key}>
        <span class="w-16 text-xs text-foreground">{label}</span>
        {#if e}
          <select
            aria-label="{label} side"
            class={selectClass}
            value={e.side ?? 'auto'}
            onchange={(ev) => controller.setConnector({ [key]: { nodeId: e.nodeId, side: ev.currentTarget.value as VectorConnectorSide } }, { ids })}
          >
            {#each VECTOR_CONNECTOR_SIDES as s (s)}<option value={s}>{VECTOR_CONNECTOR_SIDE_LABELS[s]}</option>{/each}
          </select>
          <button type="button" class={buttonClass} title="Unglue: the end stays where it is" aria-label="Unglue {label.toLowerCase()}" onclick={() => controller.setConnector({ [key]: null }, { ids })}>Unglue</button>
        {:else}
          <span class="text-[11px] text-muted-foreground">Free</span>
        {/if}
      </div>
    {/each}
  </div>
{/if}
