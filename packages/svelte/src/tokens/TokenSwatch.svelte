<script lang="ts">
  interface Props {
    color: string;
    class?: string;
  }
  let { color, class: className = '' }: Props = $props();
</script>

<span
  data-token-swatch={color}
  class="inline-block h-4 w-4 shrink-0 rounded border border-border {className}"
  style="background: linear-gradient({color}, {color}), repeating-conic-gradient(#ccc 0 25%, #fff 0 50%) 0 0 / 8px 8px"
  aria-hidden="true"
></span>
