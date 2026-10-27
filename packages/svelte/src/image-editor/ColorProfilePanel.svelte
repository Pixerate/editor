<script lang="ts">
  import { imageChipClass } from './styles.js';
  import type { ImageEditorController, Intent } from '@pixerate/editor/image-editor';
  import { COLOR_MODE_OPTIONS, INTENT_OPTIONS, PROOF_PROFILE_OPTIONS, WORKING_SPACE_OPTIONS, colorPanelView } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';

  interface Props {
    controller: ImageEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();

  let tick = $state(0);
  $effect(() => {
    const c = controller;
    // `subscribe` calls the listener at once: untracked, or the effect would depend on `tick`.
    return untrack(() => c.subscribe(() => tick++));
  });
  const view = $derived.by(() => {
    void tick;
    return colorPanelView(controller);
  });
  let target = $state('display-p3');
  let intent = $state<Intent>('relative');
  let bpc = $state(true);
  let error = $state<string | null>(null);
  const chip = imageChipClass(false);
  const select = 'rounded bg-muted px-1 py-0.5 text-[11px] text-foreground';

  function attempt(fn: () => unknown) {
    try {
      error = null;
      fn();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  function proofWith(patch: Partial<{ id: string; intent: Intent; simulatePaper: boolean; gamutWarning: boolean }>) {
    const cur = view.proof;
    const id = patch.id ?? cur?.id ?? 'coated-cmyk';
    attempt(() =>
      controller.setProofSetup({
        profile: id,
        intent: patch.intent ?? cur?.intent ?? 'relative',
        simulatePaper: patch.simulatePaper ?? cur?.simulatePaper ?? false,
        gamutWarning: patch.gamutWarning ?? cur?.gamutWarning ?? false,
      })
    );
  }
</script>

<div class="flex flex-col gap-2 text-xs text-foreground {className}" data-testid="color-profile-panel">
  <div class="flex items-center gap-2">
    <span class="text-muted-foreground">Profile</span>
    <span data-testid="color-profile-name">{view.profileName}</span>
  </div>
  <div class="flex flex-wrap items-center gap-1" role="group" aria-label="Colour mode">
    <span class="text-muted-foreground">Mode</span>
    <select aria-label="Colour mode" class={select} value={view.mode} onchange={(e) => attempt(() => controller.setColorMode((e.target as HTMLSelectElement).value as 'rgb' | 'cmyk' | 'lab'))}>
      {#each COLOR_MODE_OPTIONS as o (o.id)}
        <option value={o.id} title={o.title}>{o.label}</option>
      {/each}
    </select>
    {#if view.cmykProfileName}
      <span class="text-muted-foreground">{view.cmykProfileName}</span>
    {/if}
  </div>
  <div class="flex flex-wrap items-center gap-1" role="group" aria-label="Assign or convert">
    <select aria-label="Target profile" class={select} value={target} onchange={(e) => (target = (e.target as HTMLSelectElement).value)}>
      {#each WORKING_SPACE_OPTIONS as o (o.id)}
        <option value={o.id}>{o.label}</option>
      {/each}
    </select>
    <select aria-label="Rendering intent" class={select} value={intent} onchange={(e) => (intent = (e.target as HTMLSelectElement).value as Intent)}>
      {#each INTENT_OPTIONS as o (o.id)}
        <option value={o.id} title={o.title}>{o.label}</option>
      {/each}
    </select>
    <label class="flex items-center gap-1">
      <input type="checkbox" aria-label="Black point compensation" checked={bpc} onchange={(e) => (bpc = (e.target as HTMLInputElement).checked)} class="accent-primary" />
      BPC
    </label>
    <button type="button" class={chip} title="Edit › Assign Profile: keep the numbers" onclick={() => attempt(() => controller.assignProfile(target))}>Assign</button>
    <button type="button" class={chip} title="Edit › Convert to Profile: keep the look" onclick={() => attempt(() => controller.convertToProfile(target, { intent, bpc }))}>Convert</button>
  </div>
  <div class="flex flex-wrap items-center gap-1" role="group" aria-label="Proof setup">
    <span class="text-muted-foreground">Proof</span>
    <select
      aria-label="Proof profile"
      class={select}
      value={view.proof?.id ?? ''}
      onchange={(e) => {
        const v = (e.target as HTMLSelectElement).value;
        if (v) proofWith({ id: v });
        else attempt(() => controller.setProofSetup(null));
      }}>
      <option value="">Off</option>
      {#each PROOF_PROFILE_OPTIONS as o (o.id)}
        <option value={o.id}>{o.label}</option>
      {/each}
    </select>
    {#if view.proof}
      <select aria-label="Proof intent" class={select} value={view.proof.intent} onchange={(e) => proofWith({ intent: (e.target as HTMLSelectElement).value as Intent })}>
        {#each INTENT_OPTIONS as o (o.id)}
          <option value={o.id}>{o.label}</option>
        {/each}
      </select>
      <label class="flex items-center gap-1">
        <input type="checkbox" aria-label="Simulate paper colour" checked={view.proof.simulatePaper} onchange={(e) => proofWith({ simulatePaper: (e.target as HTMLInputElement).checked })} class="accent-primary" />
        Paper
      </label>
      <label class="flex items-center gap-1">
        <input type="checkbox" aria-label="Gamut warning" checked={view.proof.gamutWarning} onchange={(e) => proofWith({ gamutWarning: (e.target as HTMLInputElement).checked })} class="accent-primary" />
        Gamut warning
      </label>
    {/if}
  </div>
  {#if error}
    <p role="alert" class="text-destructive">{error}</p>
  {/if}
</div>
