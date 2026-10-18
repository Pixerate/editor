<script lang="ts">
  import { motionIssueLine, type AnimationEditorController, type MotionFrameOptions } from '@pixerate/editor/animation-editor';
  import AnimationStage from './AnimationStage.svelte';
  import ShotTimeline from './ShotTimeline.svelte';
  import { animationEditorStateOf } from './createAnimationEditor.svelte.js';

  interface Props {
    controller: AnimationEditorController;
    values?: MotionFrameOptions['values'];
    /** List the scene's issues under the timeline (default true). */
    showIssues?: boolean;
    class?: string;
  }

  let { controller, values, showIssues = true, class: className = '' }: Props = $props();
  const view = animationEditorStateOf(() => controller);
</script>

<!-- Stage, shot timeline and issue list for an AnimationEditorController. -->
<div class="flex flex-col gap-2 {className}" data-animation-editor="">
  <AnimationStage {controller} {values} class="rounded-md border border-border bg-muted/40" />
  <ShotTimeline {controller} />
  {#if showIssues && view.current.issues.length > 0}
    <ul class="space-y-0.5 text-xs" aria-label="Animation issues">
      {#each view.current.issues as issue, i (i)}
        <li class={issue.severity === 'error' ? 'text-red-500' : issue.severity === 'warning' ? 'text-amber-500' : 'text-muted-foreground'}>{motionIssueLine(issue)}</li>
      {/each}
    </ul>
  {/if}
</div>
