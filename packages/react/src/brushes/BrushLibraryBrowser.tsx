import React, { useEffect, useMemo, useRef, useState } from 'react';
import { brushLibraryGroups, type BrushHostProfile, type BrushLibraryEntry } from '@pixerate/editor/brushes';

type Pixels = { width: number; height: number; data: Uint8ClampedArray };

/** A thumbnail: RGBA pixels drawn on a canvas, or an image URL (e.g. a brushstroke swatch's data URL). */
const Thumbnail: React.FC<{ image: Pixels | string | null; label: string; style: React.CSSProperties }> = ({ image, label, style }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !image || typeof image === 'string' || typeof ctx.createImageData !== 'function') return;
    canvas.width = image.width;
    canvas.height = image.height;
    const img = ctx.createImageData(image.width, image.height);
    img.data.set(image.data);
    ctx.putImageData(img, 0, 0);
  }, [image]);
  if (typeof image === 'string') return <img src={image} alt={label} className="rounded object-contain" style={style} />;
  return <canvas ref={ref} role="img" aria-label={label} className="rounded" style={style} width={image?.width} height={image?.height} />;
};

export interface BrushLibraryBrowserProps {
  /** The library's brushes (built-in presets and saved ones), as facets. */
  entries: readonly BrushLibraryEntry[];
  /** The active brush id. */
  activeId?: string;
  onSelect: (id: string) => void;
  /** Only brushes this host renders. */
  profile?: BrushHostProfile;
  /** A thumbnail for a brush (a test stroke): pixels, or an image URL. */
  thumbnail?: (id: string) => Pixels | string | null | undefined;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
  className?: string;
}

/** The brush library grouped by medium, then variety, with specialty paint (by kind) and tools as their own groups, and a filter (`brushLibraryGroups`). */
export const BrushLibraryBrowser: React.FC<BrushLibraryBrowserProps> = ({ entries, activeId, onSelect, profile, thumbnail, thumbnailWidth = 112, thumbnailHeight = 32, className }) => {
  const [text, setText] = useState('');
  const groups = useMemo(() => brushLibraryGroups(entries, { text, profile }), [entries, text, profile]);
  return (
    <div className={`flex flex-col gap-1 ${className ?? ''}`} data-testid="brush-library">
      <input type="search" value={text} placeholder="Find a brush" aria-label="Find a brush" onChange={(e) => setText(e.target.value)} className="rounded bg-slate-800 px-1.5 py-0.5" />
      <div className="flex flex-col gap-1.5" role="listbox" aria-label="Brushes">
        {groups.map((g) => (
          <div key={g.id} role="group" aria-label={g.title} data-group={g.id} className={`flex flex-col gap-0.5 ${g.id === 'specialty' ? 'mt-1 border-t border-indigo-500/40 pt-1' : ''}`}>
            <span className={`text-[10px] uppercase tracking-wide ${g.id === 'specialty' ? 'text-indigo-300' : 'text-slate-500'}`}>{g.title}</span>
            <div className="grid grid-cols-2 gap-1">
              {g.varieties.flatMap((v) => [
                // Specialty paint is listed by kind (Ferrofluid, UV-fluorescent…).
                ...(g.id === 'specialty' ? [<span key={`kind-${v.variety}`} className="col-span-2 text-[10px] text-slate-400">{v.title}</span>] : []),
                ...v.entries.map((e) => (
                  <button
                    key={e.brush.id}
                    type="button"
                    role="option"
                    aria-selected={activeId === e.brush.id}
                    title={[e.brush.name, v.title.toLowerCase() === e.brush.name.toLowerCase() ? '' : v.title, e.builtin ? '' : 'saved'].filter(Boolean).join(' · ')}
                    className={`flex flex-col items-start gap-0.5 rounded p-1 text-left ${activeId === e.brush.id ? 'bg-indigo-600/30 ring-1 ring-indigo-500' : 'bg-slate-900 hover:bg-slate-800'}`}
                    onClick={() => onSelect(e.brush.id)}
                  >
                    {thumbnail && <Thumbnail image={thumbnail(e.brush.id) ?? null} label={`${e.brush.name} thumbnail`} style={{ width: '100%', aspectRatio: `${thumbnailWidth} / ${thumbnailHeight}` }} />}
                    <span className="truncate text-[10px] text-slate-300">{e.brush.name}</span>
                  </button>
                )),
              ])}
            </div>
          </div>
        ))}
        {!groups.length && <span className="text-slate-500">No brush matches.</span>}
      </div>
    </div>
  );
};
