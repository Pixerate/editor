import React from 'react';
import { isVectorFrame, vectorMasterPages, vectorPages, type VectorEditorController } from '@pixerate/editor/vector';
import { useVectorEditorState } from './useVectorEditor';

const buttonClass =
  'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 aria-[current=true]:bg-primary aria-[current=true]:text-primary-foreground';
const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';

export interface VectorPagesPanelProps {
  controller: VectorEditorController;
  className?: string;
}

/**
 * Pages: the document's pages (top-level frames) to go to, adding pages and master pages, and the
 * master page the selected page uses. Adding and applying are one undo step each.
 */
export function VectorPagesPanel({ controller, className }: VectorPagesPanelProps) {
  const state = useVectorEditorState(controller);
  const pages = vectorPages(state.document);
  const masters = vectorMasterPages(state.document);
  const selected = state.selection.map((id) => state.document.nodes.find((n) => n.id === id)).find((n) => isVectorFrame(n));
  const page = selected && !selected.frame.master ? selected : null;
  return (
    <div className={`space-y-2 ${className ?? ''}`} data-vector-pages-panel="" aria-label="Pages">
      <div className="flex flex-wrap items-center gap-1">
        <span className="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Pages</span>
        {pages.map((p, i) => (
          <button key={p.id} type="button" className={buttonClass} aria-current={state.selection.includes(p.id)} data-vector-page={p.id} title={`Go to ${p.name ?? `page ${i + 1}`}`} onClick={() => controller.goToPage(p.id)}>
            {i + 1}
          </button>
        ))}
        {masters.map((m) => (
          <button key={m.id} type="button" className={buttonClass} aria-current={state.selection.includes(m.id)} data-vector-master-page={m.id} title={`Go to master page ${m.name ?? ''}`} onClick={() => controller.goToPage(m.id)}>
            {m.name ?? 'Master'}
          </button>
        ))}
        <button type="button" className={buttonClass} data-vector-pages-action="add" title="Add a page after the last" onClick={() => controller.addPage()}>
          + Page
        </button>
        <button type="button" className={buttonClass} data-vector-pages-action="master" title="Add a master page used by every page (headers, footers, {page} numbers)" onClick={() => controller.addMasterPage({ assignTo: 'all' })}>
          + Master
        </button>
      </div>
      {page && masters.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="w-16" />
          <select aria-label="Master page" className={selectClass} value={page.frame.masterId ?? ''} onChange={(e) => controller.setPageMaster(e.target.value || null, { ids: [page.id] })}>
            <option value="">No master</option>
            {masters.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name ?? 'Master'}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
