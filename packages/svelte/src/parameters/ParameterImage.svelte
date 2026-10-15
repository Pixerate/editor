<script lang="ts">
  import { parameterLabel, type ImageParameterField } from '@pixerate/editor/parameters';
  import ParameterCommitInput from './ParameterCommitInput.svelte';
  import { parameterButtonClass } from './styles.js';

  interface Props {
    field: ImageParameterField;
    value: string;
    onchange: (value: string) => void;
    /** Turns a picked file into a URL (upload it, or `URL.createObjectURL`). Without it there is no file button. */
    resolveFile?: (file: File) => string | Promise<string>;
    disabled?: boolean;
    id?: string;
  }

  let { field, value, onchange, resolveFile, disabled = false, id }: Props = $props();

  const off = $derived(disabled || !!field.readOnly);
  const name = $derived(parameterLabel(field));

  async function pick(e: Event & { currentTarget: HTMLInputElement }) {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (file && resolveFile) onchange(await resolveFile(file));
  }
</script>

<!-- An image picker: suggested thumbnails, a URL box, an optional file button and a clear button. -->
<div class="space-y-1.5">
  <div class="flex items-center gap-2">
    <div class="flex h-12 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-input bg-muted">
      {#if value}
        <img src={value} alt={name} class="h-full w-full object-cover" />
      {:else}
        <span class="text-[10px] text-muted-foreground">None</span>
      {/if}
    </div>
    <div class="flex min-w-0 flex-1 flex-col gap-1">
      <ParameterCommitInput
        {id}
        aria-label="{name} URL"
        placeholder="Image URL"
        value={value.startsWith('data:') ? '' : value}
        disabled={off}
        oncommit={(text) => onchange(text.trim())}
      />
      <div class="flex gap-1">
        {#if resolveFile}
          <label class="{parameterButtonClass} cursor-pointer {off ? 'pointer-events-none opacity-50' : ''}">
            Choose file…
            <input type="file" class="sr-only" accept={field.accept ?? 'image/*'} disabled={off} aria-label="{name} file" onchange={pick} />
          </label>
        {/if}
        {#if value}
          <button type="button" class={parameterButtonClass} disabled={off} onclick={() => onchange('')} aria-label="Clear {name}">Clear</button>
        {/if}
      </div>
    </div>
  </div>
  {#if field.options && field.options.length > 0}
    <div class="flex flex-wrap gap-1">
      {#each field.options as o (o.url)}
        <button
          type="button"
          title={o.label ?? o.url}
          aria-label={o.label ?? o.url}
          aria-pressed={o.url === value}
          disabled={off}
          onclick={() => onchange(o.url)}
          class="h-9 w-12 overflow-hidden rounded border border-input aria-pressed:ring-2 aria-pressed:ring-ring"
        >
          <img src={o.url} alt="" class="h-full w-full object-cover" />
        </button>
      {/each}
    </div>
  {/if}
</div>
