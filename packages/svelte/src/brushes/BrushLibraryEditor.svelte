<script lang="ts">
  import { brushColourHex, checkBrushEdit, newBrushFor, saveBrushEdit, type Brush, type BrushHostProfile, type BrushLibrary, type BrushPreviewRenderer } from '@pixerate/editor/brushes';
  import { button } from './styles.js';
  import BrushEditor from './BrushEditor.svelte';

  interface Props {
    /** The shared brush library: saves go here, so every editor on it gets the brush. */
    library: BrushLibrary;
    /** The brush to edit (a library id); `null` or absent starts a new brush for the host. */
    brushId?: string | null;
    /** The host the brush is edited for: the editor shows only what it uses. */
    profile: BrushHostProfile;
    /** Draws the preview stroke (the host's renderer, as for `preview_brush`). Without it there is no preview. */
    renderPreview?: BrushPreviewRenderer;
    /** The preview colour for brushes with no solid default colour (default slate). */
    previewColor?: string;
    /** Called with the brush as saved (a copy has a new id): e.g. pick it in the host. */
    onsaved?: (brush: Brush) => void;
    /** With it, a Close button. */
    onclose?: () => void;
    class?: string;
  }
  let { library, brushId = null, profile, renderPreview, previewColor = '#64748b', onsaved, onclose, class: className = '' }: Props = $props();

  let original = $state<Brush | null>(null);
  let builtin = $state(false);
  let draft = $state<Brush | null>(null);
  let status = $state<string | null>(null);
  let preview = $state<string | null>(null);

  $effect(() => {
    const lib = library;
    const id = brushId;
    const p = profile;
    let live = true;
    status = null;
    void (async () => {
      const entry = id ? await lib.get(id) : null;
      if (!live) return;
      original = entry?.brush ?? null;
      builtin = !!entry?.builtin;
      draft = entry?.brush ?? newBrushFor(p);
    })();
    return () => {
      live = false;
    };
  });

  const colour = $derived((draft && brushColourHex(draft.colour?.default ?? '', 'light')) || previewColor);
  $effect(() => {
    const d = draft;
    const render = renderPreview;
    const c = colour;
    if (!d || !render) return;
    let live = true;
    Promise.resolve(render($state.snapshot(d) as Brush, { width: 240, height: 60, color: c.slice(0, 7) }))
      .then((img) => live && (preview = img.data ? `data:${img.mimeType};base64,${img.data}` : null))
      .catch(() => live && (preview = null));
    return () => {
      live = false;
    };
  });

  const errors = $derived(draft ? checkBrushEdit(original, draft, profile).issues.filter((i) => i.severity === 'error') : []);

  const save = async (name?: string) => {
    const saved = await saveBrushEdit(library, { original: original && ($state.snapshot(original) as Brush), brush: $state.snapshot(draft!) as Brush, profile, ...(name !== undefined ? { name } : {}) });
    original = saved.brush;
    builtin = false;
    draft = saved.brush;
    status = `Saved “${saved.brush.name}”${saved.kept.length ? `, keeping what ${profile.name} can't use` : ''}.`;
    onsaved?.(saved.brush);
  };
  const startNew = () => {
    const from = draft ? ($state.snapshot(draft) as Brush) : null;
    original = null;
    builtin = false;
    draft = newBrushFor(profile, from);
    status = null;
  };
</script>

<!--
  BrushEditor on a brush library for one host: loads the brush, edits a draft and saves it with saveBrushEdit. A saved
  brush is changed in place, a built-in is saved as a copy, "Save brush" saves under a new name, and "New brush" starts
  from the current one with only what the host uses. Facets the host can't use are kept on save; a new brush must pass
  the host's check.
-->
{#if draft}
  <div class={`flex flex-col gap-2 text-xs text-slate-200 ${className}`} data-testid="brush-library-editor">
    <div class="flex items-center justify-between gap-2">
      <span class="font-medium" data-testid="brush-library-editor-title">{original ? `${draft.name}${builtin ? ' (built in: saves a copy)' : ''}` : 'New brush'}</span>
      <span class="flex gap-1">
        <button type="button" class={button} title={`A new brush from this one, with only what ${profile.name} uses`} onclick={startNew}>New brush</button>
        {#if onclose}<button type="button" class={button} onclick={onclose}>Close</button>{/if}
      </span>
    </div>
    <BrushEditor
      brush={draft}
      {profile}
      preview={renderPreview ? preview : undefined}
      onchange={(next) => {
        draft = next;
        status = null;
      }}
      onsave={original ? () => save() : undefined}
      saveLabel={builtin ? 'Save a copy' : 'Save'}
      onsaveas={(name) => save(name)}
    />
    {#if errors.length}
      <ul class="text-[11px] text-rose-400" data-testid="brush-library-editor-issues">
        {#each errors as i (i.facet)}<li>{i.reason} {i.fix}</li>{/each}
      </ul>
    {/if}
    {#if status}<p role="status" class="text-[11px] text-emerald-400">{status}</p>{/if}
  </div>
{/if}
