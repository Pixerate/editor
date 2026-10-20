<script lang="ts">
  import { VECTOR_GENERATED_IMAGE_AS, generateVectorArt, vectorArtModels, type VectorArtGenerator, type VectorEditorController, type VectorGeneratedImageAs, type VectorArtModel } from '@pixerate/editor/vector';
  
  /**
   * Generative prompts: describe art, pick a model (and, for image models, how the picture becomes
   * vectors) and generate it into the artboard as one editable group. One undo step.
   */
  interface Props {
    controller: VectorEditorController;
    /** The host's models (image models are traced or stylised; text models write SVG). */
    models: readonly VectorArtModel[];
    /** The host's generator (sends a planned request to its model). */
    generate: VectorArtGenerator;
    class?: string;
  }

  let { controller, models, generate, class: className = '' }: Props = $props();

  const AS_LABELS: Record<VectorGeneratedImageAs, string> = { color: 'Traced in colour', threshold: 'Traced in one colour', mosaic: 'Mosaic', halftone: 'Halftone', lowPoly: 'Low poly', hatch: 'Engraving' };
  const usable = $derived(vectorArtModels(models));
  let prompt = $state('');
  let model = $state('');
  let as: VectorGeneratedImageAs = $state('color');
  let busy = $state(false);
  let message: string | null = $state(null);
  const chosen = $derived(usable.find((m) => m.id === model) ?? usable[0]);

  async function run() {
    if (!chosen) return;
    busy = true;
    message = null;
    const r = await generateVectorArt(controller, { prompt, model: chosen.id, as, idempotencyKey: `${Date.now()}-${Math.random().toString(36).slice(2)}` }, { models, generate });
    busy = false;
    message = r.ok ? null : (r.message ?? 'Generation failed.');
  }

  const buttonClass =
    'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40';
  const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
</script>

{#if chosen}
  <div class="space-y-1 {className}" data-vector-generate-panel="" aria-label="Generate">
    <div class="flex items-center gap-1">
      <span class="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Generate</span>
      <select aria-label="Generation model" class={selectClass} value={chosen.id} onchange={(e) => (model = e.currentTarget.value)}>
        {#each usable as m (m.id)}<option value={m.id}>{m.name ?? m.id}</option>{/each}
      </select>
      {#if chosen.media === 'image'}
        <select aria-label="Image to vectors" class={selectClass} value={as} onchange={(e) => (as = e.currentTarget.value as VectorGeneratedImageAs)}>
          {#each VECTOR_GENERATED_IMAGE_AS as a (a)}<option value={a}>{AS_LABELS[a]}</option>{/each}
        </select>
      {/if}
    </div>
    <div class="flex items-center gap-1">
      <span class="w-16"></span>
      <input type="text" aria-label="Prompt" placeholder="Describe the art…" class="h-7 min-w-0 flex-1 rounded border border-border bg-background px-1.5 text-xs" bind:value={prompt} onkeydown={(e) => e.key === 'Enter' && prompt.trim() && !busy && void run()} />
      <button type="button" class={buttonClass} data-vector-generate-action="" disabled={!prompt.trim() || busy} onclick={() => void run()}>{busy ? 'Generating…' : 'Generate'}</button>
    </div>
    {#if message}<p class="text-[11px] text-red-600">{message}</p>{/if}
  </div>
{/if}
