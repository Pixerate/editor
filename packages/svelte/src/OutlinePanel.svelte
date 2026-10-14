<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import type { Snippet } from "svelte";
  import { navigateToHeading, type OutlineHeading } from "@pixerate/editor";
  import { createOutline } from "./outline.svelte.js";

  interface Props {
    editor?: Editor | null;
    /** Heading shown above the list. Pass `null` to hide it. */
    title?: string | null;
    /** Text shown when the document has no headings. */
    emptyText?: string;
    /** Deepest heading level listed. Defaults to 6. */
    maxLevel?: number;
    /** Whether clicking an entry focuses the editor. Defaults to `true`. */
    focusOnNavigate?: boolean;
    class?: string;
    itemClass?: string;
    activeItemClass?: string;
    /** Called after navigating to a heading. */
    onNavigate?: (heading: OutlineHeading) => void;
    /** Custom empty state, rendered instead of `emptyText`. */
    empty?: Snippet;
  }

  let {
    editor = null,
    title = "Outline",
    emptyText = "Add headings to see the outline.",
    maxLevel = 6,
    focusOnNavigate = true,
    class: className = "flex flex-col gap-1 text-sm",
    itemClass = "w-full truncate rounded px-2 py-1 text-left hover:bg-black/5",
    activeItemClass = "font-semibold bg-black/5",
    onNavigate,
    empty,
  }: Props = $props();

  let outline = $state.raw<ReturnType<typeof createOutline> | null>(null);

  $effect(() => {
    const instance = createOutline(editor);
    outline = instance;
    return () => instance.destroy();
  });

  const snapshot = $derived(outline?.current ?? { headings: [], tree: [], activeId: null });
  const visible = $derived(snapshot.headings.filter((h) => h.level <= maxLevel));

  function navigate(heading: OutlineHeading) {
    if (!editor) return;
    if (navigateToHeading(editor, heading, { focus: focusOnNavigate })) {
      onNavigate?.(heading);
    }
  }
</script>

<nav class={className} aria-label="Document outline" data-outline-panel="">
  {#if title != null}
    <div class="pixerate-outline-title">{title}</div>
  {/if}
  {#if visible.length === 0}
    <div class="pixerate-outline-empty">
      {#if empty}{@render empty()}{:else}{emptyText}{/if}
    </div>
  {:else}
    <ul role="list" style="list-style: none; margin: 0; padding: 0;">
      {#each visible as heading (heading.id)}
        {@const active = heading.id === snapshot.activeId}
        <li data-level={heading.level}>
          <button
            type="button"
            class={active ? `${itemClass} ${activeItemClass}` : itemClass}
            style="padding-left: {0.5 + heading.depth * 0.75}rem"
            aria-current={active ? "location" : undefined}
            data-heading-id={heading.id}
            onclick={() => navigate(heading)}
          >
            {heading.text || "Untitled"}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</nav>
