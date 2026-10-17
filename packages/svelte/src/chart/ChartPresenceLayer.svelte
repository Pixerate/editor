<script lang="ts">
  import type { ChartPresence, ChartPresenceState } from '@pixerate/editor/chart';

  interface Props {
    /** Agent cursors to draw (see `ChartDirector`). */
    presence: ChartPresence;
  }

  let { presence }: Props = $props();

  let current: ChartPresenceState = $state.raw({ actors: [] });
  $effect(() => {
    current = presence.getState();
    return presence.subscribe((next) => {
      current = next;
    });
  });
</script>

<g data-chart-presence="" pointer-events="none">
  {#each current.actors as a (a.id)}
    <g transform="translate({a.x} {a.y})" data-actor={a.id}>
      <path d="M0,0 L0,14 L4,10.5 L7,17 L9.5,16 L6.5,9.5 L11.5,9.5 Z" style:fill={a.color} style:stroke="#ffffff" style:stroke-width="1" transform={a.pressed ? 'scale(0.9)' : undefined} />
      <g transform="translate(13 16)">
        <rect x="0" y="0" rx="4" height="18" width={Math.max(28, (a.message ?? a.name).length * 6.4 + 12)} style:fill={a.color} />
        <text x="6" y="9" dominant-baseline="central" style:fill="#ffffff" style:font-size="11px" style:font-weight="600" style:font-family="inherit">{a.message ?? a.name}</text>
      </g>
    </g>
  {/each}
</g>
