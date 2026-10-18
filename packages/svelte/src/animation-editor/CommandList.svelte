<script lang="ts">
  import {
    MOTION_COMMAND_TYPES,
    defaultMotionCommand,
    duplicateMotionCommandEdit,
    motionCommandRows,
    type AnimationEditorController,
    type MotionCommandType,
    type MotionEdit,
  } from '@pixerate/editor/animation-editor';
  import { animationEditorStateOf } from './createAnimationEditor.svelte.js';

  interface Props {
    controller: AnimationEditorController;
    /** The shot to list (default: the selected shot, else the first). */
    shot?: string;
    /** Targets for a new command (e.g. the element picked on the stage); default: the selected command's. */
    targets?: readonly string[];
    class?: string;
  }

  let { controller, shot, targets, class: className = '' }: Props = $props();
  const view = animationEditorStateOf(() => controller);
  const editor = $derived(view.current);
  const shotId = $derived(shot ?? editor.selection?.shot ?? editor.scene.shots[0]?.id);
  const current = $derived(editor.scene.shots.find((s) => s.id === shotId));
  const rows = $derived(current ? motionCommandRows(editor.scene, current.id) : []);
  const selected = $derived(current && editor.selection?.shot === current.id ? editor.selection.command : undefined);
  let type: MotionCommandType = $state('enter');
  let localError = $state<{ text: string; revision: number } | null>(null);
  // A local error shows until the editor changes; then the editor's own error (if any) shows.
  const message = $derived((localError && localError.revision === editor.revision ? localError.text : null) ?? editor.error);
  function setLocal(text: string | null) {
    localError = text ? { text, revision: editor.revision } : null;
  }
  const btn = 'rounded border border-border px-1.5 py-0.5 text-[11px] disabled:opacity-40';

  function run(edit: MotionEdit | MotionEdit[], label: string) {
    setLocal(null);
    return controller.apply(edit, label);
  }
  function add() {
    if (!current) return;
    const from = targets?.length ? targets : selected !== undefined ? ((current.run[selected] as { targets?: string[] }).targets ?? []) : [];
    const command = defaultMotionCommand(type, from, editor.scene);
    if ('error' in command) {
      setLocal(command.error);
      return;
    }
    const at = selected !== undefined ? selected + 1 : current.run.length;
    if (run({ op: 'add_commands', shot: current.id, commands: [command], at }, `Add ${type}`).ok) controller.select({ shot: current.id, command: at });
  }
  function move(index: number, to: number) {
    if (current && run({ op: 'move_command', shot: current.id, command: index, to }, 'Move command').ok) controller.select({ shot: current.id, command: to });
  }
  function duplicate(index: number) {
    if (current && run(duplicateMotionCommandEdit(editor.scene, current.id, index), 'Duplicate command').ok) controller.select({ shot: current.id, command: index + 1 });
  }
  function setDelay(index: number, raw: string, before: number | undefined) {
    if (!current) return;
    const text = raw.trim();
    if (text === String(before ?? '')) return;
    const n = Number(text);
    if (text && !(Number.isFinite(n) && n >= 0)) {
      setLocal('Delay must be a number of ms, 0 or more.');
      return;
    }
    run(text && n > 0 ? { op: 'update_command', shot: current.id, command: index, set: { delay: n } } : { op: 'update_command', shot: current.id, command: index, remove: ['delay'] }, 'Change delay');
  }
</script>

<!--
  A shot's commands in order: select one to inspect it, change `with` and `delay` inline, move,
  duplicate or delete it, and add new ones. Each change is one controller.apply edit (one undo step).
-->
{#if !current}
  <div class="text-xs text-muted-foreground {className}" data-command-list="">Add a shot to start.</div>
{:else}
  <div class="flex flex-col gap-1 text-xs {className}" data-command-list="" data-for-shot={current.id}>
    <div class="font-medium">Commands in <span class="text-rose-500">{current.label ?? current.id}</span></div>
    <ol class="flex flex-col gap-1" aria-label="Commands">
      {#each rows as row (`${row.index}:${row.summary}`)}
        {@const c = row.command as { with?: string; delay?: number }}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
        <li
          class="flex flex-wrap items-center gap-1 rounded border px-1.5 py-1 {row.index === selected ? 'border-rose-500 bg-rose-500/10' : 'border-border'}"
          data-command={row.index}
          data-selected={row.index === selected || undefined}
          onclick={() => controller.select({ shot: current.id, command: row.index })}
        >
          <span class="min-w-0 flex-1 truncate" title={row.summary}>{row.index + 1}. {row.summary}</span>
          {#if row.flairPrimitive}
            <code class="rounded bg-muted px-1 text-[10px] text-muted-foreground" data-flair-primitive={row.flairPrimitive}>{row.flairPrimitive}</code>
          {/if}
          <span class="tabular-nums text-[10px] text-muted-foreground">{((row.end - row.start) / 1000).toFixed(2)} s</span>
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="flex w-full items-center gap-1" onclick={(e) => e.stopPropagation()}>
            <select
              class="rounded border border-border bg-transparent px-1 py-0.5 text-[11px]"
              aria-label="Starts"
              value={c.with ?? 'after'}
              disabled={editor.readOnly || row.index === 0}
              onchange={(e) =>
                run(
                  e.currentTarget.value === 'after'
                    ? { op: 'update_command', shot: current.id, command: row.index, remove: ['with'] }
                    : { op: 'update_command', shot: current.id, command: row.index, set: { with: e.currentTarget.value } },
                  'Change start'
                )}
            >
              <option value="after">after previous</option>
              <option value="previous">with previous</option>
            </select>
            <label class="flex items-center gap-0.5 text-muted-foreground">
              +
              <input
                class="w-14 rounded border border-border bg-transparent px-1 py-0.5 text-[11px] tabular-nums"
                type="number"
                min="0"
                step="50"
                aria-label="Delay"
                placeholder="0"
                value={c.delay ?? ''}
                disabled={editor.readOnly}
                onchange={(e) => setDelay(row.index, e.currentTarget.value, c.delay)}
              />
              ms
            </label>
            <span class="ml-auto flex gap-0.5">
              <button type="button" class={btn} aria-label="Move up" disabled={editor.readOnly || row.index === 0} onclick={() => move(row.index, row.index - 1)}>↑</button>
              <button type="button" class={btn} aria-label="Move down" disabled={editor.readOnly || row.index === rows.length - 1} onclick={() => move(row.index, row.index + 1)}>↓</button>
              <button type="button" class={btn} aria-label="Duplicate" disabled={editor.readOnly} onclick={() => duplicate(row.index)}>⧉</button>
              <button type="button" class={btn} aria-label="Delete" disabled={editor.readOnly} onclick={() => run({ op: 'delete_commands', shot: current.id, commands: [row.index] }, 'Delete command')}>✕</button>
            </span>
          </div>
        </li>
      {/each}
    </ol>
    {#if !editor.readOnly}
      <div class="flex items-center gap-1">
        <select class="flex-1 rounded border border-border bg-transparent px-1 py-0.5" aria-label="New command type" bind:value={type}>
          {#each MOTION_COMMAND_TYPES as t (t)}
            <option value={t}>{t}</option>
          {/each}
        </select>
        <button type="button" class={btn} onclick={add} data-add-command="">Add command</button>
      </div>
    {/if}
    {#if message}
      <p class="text-red-500" role="alert" data-edit-error="">{message}</p>
    {/if}
  </div>
{/if}
