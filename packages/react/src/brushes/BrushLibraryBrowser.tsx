import React, { useMemo, useState } from 'react';
import { brushLibraryGroups, type BrushHostProfile, type BrushLibraryEntry } from '@pixerate/editor/brushes';
import { PixelCanvas } from './shared';

type Pixels = { width: number; height: number; data: Uint8ClampedArray };

export interface BrushLibraryBrowserProps {
  /** The library's brushes (built-in presets and saved ones), as facets. */
  entries: readonly BrushLibraryEntry[];
  /** The active brush id. */
  activeId?: string;
  onSelect: (id: string) => void;
  /** Only brushes this host renders. */
  profile?: BrushHostProfile;
  /** A thumbnail for a brush (a test stroke). */
  thumbnail?: (id: string) => Pixels | null;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
  className?: string;
}

/** The brush library grouped by medium, then variety, with tools as their own group, and a filter (`brushLibraryGroups`). */
export const BrushLibraryBrowser: React.FC<BrushLibraryBrowserProps> = ({ entries, activeId, onSelect, profile, thumbnail, thumbnailWidth = 112, thumbnailHeight = 32, className }) => {
  const [text, setText] = useState('');
  const groups = useMemo(() => brushLibraryGroups(entries, { text, profile }), [entries, text, profile]);
  return (
    <div className={`flex flex-col gap-1 ${className ?? ''}`} data-testid="brush-library">
      <input type="search" value={text} placeholder="Find a brush" aria-label="Find a brush" onChange={(e) => setText(e.target.value)} className="rounded bg-slate-800 px-1.5 py-0.5" />
      <div className="flex flex-col gap-1.5" role="listbox" aria-label="Brushes">
        {groups.map((g) => (
          <div key={g.id} role="group" aria-label={g.title} className="flex flex-col gap-0.5">
            <span className="text-[10px] uppercase tracking-wide text-slate-500">{g.title}</span>
            <div className="grid grid-cols-2 gap-1">
              {g.varieties.flatMap((v) =>
                v.entries.map((e) => (
                  <button
                    key={e.brush.id}
                    type="button"
                    role="option"
                    aria-selected={activeId === e.brush.id}
                    title={[e.brush.name, v.title.toLowerCase() === e.brush.name.toLowerCase() ? '' : v.title, e.builtin ? '' : 'saved'].filter(Boolean).join(' · ')}
                    className={`flex flex-col items-start gap-0.5 rounded p-1 text-left ${activeId === e.brush.id ? 'bg-indigo-600/30 ring-1 ring-indigo-500' : 'bg-slate-900 hover:bg-slate-800'}`}
                    onClick={() => onSelect(e.brush.id)}
                  >
                    {thumbnail && <PixelCanvas pixels={thumbnail(e.brush.id)} label={`${e.brush.name} thumbnail`} className="rounded" style={{ width: '100%', aspectRatio: `${thumbnailWidth} / ${thumbnailHeight}` }} />}
                    <span className="truncate text-[10px] text-slate-300">{e.brush.name}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        ))}
        {!groups.length && <span className="text-slate-500">No brush matches.</span>}
      </div>
    </div>
  );
};
