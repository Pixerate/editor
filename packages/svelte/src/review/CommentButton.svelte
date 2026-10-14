<script lang="ts">
  import type { Editor } from "@tiptap/core";

  interface Props {
    editor?: Editor | null;
    class?: string;
    children?: import("svelte").Snippet;
  }

  let {
    editor = null,
    class: className = "rounded px-2 py-1 text-xs text-popover-foreground hover:bg-muted",
    children,
  }: Props = $props();
</script>

<!--
  Adds a draft comment on the selection; drop it into a `BubbleMenu`. The
  draft is completed in `CommentsPanel`.
-->
<button
  type="button"
  class={className}
  disabled={!editor}
  onclick={() => editor?.chain().focus().addComment().run()}
>
  {#if children}
    {@render children()}
  {:else}
    Comment
  {/if}
</button>
