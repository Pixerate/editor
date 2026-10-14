<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import { createParagraphStyles, type SvelteParagraphStyles } from "./paragraphStyles.svelte.js";

  interface Props {
    editor?: Editor | null;
    /**
     * `dropdown` (default): a button showing the current style that opens the
     * list. `gallery`: the styles are always shown, in a row.
     */
    variant?: "dropdown" | "gallery";
    /** List every available paragraph style instead of the gallery (quick) styles. */
    showAllStyles?: boolean;
    /** Show the "Update to match selection" and "New style from selection" actions. Defaults to `true`. */
    showActions?: boolean;
    /** Preview each style's font, weight, style and color in its entry. Defaults to `true`. */
    preview?: boolean;
    class?: string;
    itemClass?: string;
    activeItemClass?: string;
    /** Called after a style is applied, updated or created. */
    onchange?: (event: { type: "apply" | "update" | "create"; id: string }) => void;
  }

  let {
    editor = null,
    variant = "dropdown",
    showAllStyles = false,
    showActions = true,
    preview = true,
    class: className = "relative inline-flex flex-wrap items-center gap-1 text-sm",
    itemClass = "rounded px-2 py-1 text-left text-xs text-foreground hover:bg-muted",
    activeItemClass = "bg-primary/10 text-primary",
    onchange,
  }: Props = $props();

  let styles = $state.raw<SvelteParagraphStyles>(createParagraphStyles(null));
  $effect(() => {
    const s = createParagraphStyles(editor);
    styles = s;
    return () => s.destroy();
  });

  let open = $state(false);
  let creating = $state(false);
  let name = $state("");

  let list = $derived(showAllStyles ? styles.current.styles : styles.current.gallery);
  let current = $derived(styles.currentStyle);
  let expanded = $derived(variant === "gallery" || open);

  function close() {
    if (variant === "dropdown") open = false;
    creating = false;
    name = "";
  }

  function previewStyle(id: string): string | undefined {
    if (!preview || !styles.registry) return undefined;
    return Object.entries(styles.registry.previewDeclarations(id))
      .map(([property, value]) => `${property}: ${value}`)
      .join("; ");
  }

  function apply(id: string) {
    if (styles.apply(id)) onchange?.({ type: "apply", id });
    close();
  }

  function update() {
    if (current && styles.updateFromSelection(current.id)) {
      onchange?.({ type: "update", id: current.id });
    }
    close();
  }

  function create(event: SubmitEvent) {
    event.preventDefault();
    const id = name.trim() ? styles.createFromSelection(name) : null;
    if (id) onchange?.({ type: "create", id });
    close();
  }

  const keepSelection = (event: MouseEvent) => event.preventDefault();
</script>

<div class={className} role="group" aria-label="Paragraph styles" data-styles-gallery={variant}>
  {#if variant === "dropdown"}
    <button
      type="button"
      class={itemClass}
      aria-haspopup="listbox"
      aria-expanded={open}
      disabled={!editor || !styles.registry}
      onmousedown={keepSelection}
      onclick={() => (open = !open)}
    >
      {current?.name ?? "Styles"} ▾
    </button>
  {/if}
  {#if expanded}
    <div
      class={variant === "dropdown"
        ? "absolute left-0 top-full z-20 mt-1 flex min-w-[12rem] flex-col gap-0.5 rounded-md border border-border bg-background p-1 shadow-md"
        : "flex flex-wrap items-center gap-1"}
    >
      <div
        role="listbox"
        aria-label="Styles"
        class={variant === "dropdown" ? "flex flex-col gap-0.5" : "flex flex-wrap gap-1"}
      >
        {#each list as style (style.id)}
          {@const active = style.id === styles.current.currentStyleId}
          <button
            type="button"
            role="option"
            aria-selected={active}
            data-style-id={style.id}
            class={active ? `${itemClass} ${activeItemClass}` : itemClass}
            style={previewStyle(style.id)}
            onmousedown={keepSelection}
            onclick={() => apply(style.id)}
          >
            {style.name}
          </button>
        {/each}
      </div>
      {#if showActions}
        <div
          class={variant === "dropdown"
            ? "mt-1 flex flex-col gap-0.5 border-t border-border pt-1"
            : "flex items-center gap-1"}
        >
          <button
            type="button"
            class={itemClass}
            disabled={!current}
            onmousedown={keepSelection}
            onclick={update}
          >
            {current ? `Update ${current.name} to match selection` : "Update to match selection"}
          </button>
          {#if creating}
            <form class="flex items-center gap-1" onsubmit={create}>
              <!-- svelte-ignore a11y_autofocus -->
              <input
                aria-label="New style name"
                class="w-32 rounded border border-border bg-background px-1 py-0.5 text-xs"
                bind:value={name}
                autofocus
              />
              <button type="submit" class={itemClass} disabled={!name.trim()}>Create</button>
            </form>
          {:else}
            <button
              type="button"
              class={itemClass}
              disabled={!editor || !styles.registry}
              onmousedown={keepSelection}
              onclick={() => (creating = true)}
            >
              New style from selection
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>
