<!--
  Inputs are nested in their labels, which associates them without ids
  (`$props.id()` needs Svelte 5.20, newer than our peer range).
-->
<script lang="ts">
  import {
    compactVariableValues,
    getVariableFormFields,
    type PromptValues,
    type Template,
  } from "@pixerate/editor";

  interface Props {
    /** Prompt whose variables become form fields. */
    content: string;
    /** Templates searched recursively for further variables. */
    templates?: Template[];
    /** Template version bindings. */
    bindings?: Record<string, string>;
    /** Entered text per variable. Bindable. */
    values?: Record<string, string>;
    /**
     * Called on every edit with the values to resolve with (blank fields
     * dropped so defaults apply) and the raw entered text.
     */
    onChange?: (values: PromptValues, entered: Record<string, string>) => void;
    class?: string;
  }

  let {
    content,
    templates,
    bindings,
    values = $bindable({}),
    onChange,
    class: className = "flex flex-col gap-3 text-sm",
  }: Props = $props();

  let fields = $derived(getVariableFormFields(content, { templates, bindings }));

  function update(name: string, value: string) {
    const next = { ...values, [name]: value };
    values = next;
    onChange?.(compactVariableValues(next), next);
  }
</script>

{#if fields.length > 0}
  <form class={className} onsubmit={(event) => event.preventDefault()}>
    {#each fields as field (field.name)}
      {#if field.conditionOnly}
        <label
          class="flex items-center gap-2"
          data-variable-field={field.name}
        >
          <input
            name={field.name}
            type="checkbox"
            checked={(values[field.name] ?? "") !== ""}
            onchange={(event) =>
              update(field.name, event.currentTarget.checked ? "true" : "")}
          />
          <span>{field.label}</span>
        </label>
      {:else}
        <label
          class="flex flex-col gap-1"
          data-variable-field={field.name}
        >
          <span class="font-medium"
            >{field.label}{#if field.required}<span class="text-rose-500" aria-hidden="true">{" *"}</span>{/if}</span
          >
          <input
            name={field.name}
            type="text"
            value={values[field.name] ?? ""}
            placeholder={field.placeholder}
            aria-required={field.required || undefined}
            oninput={(event) => update(field.name, event.currentTarget.value)}
            class="px-2 py-1 rounded-md border border-violet-400/40 bg-transparent"
          />
        </label>
      {/if}
    {/each}
  </form>
{/if}
