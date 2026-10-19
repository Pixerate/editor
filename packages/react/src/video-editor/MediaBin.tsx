import React, { useState } from 'react';
import {
  formatVideoSeconds,
  probeVideoMedia,
  videoAssetDropEdit,
  videoAssetKindOf,
  type VideoAsset,
  type VideoAssetKind,
  type VideoEditorController,
} from '@pixerate/editor/video-editor';
import { useVideoEditorState } from './useVideoEditor';

export interface MediaBinProps {
  controller: VideoEditorController;
  /** Show the import controls and "Add to timeline" buttons (default true). */
  editable?: boolean;
  /** Turns a file into a URL the preview and exporter can open (default `URL.createObjectURL`). */
  fileToUrl?: (file: File) => string;
  /** Reads a source's length and size (default `probeVideoMedia`). */
  probe?: typeof probeVideoMedia;
  className?: string;
}

const btn = 'rounded border border-border px-2 py-0.5 text-xs disabled:opacity-40';

/**
 * The project's assets (name, kind, length), each with an "Add to timeline" button that puts it at
 * the end of the first unlocked track of its kind. Import media by choosing or dropping files (read
 * as object URLs and probed for their length and size) or by URL. Each import is one undo step.
 */
export function MediaBin({ controller, editable = true, fileToUrl, probe = probeVideoMedia, className = '' }: MediaBinProps) {
  const { project, readOnly } = useVideoEditorState(controller);
  const canEdit = editable && !readOnly;
  const [url, setUrl] = useState('');
  const [urlKind, setUrlKind] = useState<VideoAssetKind | ''>('');
  const [busy, setBusy] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  const addSource = async (src: string, kind: VideoAssetKind, name: string) => {
    setBusy((n) => n + 1);
    try {
      const found = await probe(src, kind).catch(() => null);
      const result = controller.apply({ op: 'add_asset', asset: { kind, src, name, ...(found ?? {}) } }, `Import ${name}`);
      if (!result.ok) setProblem(result.error);
    } finally {
      setBusy((n) => n - 1);
    }
  };

  const addFiles = async (files: FileList | File[] | null) => {
    setProblem(null);
    for (const file of Array.from(files ?? [])) {
      const kind = videoAssetKindOf(file.type || file.name);
      if (!kind) {
        setProblem(`"${file.name}" is not a video, audio or image file.`);
        continue;
      }
      const src = fileToUrl ? fileToUrl(file) : URL.createObjectURL(file);
      await addSource(src, kind, file.name);
    }
  };

  const addUrl = async () => {
    const src = url.trim();
    if (!src) return;
    const kind = urlKind || videoAssetKindOf(src.replace(/[?#].*$/, ''));
    if (!kind) {
      setProblem(`Can't tell whether "${src}" is video, audio or an image; choose its kind.`);
      return;
    }
    setProblem(null);
    await addSource(src, kind, src.replace(/[?#].*$/, '').replace(/^.*[\\/]/, '') || src);
    setUrl('');
  };

  const addToTimeline = (asset: VideoAsset) => {
    const edit = videoAssetDropEdit(project, asset.id);
    if (!edit) {
      setProblem(`There is no unlocked ${asset.kind === 'audio' ? 'audio' : 'video'} track to put "${asset.name ?? asset.id}" on.`);
      return;
    }
    setProblem(null);
    const result = controller.apply(edit, `Add ${asset.name ?? asset.id}`);
    if (result.ok) {
      const added = result.outcomes[0]?.clip;
      if (added) controller.select([added]);
    }
  };

  return (
    <div
      className={`flex flex-col gap-2 rounded ${over ? 'ring-2 ring-rose-500/60' : ''} ${className}`}
      data-media-bin=""
      onDragOver={(e) => {
        if (!canEdit || !e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!canEdit || !e.dataTransfer?.files?.length) return;
        e.preventDefault();
        void addFiles(e.dataTransfer.files);
      }}
    >
      <div className="text-xs font-medium">Media</div>
      {project.assets.length ? (
        <ul className="flex flex-col gap-1" aria-label="Media assets">
          {project.assets.map((asset) => (
            <li key={asset.id} className="flex items-center gap-2 text-xs" data-asset={asset.id}>
              <span className="rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground" data-asset-kind="">
                {asset.kind}
              </span>
              <span className="min-w-0 flex-1 truncate" title={asset.src}>
                {asset.name ?? asset.id}
              </span>
              {asset.proxies?.length ? (
                <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground" title={`Proxies: ${asset.proxies.map((p) => `${p.scale * 100}%`).join(', ')} (the preview can play these; exports use the original)`} data-asset-proxies="">
                  proxy
                </span>
              ) : null}
              {asset.duration !== undefined && <span className="tabular-nums text-muted-foreground">{formatVideoSeconds(asset.duration)}</span>}
              {editable && (
                <button type="button" className={btn} disabled={!canEdit} onClick={() => addToTimeline(asset)} data-add-to-timeline="">
                  Add to timeline
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No media yet.{editable ? ' Choose or drop files, or add a URL.' : ''}</p>
      )}
      {editable && (
        <>
          <label className="flex flex-col gap-1 rounded border border-dashed border-border p-2 text-xs text-muted-foreground">
            Choose or drop video, audio or image files
            <input
              type="file"
              multiple
              accept="video/*,audio/*,image/*"
              disabled={!canEdit}
              aria-label="Import media files"
              data-import-files=""
              onChange={(e) => {
                const files = e.currentTarget.files ? Array.from(e.currentTarget.files) : [];
                e.currentTarget.value = '';
                void addFiles(files);
              }}
            />
          </label>
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              void addUrl();
            }}
          >
            <input
              className="min-w-0 flex-1 rounded border border-border bg-transparent px-1 py-0.5 text-xs"
              placeholder="https://…/clip.mp4"
              value={url}
              disabled={!canEdit}
              aria-label="Media URL"
              onChange={(e) => setUrl(e.target.value)}
            />
            <select className="rounded border border-border bg-transparent px-1 py-0.5 text-xs" value={urlKind} disabled={!canEdit} aria-label="Media kind" onChange={(e) => setUrlKind(e.target.value as VideoAssetKind | '')}>
              <option value="">Auto</option>
              <option value="video">Video</option>
              <option value="audio">Audio</option>
              <option value="image">Image</option>
            </select>
            <button type="submit" className={btn} disabled={!canEdit || !url.trim()} data-add-url="">
              Add
            </button>
          </form>
        </>
      )}
      {busy > 0 && <p className="text-xs text-muted-foreground">Reading media…</p>}
      {problem && (
        <p className="text-xs text-red-500" role="alert" data-media-error="">
          {problem}
        </p>
      )}
    </div>
  );
}
