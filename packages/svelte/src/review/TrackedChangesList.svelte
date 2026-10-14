<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import { trackedChangeLabel } from "@pixerate/editor";
  import { createTrackChanges, type SvelteTrackChanges } from "./review.svelte.js";

  interface Props {
    editor?: Editor | null;
    class?: string;
    itemClass?: string;
    activeItemClass?: string;
    /** Text shown when there are no changes. */
    emptyState?: string;
  }

  let {
    editor = null,
    class: className = "flex flex-col gap-1 text-sm",
    itemClass = "flex items-center gap-2 rounded px-2 py-1 hover:bg-muted/50",
    activeItemClass = "bg-primary/10",
    emptyState = "No tracked changes.",
  }: Props = $props();

  const buttonClass =
    "rounded px-1.5 py-0.5 text-xs text-foreground hover:bg-muted disabled:opacity-40";

  let review = $state.raw<SvelteTrackChanges>(createTrackChanges(null));

  $effect(() => {
    const r = createTrackChanges(editor);
    review = r;
    return () => r.destroy();
  });
</script>

{#if review.changes.length === 0}
  <div class={className} data-tracked-changes-list="">
    <div class="pixerate-changes-empty text-xs text-muted-foreground">{emptyState}</div>
  </div>
{:else}
  <ul class={className} role="list" aria-label="Tracked changes" data-tracked-changes-list="">
    {#each review.changes as change (`${change.type}:${change.id}`)}
      <li
        class={change.id === review.currentChangeId ? `${itemClass} ${activeItemClass}` : itemClass}
        data-change-type={change.type}
        data-change-id={change.id}
      >
        <button
          type="button"
          class="min-w-0 flex-1 truncate text-left text-xs"
          title={`${change.author.name}: ${change.description}`}
          onclick={() => review.select(change.id)}
        >
          <span class="font-medium">{trackedChangeLabel(change)}</span>{change.author.name
            ? ` · ${change.author.name}`
            : ""}
          <span class="block truncate text-muted-foreground">{change.description}</span>
        </button>
        <button type="button" class={buttonClass} onclick={() => review.accept(change.id)}>
          Accept
        </button>
        <button type="button" class={buttonClass} onclick={() => review.reject(change.id)}>
          Reject
        </button>
      </li>
    {/each}
  </ul>
{/if}
