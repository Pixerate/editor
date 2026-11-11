<script lang="ts">
  import { brushSpecialtyGuides, runBrushSpecialtyAction, type PaintEditorController } from '@pixerate/editor/paint-editor';
  import { attempt, button, paintEditorState } from './paintEditorRune.svelte.js';

  interface Props {
    controller: PaintEditorController;
    /** With it, an "Open Specialty panel" button (the paint editor switches to its Specialty tab). */
    onopenspecialtypanel?: () => void;
    class?: string;
  }
  let { controller, onopenspecialtypanel, class: className = '' }: Props = $props();
  const editor = paintEditorState(() => controller);
  const guides = $derived(brushSpecialtyGuides(editor.current));
  let error = $state<string | null>(null);
  const run = (fn: () => unknown) => attempt(fn, (m) => (error = m));
</script>

<!-- How to use the active brush's specialty paint: its how-to, the canvas's live status and one-click setup actions. Nothing for a standard brush. -->
{#if guides.length}
  <div class={`flex flex-col gap-2 rounded-lg border border-indigo-500/40 bg-indigo-950/30 p-2 ${className}`} data-testid="brush-specialty-guide">
    {#each guides as g (g.kind)}
      <div class="flex flex-col gap-1" data-specialty={g.kind}>
        <div class="flex items-center gap-1.5">
          <span class="rounded bg-indigo-600 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white">Specialty</span>
          <span class="font-medium text-slate-200">{g.title}</span>
        </div>
        <p class="text-[11px] leading-snug text-slate-400">{g.howToUse}</p>
        <p role="status" data-ready={g.ready} class={`text-[11px] ${g.ready ? 'text-emerald-400' : 'text-amber-400'}`}>{g.ready ? '● ' : '○ '}{g.status}</p>
        {#if g.actions.length}
          <div class="flex flex-wrap gap-1">
            {#each g.actions as a (a.id)}
              <button type="button" class={button} data-action={a.id} title={a.tool} onclick={() => run(() => runBrushSpecialtyAction(controller, a))}>{a.label}</button>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
    {#if onopenspecialtypanel}
      <button type="button" class={`${button} self-start`} onclick={onopenspecialtypanel}>Open Specialty panel</button>
    {/if}
    {#if error}<p role="alert" class="text-[11px] text-rose-400">{error}</p>{/if}
  </div>
{/if}
