<script lang="ts">
  import { insertSticker, type StickerInsertHost, type StickerProvider } from '@pixerate/editor/stickers';
  import StickerLibraryPicker from './StickerLibraryPicker.svelte';

  interface Props {
    provider: StickerProvider;
    /** Where stickers go: `createVectorStickerHost`, `createImageStickerHost`, `createCanvasStickerHost` or your own. */
    host: StickerInsertHost;
    /** Called with what was inserted (its id, ref, size and licence). */
    oninserted?: (result: Awaited<ReturnType<typeof insertSticker>>) => void;
    class?: string;
  }
  let { provider, host, oninserted, class: className = '' }: Props = $props();
  let tint = $state<string | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);
</script>

<!-- Pick a sticker to insert it into an editor (one undo step), centred at its natural size, tinted when asked: the panel counterpart of insert_sticker. -->
<div class={`flex flex-col gap-1.5 text-xs ${className}`} data-testid="sticker-insert">
  <StickerLibraryPicker
    {provider}
    label="Insert sticker"
    onpick={(it) => {
      busy = true;
      error = null;
      insertSticker(provider, host, { ref: it.ref, ...(tint && it.tintable ? { color: tint } : {}) })
        .then((r) => oninserted?.(r))
        .catch((e: unknown) => (error = e instanceof Error ? e.message : String(e)))
        .finally(() => (busy = false));
    }}
  />
  <label class="flex items-center gap-2">
    <input type="checkbox" aria-label="Tint stickers" checked={tint !== null} onchange={(e) => (tint = e.currentTarget.checked ? '#2563eb' : null)} /> Tint
    {#if tint !== null}<input type="color" aria-label="Sticker tint" value={tint} oninput={(e) => (tint = e.currentTarget.value)} />{/if}
    {#if busy}<span class="text-slate-500">Inserting…</span>{/if}
  </label>
  {#if error}<p role="alert" class="text-[11px] text-rose-400">{error}</p>{/if}
</div>
