<script lang="ts">
  import {
    describeMotionElements,
    motionCommandFields,
    motionFieldEdit,
    motionFlairPrimitive,
    type AnimationEditorController,
    type MotionFieldSpec,
  } from '@pixerate/editor/animation-editor';
  import EasePicker from './EasePicker.svelte';
  import { animationEditorStateOf } from './createAnimationEditor.svelte.js';

  interface Props {
    controller: AnimationEditorController;
    /** An element picked on the stage, offered as a target to add. */
    picked?: string | null;
    class?: string;
  }

  let { controller, picked = null, class: className = '' }: Props = $props();
  const view = animationEditorStateOf(() => controller);
  const editor = $derived(view.current);
  const elements = $derived(describeMotionElements(editor.scene));
  const shot = $derived(editor.selection ? editor.scene.shots.find((s) => s.id === editor.selection!.shot) : undefined);
  const index = $derived(editor.selection?.command);
  const command = $derived(shot && index !== undefined ? shot.run[index] : undefined);
  const values = $derived((command ?? {}) as unknown as Record<string, unknown>);
  const fields = $derived(command ? motionCommandFields(command.type) : []);
  const primitive = $derived(command ? motionFlairPrimitive(command) : undefined);
  const targets = $derived((values.targets as string[] | undefined) ?? []);
  let localError = $state<{ text: string; revision: number } | null>(null);
  // A local error shows until the editor changes; then the editor's own error (if any) shows.
  const message = $derived((localError && localError.revision === editor.revision ? localError.text : null) ?? editor.error);
  function setLocal(text: string | null) {
    localError = text ? { text, revision: editor.revision } : null;
  }
  const input = 'w-full min-w-0 rounded border border-border bg-transparent px-1 py-0.5 text-xs';

  function commit(field: MotionFieldSpec, raw: Parameters<typeof motionFieldEdit>[3]) {
    if (!shot || index === undefined) return;
    const edit = motionFieldEdit(shot.id, index, field, raw);
    if ('error' in edit) {
      setLocal(edit.error);
      return;
    }
    setLocal(null);
    controller.apply(edit, `Set ${field.label.toLowerCase()}`);
  }
  const name = (id: string) => elements.find((e) => e.id === id)?.name ?? id;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const numStr = (v: unknown) => (typeof v === 'number' ? String(v) : '');
  const point = (v: unknown) => v as { x: number; y: number } | undefined;
  const step = (f: MotionFieldSpec) => (f.kind === 'integer' ? 1 : f.unit === 'ms' ? 50 : f.unit === '0–1' ? 0.05 : 'any');
</script>

<!--
  A form for the selected command, generated from MOTION_COMMAND_SCHEMA (the schema the agent
  tools take): enums as selects, numbers with units and limits, node pickers and an ease picker.
-->
{#if !shot || index === undefined || !command}
  <div class="text-xs text-muted-foreground {className}" data-command-inspector="">Select a command to edit it.</div>
{:else}
  <div class="flex flex-col gap-1.5 text-xs {className}" data-command-inspector="" data-command-type={command.type}>
    <div class="flex items-center gap-2">
      <span class="font-medium">{index + 1}. {command.type}</span>
      {#if primitive}
        <code class="rounded bg-muted px-1 text-[10px]" data-flair-primitive={primitive} title="The Flair motion primitive this command plays">{primitive}</code>
      {:else}
        <span class="text-[10px] text-muted-foreground">editor-only (no Flair primitive)</span>
      {/if}
    </div>
    {#each ['main', 'timing'] as group (group)}
      <fieldset class="grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-1">
        <legend class="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{group === 'main' ? 'Command' : 'Timing'}</legend>
        {#each fields.filter((f) => f.group === group) as field (field.name)}
          {@const v = values[field.name]}
          <!-- svelte-ignore a11y_label_has_associated_control -->
          <label class="truncate text-muted-foreground" title={field.description}>{field.label}{field.required ? ' *' : ''}</label>
          <div data-field={field.name}>
            {#if field.kind === 'targets'}
              <div class="flex flex-wrap items-center gap-1" data-targets="">
                {#each targets as id (id)}
                  <span class="flex items-center gap-0.5 rounded bg-muted px-1 text-[11px]" data-target={id}>
                    {name(id)}
                    {#if !editor.readOnly && targets.length > 1}
                      <button type="button" aria-label="Remove {id}" onclick={() => commit(field, targets.filter((t) => t !== id))}>×</button>
                    {/if}
                  </span>
                {/each}
                {#if !editor.readOnly && picked && !targets.includes(picked)}
                  <button type="button" class="rounded border border-rose-500 px-1 text-[11px] text-rose-500" onclick={() => commit(field, [...targets, picked!])} data-add-picked="">+ {name(picked)}</button>
                {/if}
                {#if !editor.readOnly}
                  <select class="rounded border border-border bg-transparent px-1 py-0.5 text-[11px]" aria-label="Add target" value="" onchange={(e) => e.currentTarget.value && commit(field, [...targets, e.currentTarget.value])}>
                    <option value="">+ target…</option>
                    {#each elements.filter((e) => !targets.includes(e.id)) as e (e.id)}
                      <option value={e.id}>{e.name ? `${e.name} (${e.id})` : e.id}</option>
                    {/each}
                  </select>
                {/if}
              </div>
            {:else if field.kind === 'node'}
              <select class={input} aria-label={field.label} title={field.description} disabled={editor.readOnly} value={str(v)} onchange={(e) => commit(field, e.currentTarget.value)}>
                {#if !field.required}<option value="">—</option>{/if}
                {#each elements.filter((e) => field.name !== 'path' || e.type === 'path') as e (e.id)}
                  <option value={e.id}>{e.name ? `${e.name} (${e.id})` : e.id}{e.hidden ? ' · hidden' : ''}</option>
                {/each}
              </select>
            {:else if field.kind === 'enum'}
              <select class={input} aria-label={field.label} title={field.description} disabled={editor.readOnly} value={str(v)} onchange={(e) => commit(field, e.currentTarget.value)}>
                {#if !field.required}<option value="">default</option>{/if}
                {#each field.options ?? [] as o (o)}
                  <option value={o}>{o}</option>
                {/each}
              </select>
            {:else if field.kind === 'boolean'}
              <input type="checkbox" aria-label={field.label} title={field.description} disabled={editor.readOnly} checked={v === true} onchange={(e) => commit(field, e.currentTarget.checked)} />
            {:else if field.kind === 'ease'}
              <EasePicker value={v as never} disabled={editor.readOnly} onchange={(ease) => commit(field, ease === undefined ? '' : (ease as string))} />
            {:else if field.kind === 'color'}
              <div class="flex items-center gap-1">
                <input type="color" disabled={editor.readOnly} aria-label="{field.label} swatch" value={/^#[0-9a-f]{6}$/i.test(str(v)) ? str(v) : '#000000'} onchange={(e) => commit(field, e.currentTarget.value)} />
                <input class={input} aria-label={field.label} title={field.description} disabled={editor.readOnly} placeholder="unchanged" value={str(v)} onchange={(e) => commit(field, e.currentTarget.value)} />
              </div>
            {:else if field.kind === 'point'}
              {@const p = point(v)}
              <div class="flex items-center gap-1">
                <input class={input} type="number" disabled={editor.readOnly} aria-label="{field.label} x" placeholder="x" value={p ? String(p.x) : ''}
                  onchange={(e) => commit(field, { x: e.currentTarget.value, y: p ? String(p.y) : e.currentTarget.value ? '0' : '' })} />
                <input class={input} type="number" disabled={editor.readOnly} aria-label="{field.label} y" placeholder="y" value={p ? String(p.y) : ''}
                  onchange={(e) => commit(field, { x: p ? String(p.x) : e.currentTarget.value ? '0' : '', y: e.currentTarget.value })} />
              </div>
            {:else if field.kind === 'number' || field.kind === 'integer' || field.kind === 'scale'}
              <div class="flex items-center gap-1">
                <input class={input} type="number" aria-label={field.label} title={field.description} disabled={editor.readOnly} min={field.min} max={field.max} step={step(field)} placeholder="default" value={numStr(v)} onchange={(e) => commit(field, e.currentTarget.value)} />
                {#if field.unit}<span class="shrink-0 text-[10px] text-muted-foreground">{field.unit}</span>{/if}
              </div>
            {:else}
              <input class={input} aria-label={field.label} title={field.description} disabled={editor.readOnly} value={str(v)} onchange={(e) => commit(field, e.currentTarget.value)} />
            {/if}
          </div>
        {/each}
      </fieldset>
    {/each}
    {#if message}
      <p class="text-red-500" role="alert" data-edit-error="">{message}</p>
    {/if}
  </div>
{/if}
