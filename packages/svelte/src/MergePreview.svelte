<!--
  Mail-merge preview: paste or pick a CSV / JSON data source, check the
  automatic field mapping, step through records with the resolved prompt shown
  by TemplateRenderer, and merge every record into text or JSON.
  Inputs are nested in their labels, which associates them without ids.
-->
<script lang="ts">
  import type {
    ColorGradient,
    MergeRecordsOptions,
    MergeRecordsResult,
    ParseDataSourceOptions,
    Template,
  } from "@pixerate/editor";
  import TemplateRenderer from "./TemplateRenderer.svelte";
  import { createMergePreview } from "./merge.svelte.js";

  interface Props {
    /** The prompt merged with each record. */
    content: string;
    templates?: Template[];
    bindings?: Record<string, string>;
    templateColorMap?: Map<string, ColorGradient>;
    /** Initial CSV / TSV / JSON data source text. */
    defaultSource?: string;
    parseOptions?: ParseDataSourceOptions;
    /** Drop records matching this condition (e.g. `"status=void"`) when merging. */
    skipIf?: MergeRecordsOptions["skipIf"];
    /** Separator between merged outputs (default a blank line; `"none"` for nothing). */
    separator?: string;
    maxOutputs?: number;
    /** Called after "Merge all". */
    onMerge?: (result: MergeRecordsResult) => void;
    /** Base file name for downloads (default `merged`). */
    downloadName?: string;
    class?: string;
  }

  let {
    content,
    templates,
    bindings,
    templateColorMap,
    defaultSource = "",
    parseOptions,
    skipIf,
    separator,
    maxOutputs,
    onMerge,
    downloadName = "merged",
    class: className = "flex flex-col gap-3 text-sm",
  }: Props = $props();

  // svelte-ignore state_referenced_locally
  const merge = createMergePreview(
    () => ({ template: content, templates, bindings, parseOptions, skipIf, separator, maxOutputs }),
    defaultSource,
  );
  let copied = $state(false);

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function downloadText(text: string, fileName: string, type: string) {
    if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(merge.serialize("text"));
      copied = true;
    } catch {
      copied = false;
    }
  }

  function mergeAll() {
    const result = merge.merge();
    copied = false;
    onMerge?.(result);
  }
</script>

<div class={className} data-merge-preview="">
  <label class="flex flex-col gap-1">
    <span class="font-medium">Data source (CSV, TSV or JSON)</span>
    <textarea
      data-merge-source=""
      value={merge.sourceText}
      rows={5}
      spellcheck={false}
      oninput={(event) => merge.setSourceText(event.currentTarget.value)}
      class="px-2 py-1 font-mono text-xs rounded-md border border-violet-400/40 bg-transparent"
    ></textarea>
  </label>
  <div class="flex flex-wrap items-center gap-2">
    <input
      type="file"
      accept=".csv,.tsv,.txt,.json,text/csv,application/json"
      aria-label="Load data source file"
      data-merge-file=""
      onchange={(event) => {
        const file = event.currentTarget.files?.[0];
        if (file) void merge.loadFile(file);
      }}
    />
    <span data-merge-summary="" class="opacity-70"
      >{`${plural(merge.source.records.length, "record")} · ${plural(merge.source.fields.length, "field")}`}</span
    >
  </div>
  {#if merge.source.warnings.length > 0 && merge.sourceText.trim() !== ""}
    <ul data-merge-warnings="" class="text-amber-600 text-xs">
      {#each merge.source.warnings as warning}
        <li>{warning.message}</li>
      {/each}
    </ul>
  {/if}

  {#if merge.variables.length > 0}
    <fieldset class="flex flex-col gap-1">
      <legend class="font-medium">Field mapping</legend>
      {#each merge.variables as variable (variable)}
        <label class="flex items-center gap-2" data-merge-mapping={variable}>
          <span class="min-w-24 font-mono">{`{${variable}}`}</span>
          <select
            value={merge.mapping[variable] ?? ""}
            aria-label={`Field for ${variable}`}
            onchange={(event) => merge.setFieldMapping(variable, event.currentTarget.value || null)}
            class="px-1 py-0.5 rounded-md border border-violet-400/40 bg-transparent"
          >
            <option value="">(none)</option>
            {#each merge.source.fields as field (field)}
              <option value={field}>{field}</option>
            {/each}
          </select>
        </label>
      {/each}
    </fieldset>
  {/if}

  <div class="flex items-center gap-2">
    <button type="button" data-merge-prev="" onclick={merge.prev} disabled={merge.index <= 0}>Prev</button>
    <span data-merge-position=""
      >{merge.count === 0 ? "No records" : `Record ${merge.index + 1} of ${merge.count}`}</span
    >
    <button
      type="button"
      data-merge-next=""
      onclick={merge.next}
      disabled={merge.index >= merge.count - 1}>Next</button
    >
  </div>

  <div data-merge-output="">
    <TemplateRenderer
      {content}
      templates={templates ?? []}
      {bindings}
      {templateColorMap}
      resolve={!!templates && templates.length > 0}
      values={merge.values}
    />
  </div>

  <div class="flex flex-wrap items-center gap-2">
    <button type="button" data-merge-all="" disabled={merge.count === 0} onclick={mergeAll}>Merge all</button>
    {#if merge.result}
      <span data-merge-result=""
        >{`${merge.result.outputs.length} merged${merge.result.skipped.length ? `, ${merge.result.skipped.length} skipped` : ""}${merge.result.truncated ? " (stopped early)" : ""}`}</span
      >
      <button type="button" data-merge-copy="" onclick={copy}>{copied ? "Copied" : "Copy"}</button>
      <button
        type="button"
        data-merge-download="text"
        onclick={() => downloadText(merge.serialize("text"), `${downloadName}.txt`, "text/plain")}
        >Download .txt</button
      >
      <button
        type="button"
        data-merge-download="json"
        onclick={() => downloadText(merge.serialize("json"), `${downloadName}.json`, "application/json")}
        >Download .json</button
      >
    {/if}
  </div>
  {#if merge.result}
    <textarea
      readonly
      aria-label="Merged output"
      data-merge-text=""
      rows={6}
      value={merge.serialize("text")}
      class="px-2 py-1 font-mono text-xs rounded-md border border-violet-400/40 bg-transparent"
    ></textarea>
  {/if}
</div>
