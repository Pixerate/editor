<script lang="ts">
  import { isVectorFrame, vectorMasterPages, vectorPages, type VectorEditorController, type VectorFrameGroup } from '@pixerate/editor/vector';
  import { vectorStateOf } from './subscribe.svelte.js';

  /**
   * Pages: the document's pages (top-level frames) to go to, adding pages and master pages, and
   * the master page the selected page uses. Adding and applying are one undo step each.
   */
  interface Props {
    controller: VectorEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();

  const store = vectorStateOf(() => controller);
  const view = $derived(store.current);
  const pages = $derived(vectorPages(view.document));
  const masters = $derived(vectorMasterPages(view.document));
  const page = $derived.by((): VectorFrameGroup | null => {
    const n = view.selection.map((id) => view.document.nodes.find((x) => x.id === id)).find((x) => isVectorFrame(x));
    return n && isVectorFrame(n) && !n.frame.master ? n : null;
  });

  const buttonClass =
    'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 aria-[current=true]:bg-primary aria-[current=true]:text-primary-foreground';
  const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
</script>

<div class="space-y-2 {className}" data-vector-pages-panel="" aria-label="Pages">
  <div class="flex flex-wrap items-center gap-1">
    <span class="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Pages</span>
    {#each pages as p, i (p.id)}
      <button type="button" class={buttonClass} aria-current={view.selection.includes(p.id)} data-vector-page={p.id} title={`Go to ${p.name ?? `page ${i + 1}`}`} onclick={() => controller.goToPage(p.id)}>{i + 1}</button>
    {/each}
    {#each masters as m (m.id)}
      <button type="button" class={buttonClass} aria-current={view.selection.includes(m.id)} data-vector-master-page={m.id} title={`Go to master page ${m.name ?? ''}`} onclick={() => controller.goToPage(m.id)}>{m.name ?? 'Master'}</button>
    {/each}
    <button type="button" class={buttonClass} data-vector-pages-action="add" title="Add a page after the last" onclick={() => controller.addPage()}>+ Page</button>
    <button type="button" class={buttonClass} data-vector-pages-action="master" title={'Add a master page used by every page (headers, footers, {page} numbers)'} onclick={() => controller.addMasterPage({ assignTo: 'all' })}>+ Master</button>
  </div>
  {#if page && masters.length > 0}
    <div class="flex flex-wrap items-center gap-1">
      <span class="w-16"></span>
      <select aria-label="Master page" class={selectClass} value={page.frame.masterId ?? ''} onchange={(e) => page && controller.setPageMaster(e.currentTarget.value || null, { ids: [page.id] })}>
        <option value="">No master</option>
        {#each masters as m (m.id)}<option value={m.id}>{m.name ?? 'Master'}</option>{/each}
      </select>
    </div>
  {/if}
</div>
