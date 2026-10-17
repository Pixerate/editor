<script lang="ts">
  import type { ChartScene } from '@pixerate/editor/chart';
  import ChartMarks from './ChartMarks.svelte';

  interface Props {
    /** A laid-out scene (`layoutChart`, `layoutSparkline`, `blendChartScenes`). */
    scene: ChartScene;
    label?: string;
    class?: string;
  }

  let { scene, label, class: className = '' }: Props = $props();
</script>

<svg width={scene.width} height={scene.height} viewBox="0 0 {scene.width} {scene.height}" role="img" aria-label={label} class="block max-w-full {className}">
  <ChartMarks marks={scene.marks} fontFamily={scene.theme.fontFamily} />
</svg>
