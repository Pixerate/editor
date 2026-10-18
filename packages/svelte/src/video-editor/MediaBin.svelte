<script lang="ts">
  import {
    formatVideoSeconds,
    probeVideoMedia,
    videoAssetDropEdit,
    videoAssetKindOf,
    type VideoAsset,
    type VideoAssetKind,
    type VideoEditorController,
  } from '@pixerate/editor/video-editor';
  import { videoEditorStateOf } from './createVideoEditor.svelte.js';

  interface Props {
    controller: VideoEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();
  const view = videoEditorStateOf(() => controller);
  const editor = $derived(view.current);
  const assets = $derived(editor.project.assets);
  let url = $state('');
  let urlKind = $state<VideoAssetKind | ''>('');
  let busy = $state(0);
  let dragOver = $state(false);
  let localError = $state<{ text: string; revision: number } | null>(null);
  // A local error shows until the editor changes; then the editor's own error (if any) shows.
  const message = $derived((localError && localError.revision === editor.revision ? localError.text : null) ?? editor.error);
  const btn = 'rounded border border-border px-1.5 py-0.5 text-[11px] disabled:opacity-40';

  function fail(text: string) {
    localError = { text, revision: editor.revision };
  }

  function addToTimeline(asset: VideoAsset) {
    localError = null;
    const edit = videoAssetDropEdit(editor.project, asset.id);
    if (!edit) return fail(`There is no unlocked ${asset.kind === 'audio' ? 'audio' : 'video'} track to add "${asset.name ?? asset.id}" to.`);
    const result = controller.apply(edit, 'Add clip');
    const clip = result.ok ? result.outcomes[0]?.clip : undefined;
    if (clip) controller.select([clip]);
  }

  /** Reads the media's length and size, then adds it as an asset (without them if it cannot be read). */
  async function addAsset(src: string, kind: VideoAssetKind, name: string) {
    busy++;
    let probe: { duration?: number; width?: number; height?: number } = {};
    let problem: string | null = null;
    try {
      const { kind: _kind, ...found } = await probeVideoMedia(src, kind);
      probe = found;
    } catch (error) {
      problem = (error as Error).message;
    } finally {
      busy--;
    }
    localError = null;
    const result = controller.apply({ op: 'add_asset', asset: { kind, src, name, ...probe } }, 'Add media');
    if (result.ok && problem) fail(`${problem} It was added without its length; set one before using it.`);
  }

  function addFiles(files: FileList | readonly File[] | null | undefined) {
    if (!files || editor.readOnly) return;
    for (const file of Array.from(files)) {
      const kind = videoAssetKindOf(file.type || file.name);
      if (!kind) {
        fail(`"${file.name}" is not a video, audio or image file.`);
        continue;
      }
      // The object URL lives as long as the page: the project keeps referring to it.
      void addAsset(URL.createObjectURL(file), kind, file.name);
    }
  }

  function addUrl() {
    const src = url.trim();
    if (!src) return;
    const kind = urlKind || videoAssetKindOf(src.split(/[?#]/)[0]);
    if (!kind) return fail('Choose whether the URL is a video, audio or image: its extension does not say.');
    url = '';
    urlKind = '';
    void addAsset(src, kind, src.split(/[?#]/)[0].replace(/^.*[\\/]/, '') || src);
  }
</script>

<!--
  The project's media: add files (pick or drop them) or a URL, then add each to the timeline at the
  end of the first track of its kind. Every addition is one undo step.
-->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="flex flex-col gap-1.5 rounded text-xs {dragOver ? 'outline-dashed outline-2 outline-rose-500' : ''} {className}"
  data-media-bin=""
  ondragover={(e) => {
    if (editor.readOnly || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dragOver = true;
  }}
  ondragleave={() => (dragOver = false)}
  ondrop={(e) => {
    dragOver = false;
    if (editor.readOnly || !e.dataTransfer?.files.length) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  }}
>
  <div class="flex items-center gap-1">
    <span class="font-medium">Media</span>
    {#if busy}<span class="text-muted-foreground" data-busy="">Reading…</span>{/if}
    <label class="{btn} ml-auto cursor-pointer {editor.readOnly ? 'pointer-events-none opacity-40' : ''}">
      Add files
      <input
        type="file"
        class="sr-only"
        multiple
        accept="video/*,audio/*,image/*"
        disabled={editor.readOnly}
        aria-label="Add media files"
        onchange={(e) => {
          addFiles(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
        data-file-input=""
      />
    </label>
  </div>
  {#if assets.length}
    <ul class="flex flex-col gap-0.5" aria-label="Media">
      {#each assets as asset (asset.id)}
        <li class="flex items-center gap-1 rounded border border-border px-1 py-0.5" data-asset={asset.id}>
          <span class="rounded bg-muted px-1 text-[10px] text-muted-foreground">{asset.kind}</span>
          <span class="min-w-0 flex-1 truncate" title={asset.src}>{asset.name ?? asset.id}</span>
          {#if asset.duration !== undefined}<span class="tabular-nums text-muted-foreground">{formatVideoSeconds(asset.duration)}</span>{/if}
          <button type="button" class={btn} disabled={editor.readOnly} onclick={() => addToTimeline(asset)} aria-label="Add {asset.name ?? asset.id} to timeline" data-add-to-timeline="">Add to timeline</button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="text-muted-foreground">Drop video, audio or images here, or add them from a file or URL.</p>
  {/if}
  <form
    class="flex items-center gap-1"
    onsubmit={(e) => {
      e.preventDefault();
      addUrl();
    }}
  >
    <input class="min-w-0 flex-1 rounded border border-border bg-transparent px-1 py-0.5" type="url" placeholder="https://…/clip.mp4" aria-label="Media URL" disabled={editor.readOnly} bind:value={url} data-url-input="" />
    <select class="rounded border border-border bg-transparent px-1 py-0.5" aria-label="Media kind" disabled={editor.readOnly} bind:value={urlKind}>
      <option value="">auto</option>
      <option value="video">video</option>
      <option value="audio">audio</option>
      <option value="image">image</option>
    </select>
    <button type="submit" class={btn} disabled={editor.readOnly || !url.trim()} data-add-url="">Add URL</button>
  </form>
  {#if message}
    <p class="text-red-500" role="alert" data-edit-error="">{message}</p>
  {/if}
</div>
