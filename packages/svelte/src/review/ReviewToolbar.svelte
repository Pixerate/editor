<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import { createTrackChanges, type SvelteTrackChanges } from "./review.svelte.js";

  interface Props {
    editor?: Editor | null;
    class?: string;
  }

  let {
    editor = null,
    class: className = "flex flex-wrap items-center gap-1 rounded-md border border-border bg-background p-1 text-sm",
  }: Props = $props();

  const buttonClass =
    "rounded px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent";

  let review = $state.raw<SvelteTrackChanges>(createTrackChanges(null));

  $effect(() => {
    const r = createTrackChanges(editor);
    review = r;
    return () => r.destroy();
  });

  let count = $derived(review.changes.length);
  let current = $derived(review.currentChange);
  let index = $derived(current ? review.changes.findIndex((c) => c.id === current.id) + 1 : 0);
</script>

<div class={className} role="toolbar" aria-label="Review">
  <button
    type="button"
    class={`${buttonClass} ${review.enabled ? "bg-primary/10 text-primary" : ""}`}
    aria-pressed={review.enabled}
    disabled={!editor}
    onclick={() => review.toggle()}
  >
    {review.enabled ? "Tracking on" : "Track changes"}
  </button>
  <span class="mx-1 h-4 w-px bg-border" aria-hidden="true"></span>
  <button
    type="button"
    class={buttonClass}
    aria-label="Previous change"
    disabled={count === 0}
    onclick={() => review.previous()}
  >
    ‹
  </button>
  <span class="min-w-[4rem] text-center text-xs text-muted-foreground" aria-live="polite">
    {count === 0 ? "No changes" : current ? `${index} of ${count}` : `${count} changes`}
  </span>
  <button
    type="button"
    class={buttonClass}
    aria-label="Next change"
    disabled={count === 0}
    onclick={() => review.next()}
  >
    ›
  </button>
  <span class="mx-1 h-4 w-px bg-border" aria-hidden="true"></span>
  <button
    type="button"
    class={buttonClass}
    disabled={!current}
    onclick={() => current && review.accept(current.id)}
  >
    Accept
  </button>
  <button
    type="button"
    class={buttonClass}
    disabled={!current}
    onclick={() => current && review.reject(current.id)}
  >
    Reject
  </button>
  <button type="button" class={buttonClass} disabled={count === 0} onclick={() => review.acceptAll()}>
    Accept all
  </button>
  <button type="button" class={buttonClass} disabled={count === 0} onclick={() => review.rejectAll()}>
    Reject all
  </button>
</div>
