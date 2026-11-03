<script lang="ts">
  import type { PaintEditorController, StickerProvider } from '@pixerate/editor/paint-editor';
  import StickerLibraryPicker from '../stickers/StickerLibraryPicker.svelte';

  interface Props {
    controller: PaintEditorController;
    /** Refs shown as chosen. */
    selected: readonly string[];
    /** Called with a sticker's ref when it is clicked. */
    onpick: (ref: string) => void;
    /** Accessible name of the sticker list (default "Stickers"). */
    label?: string;
  }
  let { controller, selected, onpick, label = 'Stickers' }: Props = $props();
  // The library set later (setStickersProvider) replaces this one; null until the effect runs.
  let changed = $state<StickerProvider | null>(null);
  $effect(() => {
    changed = null;
    return controller.stickers.subscribe((p) => (changed = p));
  });
  const provider = $derived(changed ?? controller.stickersProvider);
  const failed = $derived(selected.map((ref) => ({ ref, ...controller.stickerArtStatus(ref) })).filter((x) => x.status === 'failed'));
</script>

<!-- Stickers from the paint editor's sticker library (followed when it changes); clicking one calls onpick with its ref. Chosen stickers whose art failed to load say why. -->
<StickerLibraryPicker {provider} {selected} {label} onpick={(it) => onpick(it.ref)}>
  {#snippet footer()}
    {#each failed as f (f.ref)}<p role="alert" class="text-[11px] text-rose-400">{f.ref}: {f.error}</p>{/each}
  {/snippet}
</StickerLibraryPicker>
