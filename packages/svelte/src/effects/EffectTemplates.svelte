<script lang="ts">
  import { checkTemplateValues, isSubjectTemplateSlot, type EffectProvider, type EffectTemplateDescription, type EffectTemplateSummary } from '@pixerate/editor/effects';

  interface Props {
    /** The effects provider; nothing shows unless it has templates. */
    provider: EffectProvider | null | undefined;
    /** Fills the chosen template (the editor's `fillTemplate`). Resolves `{ ok: false, error }` to show the refusal; on success the form closes. */
    onfill: (template: string, values: Record<string, unknown>) => Promise<{ ok: true } | { ok: false; error: string }>;
    /** The button that fills (default "Use template"). */
    fillLabel?: string;
    disabled?: boolean;
    class?: string;
  }

  let { provider, onfill, fillLabel = 'Use template', disabled = false, class: className = '' }: Props = $props();
  const input = 'w-full min-w-0 rounded border border-border bg-transparent px-1 py-0.5 text-xs';
  const btn = 'rounded border border-border px-2 py-0.5 text-[11px] disabled:opacity-40';

  const supported = $derived(!!provider?.capabilities.supportsTemplates && !!provider.listTemplates && !!provider.describeTemplate);
  let templates = $state<readonly EffectTemplateSummary[]>([]);
  let chosen = $state('');
  let description = $state<EffectTemplateDescription | null>(null);
  let values = $state<Record<string, unknown>>({});
  let message = $state<string | null>(null);
  let busy = $state(false);

  $effect(() => {
    const p = provider;
    const ok = supported;
    let live = true;
    templates = [];
    chosen = '';
    if (ok) void Promise.resolve(p!.listTemplates!()).then((t) => live && (templates = t), () => live && (templates = []));
    return () => (live = false);
  });

  $effect(() => {
    const id = chosen;
    const p = provider;
    let live = true;
    description = null;
    message = null;
    if (!id || !supported) return;
    void Promise.resolve(p!.describeTemplate!(id)).then(
      (d) => {
        if (!live) return;
        description = d;
        values = Object.fromEntries(d.slots.map((s) => [s.name, isSubjectTemplateSlot(s) ? '' : (s as { default: unknown }).default]));
      },
      (e: Error) => live && (message = e.message)
    );
    return () => (live = false);
  });

  // Empty subject fields are left out (their default, or left open); empty numbers too.
  const given = $derived(Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '')));
  const problems = $derived(description ? checkTemplateValues(description.slots, given) : []);
  const problemFor = (slot: string) => problems.find((p) => p.startsWith(`Slot "${slot}"`));

  async function fill(e: SubmitEvent) {
    e.preventDefault();
    if (!description || problems.length) return;
    busy = true;
    const r = await onfill(description.id, given);
    busy = false;
    if (r.ok) chosen = '';
    else message = r.error;
  }
</script>

<!--
  The provider's sequence templates: pick one, fill its slots in a form (built from
  describeTemplate, checked with checkTemplateValues as you type) and use it. Hidden when the
  provider has no templates.
-->
{#if supported && templates.length}
  <div class="flex flex-col gap-1 text-xs {className}" data-effect-templates="">
    <select class={input} aria-label="Template" {disabled} bind:value={chosen}>
      <option value="">Templates…</option>
      {#each templates as t (t.id)}<option value={t.id}>{t.name} ({t.shots} shots)</option>{/each}
    </select>
    {#if description}
      <form class="flex flex-col gap-1 rounded border border-border p-1" data-template-form={description.id} onsubmit={fill}>
        <p class="text-[11px] text-muted-foreground">{description.description}</p>
        {#each description.slots as slot (slot.name)}
          {@const id = `template-slot-${slot.name}`}
          {@const error = problemFor(slot.name)}
          <div class="flex flex-col gap-0.5" data-template-slot={slot.name}>
            <label for={id} class="text-muted-foreground" title={slot.description}>{slot.label}</label>
            {#if slot.type === 'color'}
              <input {id} class="h-6 w-10" type="color" value={String(values[slot.name])} oninput={(e) => (values = { ...values, [slot.name]: e.currentTarget.value })} />
            {:else if slot.type === 'number'}
              <input {id} class={input} type="number" min={slot.min} max={slot.max} step={slot.integer ? 1 : 'any'} value={String(values[slot.name])} oninput={(e) => (values = { ...values, [slot.name]: e.currentTarget.value === '' ? '' : Number(e.currentTarget.value) })} />
            {:else if slot.type === 'text'}
              <div class="flex items-center gap-1">
                <input {id} class={input} maxlength={slot.maxLength} value={String(values[slot.name])} oninput={(e) => (values = { ...values, [slot.name]: e.currentTarget.value })} />
                {#if slot.maxLength !== undefined}<span class="text-[10px] text-muted-foreground">{String(values[slot.name]).length}/{slot.maxLength}</span>{/if}
              </div>
            {:else}
              <input
                {id}
                class={input}
                placeholder={slot.hasDefault ? 'URL or <svg> (default: a placeholder)' : 'URL or <svg> (empty: left open)'}
                value={typeof values[slot.name] === 'string' ? (values[slot.name] as string) : ''}
                oninput={(e) => (values = { ...values, [slot.name]: e.currentTarget.value })}
              />
            {/if}
            {#if error}<p class="text-[11px] text-destructive">{error}</p>{/if}
          </div>
        {/each}
        <div class="flex gap-1">
          <button type="submit" class={btn} disabled={disabled || busy || problems.length > 0}>{fillLabel}</button>
          <button type="button" class={btn} onclick={() => (chosen = '')}>Cancel</button>
        </div>
      </form>
    {/if}
    {#if message}<p role="alert" class="text-[11px] text-destructive">{message}</p>{/if}
  </div>
{/if}
