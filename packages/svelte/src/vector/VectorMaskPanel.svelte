<script lang="ts">
  import { VECTOR_MASK_TYPE_OPTIONS, getVectorMaskPanel, type VectorEditorController, type VectorMaskType } from '@pixerate/editor/vector';
  import { vectorStateOf } from './subscribe.svelte.js';

  /**
   * Masks of the selection: Make Clipping Mask, Make Opacity Mask (the topmost selected object
   * masks the others) and Release; for a mask group (or something inside one) its type, Invert, a
   * switch that turns the mask off by hiding it, and Edit Mask / Edit Contents, which select the
   * mask (a path opens for anchor editing) or what it masks. Each change is one undo step.
   */
  interface Props {
    controller: VectorEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();

  const store = vectorStateOf(() => controller);
  const view = $derived(store.current);
  const panel = $derived(getVectorMaskPanel(view));
  const g = $derived(panel?.group ?? null);
  const ids = $derived(g ? [g.id] : undefined);

  const buttonClass =
    'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-primary aria-pressed:text-primary-foreground';
  const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
</script>

{#if panel}
  <div class="space-y-2 {className}" data-vector-mask-panel="" aria-label="Mask">
    <div class="flex flex-wrap items-center gap-1">
      <span class="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Mask</span>
      <button
        type="button"
        data-vector-mask-action="clip"
        class={buttonClass}
        title={panel.makeHint ?? 'Make Clipping Mask: the topmost object clips the others'}
        aria-label="Make Clipping Mask"
        disabled={!panel.canMake}
        onclick={() => controller.makeMask('clip')}
      >
        Clip
      </button>
      <button
        type="button"
        data-vector-mask-action="opacity"
        class={buttonClass}
        title={panel.makeHint ?? 'Make Opacity Mask: the topmost object fades the others by its brightness'}
        aria-label="Make Opacity Mask"
        disabled={!panel.canMake}
        onclick={() => controller.makeMask('luminance')}
      >
        Opacity
      </button>
      <button
        type="button"
        data-vector-mask-action="release"
        class={buttonClass}
        title="Release: the mask goes back on top and draws as itself"
        aria-label="Release Mask"
        disabled={!g}
        onclick={() => controller.releaseMask({ ids })}
      >
        Release
      </button>
    </div>
    {#if g}
      <div class="space-y-2" data-vector-mask-group={g.id} data-mask-type={g.type}>
        <div class="flex items-center gap-1">
          <select
            aria-label="Mask type"
            class={selectClass}
            value={g.type}
            title={VECTOR_MASK_TYPE_OPTIONS.find((o) => o.value === g.type)?.title}
            onchange={(e) => controller.setMaskOptions({ type: e.currentTarget.value as VectorMaskType }, { ids })}
          >
            {#each VECTOR_MASK_TYPE_OPTIONS as o (o.value)}
              <option value={o.value} title={o.title}>{o.label}</option>
            {/each}
          </select>
          <label class="flex items-center gap-1 text-xs text-foreground" title="Show the contents where the mask hides them">
            <input type="checkbox" aria-label="Invert mask" checked={g.invert} onchange={(e) => controller.setMaskOptions({ invert: e.currentTarget.checked }, { ids })} />
            Invert
          </label>
        </div>
        <div class="flex flex-wrap items-center gap-1">
          <button
            type="button"
            data-vector-mask-action="edit-mask"
            class={buttonClass}
            aria-pressed={g.editing === 'mask'}
            title="Edit Mask: select the mask (a path opens for anchor editing)"
            aria-label="Edit Mask"
            onclick={() => controller.editMask({ id: g.id })}
          >
            Edit mask
          </button>
          <button
            type="button"
            data-vector-mask-action="edit-contents"
            class={buttonClass}
            aria-pressed={g.editing === 'contents'}
            title="Edit Contents: select what the mask masks"
            aria-label="Edit Contents"
            disabled={!g.contents.length}
            onclick={() => controller.editMaskContents({ id: g.id })}
          >
            Contents
          </button>
          <button
            type="button"
            data-vector-mask-action="toggle"
            class={buttonClass}
            aria-pressed={g.enabled}
            title={g.enabled ? 'Turn the mask off (hide it): the contents draw whole' : 'Turn the mask on'}
            aria-label="Mask on"
            onclick={() => controller.setMaskOptions({ enabled: !g.enabled }, { ids })}
          >
            {g.enabled ? 'On' : 'Off'}
          </button>
        </div>
      </div>
    {/if}
  </div>
{/if}
