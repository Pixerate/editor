<script lang="ts">
  import { layoutSparkline, type ChartSparklineKind, type ChartValue } from '@pixerate/editor/chart';
  import ChartSceneSvg from './ChartSceneSvg.svelte';

  interface Props {
    values: readonly ChartValue[];
    kind?: ChartSparklineKind;
    width?: number;
    height?: number;
    color?: string;
    negativeColor?: string;
    markers?: boolean;
    highLow?: boolean;
    min?: number;
    max?: number;
    /** Accessible label (default: first and last value). */
    label?: string;
    class?: string;
  }

  let { values, kind = 'line', width = 80, height = 20, color, negativeColor, markers, highLow, min, max, label, class: className = '' }: Props = $props();

  const scene = $derived(layoutSparkline(values, { kind, width, height, color, negativeColor, markers, highLow, min, max }));
  const present = $derived(values.filter((v): v is number => v !== null));
</script>

<ChartSceneSvg {scene} label={label ?? (present.length ? `Trend from ${present[0]} to ${present[present.length - 1]}` : 'No data')} class="inline-block align-middle {className}" />
