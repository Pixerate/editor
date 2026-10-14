<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import type { DocxExportControllerOptions, DocxExportReport } from "@pixerate/editor/export";
  import { createDocxExport } from "./docxExport.svelte.js";

  interface Props extends DocxExportControllerOptions {
    editor?: Editor | null;
    class?: string;
    children?: import("svelte").Snippet;
    /** Called after the download with the export report. */
    onExported?: (report: DocxExportReport) => void;
  }

  let {
    editor = null,
    class: className = "rounded px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50",
    children,
    onExported,
    ...options
  }: Props = $props();

  // Options are applied (and kept current) by the effect below.
  const docx = createDocxExport(() => editor);
  $effect(() => {
    docx.setOptions({ ...options });
  });

  async function exportNow() {
    const report = await docx.download();
    if (report) onExported?.(report);
  }
</script>

<!-- A button that downloads the editor's document as a Word file (`.docx`). -->
<button
  type="button"
  class={className}
  disabled={!editor || docx.isExporting}
  aria-busy={docx.isExporting || undefined}
  title={docx.error ? `Export failed: ${docx.error.message}` : undefined}
  onclick={exportNow}
>
  {#if children}
    {@render children()}
  {:else}
    Export to Word
  {/if}
</button>
