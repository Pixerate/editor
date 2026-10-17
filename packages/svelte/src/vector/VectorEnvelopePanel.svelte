<script lang="ts">
  import { VECTOR_ENVELOPE_STYLE_OPTIONS, getVectorEnvelopePanel, type VectorEditorController, type VectorEnvelopeParams } from '@pixerate/editor/vector';
  import { vectorStateOf } from './subscribe.svelte.js';

  /**
   * Envelope distortion of the selection: Make with Warp, Mesh or Top Object, and for one selected
   * object with an envelope its warp preset, bend, horizontal and vertical distortion, orientation
   * and mesh rows and columns, plus Release and Expand. Edit the mesh on the canvas with the
   * Envelope tool. Slider drags are one undo step each.
   */
  interface Props {
    controller: VectorEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();

  const store = vectorStateOf(() => controller);
  const view = $derived(store.current);
  const panel = $derived(getVectorEnvelopePanel(view));
  const env = $derived(panel?.envelope ?? null);
  // The mesh size Make with Mesh uses (an envelope's own size once it has one).
  let size = $state({ rows: 2, columns: 2 });
  const rows = $derived(env?.params.rows ?? size.rows);
  const columns = $derived(env?.params.columns ?? size.columns);

  const buttonClass =
    'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40';
  const numberClass = 'h-7 w-14 rounded border border-border bg-background px-1.5 text-xs';
  const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
  const labelClass = 'w-full truncate text-[11px] text-muted-foreground';

  const SLIDERS: { key: 'bend' | 'horizontal' | 'vertical'; label: string }[] = [
    { key: 'bend', label: 'Bend %' },
    { key: 'horizontal', label: 'Horizontal distortion %' },
    { key: 'vertical', label: 'Vertical distortion %' }
  ];

  const end = () => controller.endMergedEdit();
  function set(patch: Partial<VectorEnvelopeParams>, merge = false) {
    controller.envelope(patch, { ids: panel?.nodeId ? [panel.nodeId] : undefined, merge });
  }
  function setSlider(key: 'bend' | 'horizontal' | 'vertical', raw: string) {
    const n = parseFloat(raw);
    if (Number.isFinite(n)) set({ [key]: n }, true);
  }
  function setCount(key: 'rows' | 'columns', raw: string) {
    const n = Math.round(parseFloat(raw));
    if (!Number.isFinite(n) || n < 1 || n > 16) return;
    if (env) set({ [key]: n });
    else size = { ...size, [key]: n };
  }
</script>

{#if panel}
  <div class="space-y-2 {className}" data-vector-envelope="" aria-label="Envelope">
    <div class="flex flex-wrap items-center gap-1">
      <span class="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Envelope</span>
      <button
        type="button"
        data-vector-envelope-action="warp"
        class={buttonClass}
        title="Make with Warp"
        aria-label="Make with Warp"
        disabled={!panel.canMake || !!env}
        onclick={() => set({ style: 'arc', bend: 50 })}
      >
        Warp
      </button>
      <button
        type="button"
        data-vector-envelope-action="mesh"
        class={buttonClass}
        title="Make with Mesh"
        aria-label="Make with Mesh"
        disabled={!panel.canMake || !!env}
        onclick={() => set({ style: 'mesh', rows: size.rows, columns: size.columns })}
      >
        Mesh
      </button>
      <button
        type="button"
        data-vector-envelope-action="top"
        class={buttonClass}
        title="Make with Top Object"
        aria-label="Make with Top Object"
        disabled={!panel.canMakeWithTopObject}
        onclick={() => controller.makeEnvelopeWithTopObject({ rows: size.rows, columns: size.columns })}
      >
        Top
      </button>
      <button
        type="button"
        data-vector-envelope-action="release"
        class={buttonClass}
        title="Release Envelope"
        aria-label="Release Envelope"
        disabled={!panel.canRelease}
        onclick={() => controller.releaseEnvelope()}
      >
        Release
      </button>
      <button
        type="button"
        data-vector-envelope-action="expand"
        class={buttonClass}
        title="Expand Envelope"
        aria-label="Expand Envelope"
        disabled={!panel.canRelease}
        onclick={() => controller.expandAppearance()}
      >
        Expand
      </button>
    </div>
    {#if env}
      <label class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-foreground" data-vector-envelope-param="style">
        <span class={labelClass}>Warp</span>
        <select
          aria-label="Envelope warp"
          class={selectClass}
          value={env.params.style}
          onchange={(e) => set({ style: e.currentTarget.value as VectorEnvelopeParams['style'] })}
        >
          {#each VECTOR_ENVELOPE_STYLE_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
        </select>
      </label>
      {#if env.params.style !== 'mesh'}
        {#each SLIDERS as s (s.key)}
          <label class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-foreground" data-vector-envelope-param={s.key}>
            <span class={labelClass}>{s.label}</span>
            <input
              type="range"
              min="-100"
              max="100"
              step="1"
              aria-label="Envelope {s.label} slider"
              class="h-4 min-w-0 flex-1 accent-primary"
              value={env.params[s.key]}
              oninput={(e) => setSlider(s.key, e.currentTarget.value)}
              onpointerup={end}
              onkeyup={end}
              onblur={end}
            />
            <input
              type="number"
              min="-100"
              max="100"
              step="1"
              aria-label="Envelope {s.label}"
              class={numberClass}
              value={env.params[s.key]}
              oninput={(e) => setSlider(s.key, e.currentTarget.value)}
              onblur={end}
            />
          </label>
        {/each}
        <label class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-foreground" data-vector-envelope-param="orientation">
          <span class={labelClass}>Orientation</span>
          <select
            aria-label="Envelope orientation"
            class={selectClass}
            value={env.params.orientation}
            onchange={(e) => set({ orientation: e.currentTarget.value as 'horizontal' | 'vertical' })}
          >
            <option value="horizontal">Horizontal</option>
            <option value="vertical">Vertical</option>
          </select>
        </label>
      {/if}
    {/if}
    <div class="flex items-center gap-2 text-xs text-foreground" data-vector-envelope-param="mesh">
      <span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">Mesh rows × columns</span>
      <input type="number" min="1" max="16" step="1" aria-label="Envelope mesh rows" class={numberClass} value={rows} oninput={(e) => setCount('rows', e.currentTarget.value)} />
      <input type="number" min="1" max="16" step="1" aria-label="Envelope mesh columns" class={numberClass} value={columns} oninput={(e) => setCount('columns', e.currentTarget.value)} />
    </div>
    {#if panel.count > 1 && !panel.canMakeWithTopObject}<p class="text-[11px] text-muted-foreground">Select one object to edit its envelope.</p>{/if}
    {#if env}<p class="text-[11px] text-muted-foreground">Edit the mesh with the Envelope tool (U).</p>{/if}
  </div>
{/if}
