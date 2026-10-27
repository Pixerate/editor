<script lang="ts">
  import { describeVideoEditPlan, formatVideoSeconds, type VideoEditorController } from '@pixerate/editor/video-editor';
  import { videoEditorStateOf } from './createVideoEditor.svelte.js';

  interface Props {
    controller: VideoEditorController;
    /** Allow accepting plans (default true; discarding is always allowed). */
    editable?: boolean;
    class?: string;
  }

  let { controller, editable = true, class: className = '' }: Props = $props();
  const view = videoEditorStateOf(() => controller);
  const editor = $derived(view.current);
  const total = $derived(Math.max(1, editor.duration));
  let message = $state<string | null>(null);
  const btn = 'rounded border border-border px-2 py-0.5 text-[11px] disabled:opacity-40';

  function accept(id: string) {
    const r = controller.applyPlan(id);
    message = r.ok ? null : r.error;
  }
  function discard(id: string) {
    controller.discardPlan(id);
    message = null;
  }
</script>

<!--
  Proposed edit plans waiting for review: title, what each would do (length change, clips added,
  changed and removed, new problems), a strip of the stretches it cuts (click to go there) and
  Accept / Discard. Accepting applies the plan as one undo step. Renders nothing without plans.
-->
{#if editor.plans.length}
  <section class="flex flex-col gap-2 rounded-md border border-amber-500/50 bg-amber-500/5 p-2 text-xs {className}" aria-label="Proposed edits" data-edit-plans="">
    {#each editor.plans as plan (plan.id)}
      {@const s = plan.summary}
      {@const stale = editor.revision >= 0 && controller.isPlanStale(plan.id)}
      <article class="flex flex-col gap-1" data-edit-plan={plan.id}>
        <div class="flex items-center gap-2">
          <h3 class="flex-1 font-semibold">{plan.title}</h3>
          <span class="tabular-nums {s.durationDelta < 0 ? 'text-emerald-600' : 'text-muted-foreground'}" data-plan-delta="">
            {s.durationDelta < 0 ? '−' : s.durationDelta > 0 ? '+' : '±'}{formatVideoSeconds(Math.abs(s.durationDelta))}
          </span>
        </div>
        {#if plan.description}<p class="text-muted-foreground">{plan.description}</p>{/if}
        <p class="text-muted-foreground" data-plan-summary="">{describeVideoEditPlan(plan)} · {formatVideoSeconds(s.durationBefore)} → {formatVideoSeconds(s.durationAfter)}</p>
        {#if plan.ranges?.length}
          <div class="relative h-3 w-full overflow-hidden rounded bg-muted" aria-label="Stretches the plan cuts" data-plan-strip="">
            {#each plan.ranges as r, i (i)}
              <button
                type="button"
                class="absolute top-0 h-full bg-rose-500/70 hover:bg-rose-600"
                style="left: {(r.from / total) * 100}%; width: {Math.max(0.4, ((r.to - r.from) / total) * 100)}%"
                title={`${r.reason ? `${r.reason}: ` : ''}${r.text ?? ''} (${formatVideoSeconds(r.from)})`}
                aria-label={`Go to ${r.reason ?? 'cut'} at ${formatVideoSeconds(r.from)}`}
                onclick={() => controller.seek(r.from)}
              ></button>
            {/each}
          </div>
        {/if}
        {#if s.newIssues.length}<p class="text-amber-600">It would add {s.newIssues.length} problem{s.newIssues.length > 1 ? 's' : ''}: {s.newIssues[0].message}</p>{/if}
        {#if stale}<p class="text-amber-600" data-plan-stale="">The project changed since this plan was made; it is checked again when accepted.</p>{/if}
        <div class="flex gap-1">
          <button type="button" class={btn} disabled={!editable || editor.readOnly} onclick={() => accept(plan.id)} data-accept-plan="">Accept plan</button>
          <button type="button" class={btn} onclick={() => discard(plan.id)} data-discard-plan="">Discard</button>
        </div>
      </article>
    {/each}
    {#if message}<p class="text-red-500" role="alert" data-plan-error="">{message}</p>{/if}
  </section>
{/if}
