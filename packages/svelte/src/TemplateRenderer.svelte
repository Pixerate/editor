<script lang="ts">
  import {
    tokenizePrompt,
    resolveTemplates,
    type Template,
    type ColorGradient,
  } from "@pixerate/editor";

  interface Props {
    content: string;
    templates?: Template[];
    templateColorMap?: Map<string, ColorGradient>;
    resolve?: boolean;
    class?: string;
    onTemplateClick?: (templateName: string) => void;
    onVariableClick?: (variableName: string) => void;
  }

  let {
    content,
    templates = [],
    templateColorMap,
    resolve = false,
    class: className = "font-mono text-sm leading-relaxed whitespace-pre-wrap break-words",
    onTemplateClick,
    onVariableClick,
  }: Props = $props();

  let displayText = $derived(
    resolve && templates.length > 0
      ? resolveTemplates(content, templates)
      : content
  );

  let tokens = $derived(tokenizePrompt(displayText));
</script>

<div class={className}>
  {#each tokens as token}
    {#if token.type === "template"}
      {@const colors = templateColorMap?.get(token.value) || { from: "#f43f5e", to: "#8b5cf6" }}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <span
        style={`--color-from: ${colors.from}; --color-to: ${colors.to};`}
        onclick={() => onTemplateClick?.(token.value)}
        class="inline-flex items-center px-1.5 py-0.5 mx-0.5 text-xs font-semibold rounded-md border border-[var(--color-to)]/40 bg-gradient-to-r from-[var(--color-from)]/15 to-[var(--color-to)]/15 text-[var(--color-to)] hover:brightness-110 cursor-pointer transition-all"
        title={`Template: ${token.value}`}
      >
        {`{{${token.value}}}`}
      </span>
    {:else if token.type === "variable"}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <span
        onclick={() => onVariableClick?.(token.value)}
        class="inline-flex items-center px-1.5 py-0.5 mx-0.5 text-xs font-medium rounded-md border border-violet-400/40 bg-violet-400/15 text-violet-600 hover:brightness-110 cursor-pointer transition-all"
        title={`Variable: ${token.value}`}
      >
        {`{${token.value}}`}
      </span>
    {:else if token.type === "instruction"}
      <span
        class="inline-flex items-center px-1.5 py-0.5 mx-0.5 text-xs italic font-medium rounded-md border border-rose-400/40 bg-rose-400/15 text-rose-600"
        title={`Instruction: ${token.value}`}
      >
        {`__${token.value}__`}
      </span>
    {:else}
      <span>{token.value}</span>
    {/if}
  {/each}
</div>
