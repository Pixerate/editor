<script lang="ts">
  import type { EffectProvider } from '@pixerate/editor/effects';
  import type { VideoClip, VideoEditorController, VideoEffectEditResult } from '@pixerate/editor/video-editor';
  import { videoEditorStateOf } from './createVideoEditor.svelte.js';

  interface Props {
    controller: VideoEditorController;
    clip: VideoClip;
    instance: string;
    provider: EffectProvider;
    disabled: boolean;
    report: (r: VideoEffectEditResult | Promise<VideoEffectEditResult>) => void;
  }

  let { controller, clip, instance, provider, disabled, report }: Props = $props();
  const view = videoEditorStateOf(() => controller);
  const drawing = $derived(view.current.pathDrawing?.clip === clip.id && view.current.pathDrawing.instance === instance);
  let words = $state('');
  const btn = 'rounded border border-border px-1.5 py-0.5 text-[11px] disabled:opacity-40';
</script>

<!-- Where an effect's path comes from, for an effect that draws along one: drawn on the preview, a mask outline, words, or none. -->
<div class="flex flex-wrap items-center gap-1" data-effect-part="path">
  <span class="text-muted-foreground">Path</span>
  <button type="button" class={btn} {disabled} aria-pressed={drawing} title="Draw the path on the preview" onclick={() => (drawing ? controller.cancelPathDrawing() : controller.startPathDrawing({ clip: clip.id, instance }))}>{drawing ? 'Drawing… (Esc)' : 'Draw path'}</button>
  <button type="button" class={btn} disabled={disabled || !clip.mask} title={clip.mask ? "Run it along this clip's mask outline" : 'Give the clip a mask first'} onclick={() => report(controller.setEffectPath(clip.id, instance, { mask: { clip: clip.id } }))}>Use mask outline</button>
  {#if provider.pathFromText}
    <input class="w-24 rounded border border-border bg-transparent px-1 py-0.5" aria-label="Words to write along the path" placeholder="Words" bind:value={words} {disabled} />
    <button type="button" class={btn} disabled={disabled || !words.trim()} onclick={() => report(controller.setEffectPath(clip.id, instance, { text: words }))}>Write</button>
  {/if}
  <button type="button" class={btn} {disabled} onclick={() => report(controller.setEffectPath(clip.id, instance, { d: '' }))}>Clear path</button>
</div>
