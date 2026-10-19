<script lang="ts">
  import type { PaintEditorController, ReferenceImage } from '@pixerate/editor/paint-editor';

  interface Props {
    controller: PaintEditorController;
    reference: ReferenceImage;
  }
  let { controller, reference }: Props = $props();
  let drag: { x: number; y: number; ox: number; oy: number } | null = null;
  const h = $derived((reference.height / reference.width) * reference.displayWidth);
</script>

<!-- A floating reference image: drag its title bar to move it, click the image to pick a colour. -->
<div
  class="absolute rounded border border-slate-700 bg-slate-900/95 shadow-xl"
  style={`left: ${reference.x}px; top: ${reference.y}px; width: ${reference.displayWidth}px`}
  data-testid="paint-reference"
  role="dialog"
  aria-label={reference.name}
  tabindex="-1"
  onpointerdown={(e) => e.stopPropagation()}
>
  <div
    class="flex items-center justify-between px-1.5 py-0.5 text-[10px] text-slate-300 cursor-move"
    role="toolbar"
    tabindex="-1"
    onpointerdown={(e) => {
      drag = { x: e.clientX, y: e.clientY, ox: reference.x, oy: reference.y };
      (e.target as Element).setPointerCapture?.(e.pointerId);
    }}
    onpointermove={(e) => {
      if (drag) controller.updateReferenceImage(reference.id, { x: drag.ox + e.clientX - drag.x, y: drag.oy + e.clientY - drag.y });
    }}
    onpointerup={() => (drag = null)}
  >
    <span class="truncate">{reference.name}</span>
    <button type="button" aria-label={`Hide ${reference.name}`} class="px-1 text-slate-400 hover:text-white" onclick={() => controller.updateReferenceImage(reference.id, { visible: false })}>×</button>
  </div>
  <button
    type="button"
    class="block cursor-copy p-0"
    aria-label={`Pick a colour from ${reference.name}`}
    onclick={(e) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const k = reference.width / (rect.width || reference.displayWidth);
      controller.setColor(controller.pickReferenceColor(reference.id, Math.min(reference.width - 1, (e.clientX - rect.left) * k), Math.min(reference.height - 1, (e.clientY - rect.top) * k)));
    }}
  >
    <img src={reference.src} alt={reference.name} draggable="false" width={reference.displayWidth} height={h} class="block" />
  </button>
</div>
