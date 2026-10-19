<script lang="ts">
  import { documentToScreen, type PaintPresence, type PaintPresenceState, type PaintView } from '@pixerate/editor/paint-editor';

  interface Props {
    /** Agent cursors to draw (see `PaintDirector`). */
    presence: PaintPresence;
    view: PaintView;
    canvas: { width: number; height: number };
    viewport: { width: number; height: number };
  }

  let { presence, view, canvas, viewport }: Props = $props();

  let current: PaintPresenceState = $state.raw({ actors: [] });
  $effect(() => {
    current = presence.getState();
    return presence.subscribe((next) => {
      current = next;
    });
  });
</script>

<!-- Agent cursors in document pixels, placed through the view; the cursors stay upright and unscaled. -->
<div class="pointer-events-none absolute inset-0 overflow-hidden" data-paint-presence="" aria-hidden="true">
  {#each current.actors as a (a.id)}
    {@const p = documentToScreen(view, canvas, viewport, a.x, a.y)}
    <div class="absolute" style={`left: ${p.x}px; top: ${p.y}px`} data-actor={a.id}>
      <svg width="18" height="20" viewBox="0 0 18 20" class="drop-shadow-md" style={`transform-origin: 0 0; ${a.pressed ? 'transform: scale(0.85)' : ''}`}>
        <path d="M0 0 L0 15 L4.5 10.8 L7.6 17 L10.2 15.8 L7.2 9.7 L13.5 9.4 Z" fill={a.color} stroke="white" stroke-width="1.4" stroke-linejoin="round" />
      </svg>
      <span class="absolute left-4 top-4 w-max max-w-[240px] rounded-md px-2 py-0.5 text-[11px] font-semibold text-white shadow" style={`background: ${a.color}`}>{a.message ?? a.name}</span>
    </div>
  {/each}
</div>
