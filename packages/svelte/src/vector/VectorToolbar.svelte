<script lang="ts">
  import {
    VECTOR_TOOLS,
    VECTOR_TOOL_GLYPHS,
    VECTOR_TOOL_SHORTCUTS,
    vectorToolLabel,
    type VectorEditorController,
    type VectorTool
  } from '@pixerate/editor/vector';
  import { vectorStateOf } from './subscribe.svelte.js';
  import { vectorButtonClass } from './styles.js';

  interface Props {
    controller: VectorEditorController;
    /** Tools to show (default: all). */
    tools?: readonly VectorTool[];
    /** Undo / redo buttons (default `true`). */
    showHistory?: boolean;
    /** Boolean, group, arrange and align buttons (default `true`). */
    showArrange?: boolean;
    /** The snapping toggle (default `true`). */
    showSnap?: boolean;
    class?: string;
  }

  let { controller, tools = VECTOR_TOOLS, showHistory = true, showArrange = true, showSnap = true, class: className = '' }: Props = $props();

  const snapTitle = 'Snap to objects';
  const modKey = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '') ? '⌘' : 'Ctrl';

  const store = vectorStateOf(() => controller);
  const view = $derived(store.current);
  const count = $derived(view.selection.length);
  const groupSelected = $derived(view.selection.some((id) => controller.getNode(id)?.type === 'group'));

  const combine = $derived([
    { label: '∪', title: 'Union', run: () => controller.booleanOp('union'), disabled: count < 2 },
    { label: '−', title: 'Subtract', run: () => controller.booleanOp('subtract'), disabled: count < 2 },
    { label: '∩', title: 'Intersect', run: () => controller.booleanOp('intersect'), disabled: count < 2 },
    { label: '⊻', title: 'Exclude', run: () => controller.booleanOp('exclude'), disabled: count < 2 },
    { label: 'G', title: 'Group', run: () => controller.group(), disabled: count < 1 },
    { label: 'U', title: 'Ungroup', run: () => controller.ungroup(), disabled: !groupSelected }
  ]);
  const arrange = $derived([
    { label: '⇈', title: 'Bring to Front', run: () => controller.arrange('front'), disabled: count < 1 },
    { label: '⇊', title: 'Send to Back', run: () => controller.arrange('back'), disabled: count < 1 },
    { label: '⇤', title: 'Align Left', run: () => controller.align('left'), disabled: count < 1 },
    { label: '↔', title: 'Align Center', run: () => controller.align('center'), disabled: count < 1 },
    { label: '⇥', title: 'Align Right', run: () => controller.align('right'), disabled: count < 1 },
    { label: '⤒', title: 'Align Top', run: () => controller.align('top'), disabled: count < 1 },
    { label: '↕', title: 'Align Middle', run: () => controller.align('middle'), disabled: count < 1 },
    { label: '⤓', title: 'Align Bottom', run: () => controller.align('bottom'), disabled: count < 1 }
  ]);
</script>

{#snippet action(item: { label: string; title: string; run: () => unknown; disabled: boolean })}
  <button type="button" class={vectorButtonClass} title={item.title} aria-label={item.title} disabled={item.disabled} onclick={() => void item.run()}>
    {item.label}
  </button>
{/snippet}

<div role="toolbar" aria-label="Vector tools" class="flex flex-wrap items-center gap-1 {className}">
  <div class="flex items-center gap-1" role="group" aria-label="Tools">
    {#each tools as tool (tool)}
      <button
        type="button"
        data-vector-tool={tool}
        class={vectorButtonClass}
        aria-pressed={view.tool === tool}
        title="{vectorToolLabel(tool)} ({VECTOR_TOOL_SHORTCUTS[tool]})"
        aria-label={vectorToolLabel(tool)}
        onclick={() => controller.setTool(tool)}
      >
        {VECTOR_TOOL_GLYPHS[tool]}
      </button>
    {/each}
  </div>
  {#if showHistory}
    <div class="ml-1 flex items-center gap-1" role="group" aria-label="History">
      {@render action({ label: '↶', title: view.canUndo ? `Undo ${view.undoLabel}` : 'Undo', run: () => controller.undo(), disabled: !view.canUndo })}
      {@render action({ label: '↷', title: view.canRedo ? `Redo ${view.redoLabel}` : 'Redo', run: () => controller.redo(), disabled: !view.canRedo })}
    </div>
  {/if}
  {#if showSnap}
    <div class="ml-1 flex items-center gap-1" role="group" aria-label="Snapping">
      <button
        type="button"
        data-vector-snap=""
        class={vectorButtonClass}
        aria-pressed={view.snap.objects}
        title="{snapTitle} (hold {modKey} to bypass)"
        aria-label={snapTitle}
        onclick={() => controller.toggleSnapping()}
      >
        Snap
      </button>
    </div>
  {/if}
  {#if showArrange}
    <div class="ml-1 flex items-center gap-1" role="group" aria-label="Combine">
      {#each combine as item (item.title)}{@render action(item)}{/each}
    </div>
    <div class="ml-1 flex items-center gap-1" role="group" aria-label="Arrange">
      {#each arrange as item (item.title)}{@render action(item)}{/each}
    </div>
  {/if}
</div>
