import React, { useEffect, useRef, useState } from 'react';
import type { AlphaChannel, ImageEditorController } from '@pixerate/editor/image-editor';
import { MASK_FILE_ACCEPT, channelThumbnail, downloadMaskImage, openMaskFile, selectionModeFromModifiers } from '@pixerate/editor/image-editor';
import { imageSectionTitleClass } from './styles';

export interface ChannelsPanelProps {
  controller: ImageEditorController;
  /** Thumbnail size in CSS pixels (default 32). */
  thumbnailSize?: number;
  className?: string;
}

const btn = (on = false) =>
  `px-2 py-1 rounded-md border text-[11px] transition-colors disabled:opacity-40 ${
    on ? 'bg-primary border-primary text-primary-foreground' : 'bg-background border-border text-foreground hover:bg-accent hover:text-accent-foreground'
  }`;

const ChannelThumb: React.FC<{ channel: AlphaChannel; size: number }> = ({ channel, size }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || typeof ctx.createImageData !== 'function') return;
    const px = channelThumbnail(channel, 64);
    canvas.width = px.width;
    canvas.height = px.height;
    const img = ctx.createImageData(px.width, px.height);
    img.data.set(px.data);
    ctx.putImageData(img, 0, 0);
  }, [channel.mask]);
  return <canvas ref={ref} aria-hidden="true" style={{ width: size, height: size }} className="shrink-0 rounded object-contain ring-1 ring-border bg-black" />;
};

/**
 * The Channels panel: the alpha channels (saved selections) with thumbnails, an eye to show
 * each as a tint, click to load it as the selection (Shift adds, Alt subtracts, both
 * intersect), double-click to rename; Save Selection, Duplicate and Delete; Import (a mask
 * image into a new channel) and Export PNG (the active channel, else the selection); and the
 * Quick Mask mode switch (Q on the canvas). Every change is one undo step on the controller.
 */
export const ChannelsPanel: React.FC<ChannelsPanelProps> = ({ controller, thumbnailSize = 32, className = '' }) => {
  const [, setTick] = useState(0);
  useEffect(() => controller.subscribe(() => setTick((n) => n + 1)), [controller]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const channels = controller.getChannels();
  const active = channels.find((c) => c.id === activeId) ?? null;
  const hasSelection = Boolean(controller.getSelection());
  const quickMask = controller.quickMaskEditing;
  const attempt = (fn: () => unknown) => {
    setError(null);
    try {
      fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      setActiveId((await openMaskFile(controller, file)).id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div data-testid="channels-panel" className={`flex flex-col gap-2 text-xs ${className}`}>
      <div className="flex items-center justify-between">
        <span className={imageSectionTitleClass}>Channels</span>
        <button type="button" aria-pressed={quickMask} className={btn(quickMask)} title="Paint the selection: white selects, black deselects (Q)" onClick={() => controller.setQuickMaskMode(!quickMask)}>
          Quick Mask
        </button>
      </div>
      {channels.length === 0 && <p className="text-muted-foreground">No channels. Save a selection to keep it.</p>}
      <ul role="list" className="flex flex-col gap-0.5">
        {channels.map((c) => (
          <li
            key={c.id}
            data-testid="channel-row"
            aria-current={c.id === activeId ? "true" : undefined}
            className={`flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer select-none ${c.id === activeId ? 'bg-primary/30 ring-1 ring-primary' : 'hover:bg-muted'}`}
            onClick={(e) => {
              setActiveId(c.id);
              attempt(() => controller.loadSelectionFromChannel(c.id, { mode: selectionModeFromModifiers(e, 'replace') }));
            }}
            onDoubleClick={() => setRenaming(c.id)}
          >
            <button
              type="button"
              aria-label={`${c.visible ? 'Hide' : 'Show'} ${c.name}`}
              aria-pressed={c.visible}
              className="w-4 text-muted-foreground"
              onClick={(e) => {
                e.stopPropagation();
                attempt(() => controller.setChannelProperties(c.id, { visible: !c.visible }));
              }}
            >
              {c.visible ? '●' : '○'}
            </button>
            <ChannelThumb channel={c} size={thumbnailSize} />
            {renaming === c.id ? (
              <input
                autoFocus
                aria-label="Channel name"
                defaultValue={c.name}
                className="min-w-0 flex-1 bg-background border border-border rounded px-1 py-0.5 text-foreground"
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  setRenaming(null);
                  if (e.currentTarget.value.trim() && e.currentTarget.value !== c.name) attempt(() => controller.setChannelProperties(c.id, { name: e.currentTarget.value }));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') setRenaming(null);
                }}
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-1">
        <button type="button" className={btn()} disabled={!hasSelection} onClick={() => attempt(() => setActiveId(controller.saveSelection().id))}>
          Save Selection
        </button>
        <button type="button" className={btn()} disabled={!active || !hasSelection} title="Add the selection to the channel" onClick={() => attempt(() => controller.saveSelection({ channelId: active!.id, mode: 'add' }))}>
          Add to Channel
        </button>
        <button type="button" className={btn()} disabled={!active} onClick={() => attempt(() => setActiveId(controller.duplicateChannel(active!.id).id))}>
          Duplicate
        </button>
        <button
          type="button"
          className={btn()}
          disabled={!active}
          onClick={() =>
            attempt(() => {
              controller.deleteChannel(active!.id);
              setActiveId(null);
            })
          }
        >
          Delete
        </button>
        <button type="button" className={btn()} title="Load a mask image (white = selected) into a new channel" onClick={() => fileInput.current?.click()}>
          Import…
        </button>
        <button
          type="button"
          className={btn()}
          disabled={!active && !hasSelection}
          title={active ? 'Save the channel as a greyscale PNG' : 'Save the selection as a greyscale PNG'}
          onClick={() => attempt(() => downloadMaskImage(controller, active ? { channelId: active.id } : 'selection', active?.name ?? 'selection'))}
        >
          Export PNG
        </button>
        <input
          ref={fileInput}
          type="file"
          accept={MASK_FILE_ACCEPT}
          hidden
          data-testid="channel-import-input"
          onChange={(e) => {
            void importFile(e.currentTarget.files?.[0]);
            e.currentTarget.value = '';
          }}
        />
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
};
