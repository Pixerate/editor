<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import { FIND_OPTION_TOGGLES, formatFindStatus } from "@pixerate/editor";
  import { createFindReplace, type SvelteFindReplace } from "./findReplace.svelte.js";

  interface Props {
    editor?: Editor | null;
    class?: string;
    /** Render even while the find state is closed (default: only after Mod+F / Mod+H / `openFindReplace`). */
    alwaysOpen?: boolean;
    /** Show the "More options" toggle. Default `true`. */
    showMoreOptions?: boolean;
    /** Called after the bar closes (Escape or the close button). */
    onclose?: () => void;
  }

  let {
    editor = null,
    class: className = "flex flex-col gap-1 rounded-md border border-border bg-background p-1 text-sm shadow-sm",
    alwaysOpen = false,
    showMoreOptions = true,
    onclose,
  }: Props = $props();

  const inputClass =
    "min-w-0 flex-1 rounded border border-input bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring";
  const buttonClass =
    "rounded px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent";
  const toggleClass = (on: boolean) =>
    `${buttonClass} font-mono ${on ? "bg-primary/10 text-primary" : "text-muted-foreground"}`;
  const basicToggles = FIND_OPTION_TOGGLES.filter((t) => !t.advanced);
  const advancedToggles = FIND_OPTION_TOGGLES.filter((t) => t.advanced);

  let find = $state.raw<SvelteFindReplace>(createFindReplace(null));
  let moreOpen = $state(false);
  let findInput = $state<HTMLInputElement | null>(null);

  $effect(() => {
    const f = createFindReplace(editor);
    find = f;
    return () => f.destroy();
  });

  let visible = $derived(find.available && (alwaysOpen || find.open));
  let showReplace = $derived(find.mode === "replace");
  let status = $derived(
    formatFindStatus({
      query: find.query,
      matches: find.matches,
      currentIndex: find.currentIndex,
      error: find.error,
      truncated: find.truncated,
    }),
  );
  let hasMatches = $derived(find.matchCount > 0);

  // Mod+F / Mod+H (in the editor or the bar) focus and select the find field.
  $effect(() => {
    if (!visible || find.focusRequest === 0 || !findInput) return;
    findInput.focus();
    findInput.select();
  });

  const isMod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey;

  function close() {
    find.close();
    editor?.commands.focus();
    onclose?.();
  }

  function onBarKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (isMod(e) && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      find.show("find");
    } else if (isMod(e) && (e.key === "h" || e.key === "H")) {
      e.preventDefault();
      find.show("replace");
    }
  }

  function onFindKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (e.shiftKey) find.previous();
    else find.next();
  }

  function onReplaceKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (isMod(e)) find.replaceAll();
    else find.replace();
  }
</script>

{#if visible}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class={className} role="search" aria-label="Find and replace" onkeydown={onBarKeyDown}>
    <div class="flex items-center gap-1">
      <button
        type="button"
        class={buttonClass}
        aria-label="Toggle replace"
        aria-expanded={showReplace}
        onclick={() => find.show(showReplace ? "find" : "replace")}
      >
        {showReplace ? "▾" : "▸"}
      </button>
      <input
        bind:this={findInput}
        type="text"
        class={inputClass}
        placeholder="Find"
        aria-label="Find"
        aria-invalid={!!find.error}
        value={find.query}
        oninput={(e) => find.setQuery(e.currentTarget.value)}
        onkeydown={onFindKeyDown}
      />
      {#each basicToggles as t (t.key)}
        <button
          type="button"
          class={toggleClass(!!find.options[t.key])}
          aria-label={t.label}
          title={t.label}
          aria-pressed={!!find.options[t.key]}
          onclick={() => find.toggleOption(t.key)}
        >
          {t.short}
        </button>
      {/each}
      <span
        class={`min-w-[5rem] px-1 text-center text-xs ${find.error ? "text-destructive" : "text-muted-foreground"}`}
        aria-live="polite"
        role={find.error ? "alert" : "status"}
        data-testid="find-status"
      >
        {status}
      </span>
      <button type="button" class={buttonClass} aria-label="Previous match" disabled={!hasMatches} onclick={() => find.previous()}>
        &uarr;
      </button>
      <button type="button" class={buttonClass} aria-label="Next match" disabled={!hasMatches} onclick={() => find.next()}>
        &darr;
      </button>
      {#if showMoreOptions}
        <button
          type="button"
          class={buttonClass}
          aria-label="More options"
          aria-expanded={moreOpen}
          onclick={() => (moreOpen = !moreOpen)}
        >
          &hellip;
        </button>
      {/if}
      <button type="button" class={buttonClass} aria-label="Close find" onclick={close}>&times;</button>
    </div>
    {#if showReplace}
      <div class="flex items-center gap-1 pl-7">
        <input
          type="text"
          class={inputClass}
          placeholder="Replace"
          aria-label="Replace"
          value={find.replacement}
          oninput={(e) => find.setReplacement(e.currentTarget.value)}
          onkeydown={onReplaceKeyDown}
        />
        <button
          type="button"
          class={buttonClass}
          disabled={!hasMatches || find.currentIndex < 0}
          onclick={() => find.replace()}
        >
          Replace
        </button>
        <button type="button" class={buttonClass} disabled={!hasMatches} onclick={() => find.replaceAll()}>
          Replace all
        </button>
        {#if find.lastReplaceCount !== null}
          <span class="px-1 text-xs text-muted-foreground" aria-live="polite">
            {find.lastReplaceCount === 1 ? "1 replaced" : `${find.lastReplaceCount} replaced`}
          </span>
        {/if}
      </div>
    {/if}
    {#if showMoreOptions && moreOpen}
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 pl-7 text-xs text-muted-foreground">
        {#each advancedToggles as t (t.key)}
          <label class="flex items-center gap-1">
            <input type="checkbox" checked={!!find.options[t.key]} onchange={() => find.toggleOption(t.key)} />
            {t.label}
          </label>
        {/each}
      </div>
    {/if}
  </div>
{/if}
