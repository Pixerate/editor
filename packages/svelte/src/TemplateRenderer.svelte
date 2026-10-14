<script lang="ts">
  import {
    evaluatePromptTokens,
    resolveTemplates,
    type Template,
    type ColorGradient,
    type PromptValues,
  } from "@pixerate/editor";

  interface Props {
    content: string;
    templates?: Template[];
    templateColorMap?: Map<string, ColorGradient>;
    resolve?: boolean;
    /** Template version bindings used when `resolve` is set. */
    bindings?: Record<string, string>;
    /**
     * Variable values. When set, variables show their value (or default),
     * sections whose condition fails are hidden, and section tags are dropped.
     */
    values?: PromptValues;
    class?: string;
    onTemplateClick?: (templateName: string) => void;
    onVariableClick?: (variableName: string) => void;
  }

  let {
    content,
    templates = [],
    templateColorMap,
    resolve = false,
    bindings,
    values,
    class: className = "font-mono text-sm leading-relaxed whitespace-pre-wrap break-words",
    onTemplateClick,
    onVariableClick,
  }: Props = $props();

  const CONDITIONAL_PREFIX = { if: "?", unless: "!", end: "/" } as const;

  let displayText = $derived(
    resolve && templates.length > 0
      ? resolveTemplates(content, templates, { bindings })
      : content
  );

  let tokens = $derived(evaluatePromptTokens(displayText, values));

  function variableDetails(token: (typeof tokens)[number]): string {
    return [
      `Variable: ${token.value}`,
      token.description,
      token.defaultValue !== undefined
        ? `Default: ${token.defaultValue || "(empty)"}`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  }

  function conditionalTitle(token: (typeof tokens)[number]): string {
    if (token.conditional === "end") return `End of section: ${token.value}`;
    return token.conditional === "if"
      ? `Shown when "${token.value}" has a value`
      : `Shown when "${token.value}" is empty`;
  }
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
    {:else if token.type === "variable" && token.resolvedValue !== undefined}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <span
        onclick={() => onVariableClick?.(token.value)}
        data-variable={token.value}
        data-value-source={token.valueSource}
        class={token.valueSource === "value"
          ? "inline px-1 mx-0.5 rounded-md bg-emerald-400/15 text-emerald-700 border-b border-emerald-400/60 cursor-pointer"
          : "inline px-1 mx-0.5 rounded-md bg-violet-400/10 text-violet-600 italic border-b border-dashed border-violet-400/60 cursor-pointer"}
        title={variableDetails(token)}
      >{token.resolvedValue}</span>
    {:else if token.type === "variable"}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <span
        onclick={() => onVariableClick?.(token.value)}
        data-variable={token.value}
        class="inline-flex items-center px-1.5 py-0.5 mx-0.5 text-xs font-medium rounded-md border border-violet-400/40 bg-violet-400/15 text-violet-600 hover:brightness-110 cursor-pointer transition-all"
        title={variableDetails(token)}
      >{`{${token.value}`}{#if token.defaultValue !== undefined}<span class="opacity-60">{`|${token.defaultValue}`}</span>{/if}{"}"}</span>
    {:else if token.type === "conditional" && token.conditional}
      <span
        data-conditional={token.conditional}
        class="inline-flex items-center px-1 py-0.5 mx-0.5 text-xs font-medium rounded-md border border-amber-400/40 bg-amber-400/15 text-amber-700"
        title={conditionalTitle(token)}
      >{`{${CONDITIONAL_PREFIX[token.conditional]}${token.value}}`}</span>
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
