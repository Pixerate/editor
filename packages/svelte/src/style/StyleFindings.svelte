<script lang="ts">
  import type { StyleCheckReport, StyleFinding } from "@pixerate/editor/tools";

  interface Props {
    /** A check report (`useStyleFindings(...).report`, or a `check_*_style` tool result). Renders nothing while `null`. */
    report: StyleCheckReport | null | undefined;
    /** Called when a finding with a `target` is clicked, e.g. to select that series in the chart. */
    onSelect?: (finding: StyleFinding) => void;
    /** Heading (default "House style"). */
    title?: string;
    class?: string;
  }

  let { report, onSelect, title = "House style", class: className = "" }: Props = $props();

  const SEVERITY_CLASS: Record<StyleFinding["severity"], string> = {
    error: "text-destructive",
    warning: "text-amber-600",
    info: "text-muted-foreground",
  };
</script>

{#snippet body(finding: StyleFinding)}
  <span data-style-severity={finding.severity} class="shrink-0 font-semibold uppercase text-[10px] {SEVERITY_CLASS[finding.severity]}">
    {finding.severity}
  </span>
  <span class="flex min-w-0 flex-col">
    <span data-style-message="">{finding.message}</span>
    <span class="text-[10px] text-muted-foreground"><code>{finding.check}</code>{#if finding.layer} · {finding.layer}{/if}</span>
  </span>
{/snippet}

{#if report}
  <section data-style-findings="" aria-label={title} class="flex flex-col gap-1.5 text-xs text-foreground {className}">
    <h3 class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
    {#if report.findings.length > 0}
      <ul class="flex flex-col gap-1">
        {#each report.findings as finding, i (`${finding.check}-${i}`)}
          <li data-style-finding={finding.check}>
            {#if finding.target !== undefined && onSelect}
              <button
                type="button"
                class="flex w-full items-start gap-2 rounded border border-border px-2 py-1 text-left hover:bg-muted"
                onclick={() => onSelect?.(finding)}
              >
                {@render body(finding)}
              </button>
            {:else}
              <div class="flex items-start gap-2 rounded border border-border px-2 py-1">{@render body(finding)}</div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if report.findings.length === 0 && report.ran.length > 0}
      <p data-style-clear="" class="text-emerald-600">
        All clear: {report.ran.length} {report.ran.length === 1 ? "check" : "checks"} passed.
      </p>
    {/if}
    {#if report.findings.length === 0 && report.ran.length === 0 && report.skipped.length === 0}
      <p class="text-muted-foreground">No house-style checks apply.</p>
    {/if}
    {#if report.skipped.length > 0}
      <ul data-style-skipped="" aria-label="Skipped checks" class="flex flex-col gap-0.5 text-muted-foreground">
        {#each report.skipped as s (s.check)}
          <li data-style-skipped-check={s.check}>Skipped <code>{s.check}</code>: {s.reason}</li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}
