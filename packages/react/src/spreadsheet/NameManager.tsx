import React, { useMemo, useState } from 'react';
import { getNameManagerRows, parseFormula, type SpreadsheetNameRow } from '@pixerate/editor/spreadsheet';
import type { useSpreadsheetEditor } from './useSpreadsheetEditor';

export interface NameManagerProps {
  state: ReturnType<typeof useSpreadsheetEditor>;
  readOnly?: boolean;
  onClose?: () => void;
  className?: string;
}

interface Draft {
  /** The name being edited (null for a new one). */
  original: { name: string; sheetId?: string } | null;
  name: string;
  refersTo: string;
  /** Sheet id, or '' for workbook scope. */
  scope: string;
  comment: string;
}

const EMPTY_DRAFT: Draft = { original: null, name: '', refersTo: '=', scope: '', comment: '' };

/**
 * A simple Name Manager: lists defined names (name, current value, formula,
 * scope) and adds, edits, renames and deletes them. Renaming a name rewrites
 * the formulas that use it; deleting one leaves them showing `#NAME?`.
 */
export const NameManager: React.FC<NameManagerProps> = ({ state, readOnly = false, onClose, className = '' }) => {
  const { controller, sheets } = state;
  const rows = useMemo(
    () => getNameManagerRows(controller),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [controller, state.document, state.names],
  );
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);

  const edit = (row: SpreadsheetNameRow) => {
    setError(null);
    setDraft({
      original: { name: row.name, sheetId: row.sheetId },
      name: row.name,
      refersTo: row.refersTo,
      scope: row.sheetId ?? '',
      comment: row.comment ?? '',
    });
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const scope = draft.scope ? { sheet: draft.scope } : {};
    try {
      // Check before changing anything, so a failed edit keeps the old name.
      const invalid = controller.validateDefinedName(draft.name.trim());
      if (invalid) throw new Error(invalid);
      try {
        parseFormula(draft.refersTo.trim().startsWith('=') ? draft.refersTo.trim() : `=${draft.refersTo.trim()}`);
      } catch (err: any) {
        throw new Error(`There's a problem with this formula: ${err?.message ?? draft.refersTo}`);
      }
      const original = draft.original;
      if (original) {
        const originalScope = original.sheetId ? { sheet: original.sheetId } : {};
        if ((original.sheetId ?? '') !== draft.scope) {
          state.deleteName(original.name, originalScope);
        } else if (original.name !== draft.name) {
          state.renameName(original.name, draft.name.trim(), originalScope);
        }
      }
      state.defineName(draft.name.trim(), draft.refersTo, { ...scope, comment: draft.comment || undefined });
      setDraft(EMPTY_DRAFT);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    }
  };

  return (
    <section aria-label="Name Manager" className={`flex flex-col gap-2 text-xs ${className}`} data-name-manager="">
      <div className="flex items-center justify-between">
        <h3 className="m-0 text-sm font-semibold">Name Manager</h3>
        {onClose && (
          <button type="button" aria-label="Close Name Manager" className="rounded px-2 hover:bg-muted" onClick={onClose}>
            ×
          </button>
        )}
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="px-1 font-medium">Name</th>
            <th className="px-1 font-medium">Value</th>
            <th className="px-1 font-medium">Refers to</th>
            <th className="px-1 font-medium">Scope</th>
            {!readOnly && <th className="px-1" />}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="px-1 py-2 text-muted-foreground">
                No names yet.
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr key={`${row.sheetId ?? ''}!${row.name}`} data-name={row.name} className="border-t border-border" title={row.comment}>
              <td className="px-1 py-0.5 font-mono font-semibold">{row.name}</td>
              <td className="px-1 py-0.5">{row.value}</td>
              <td className="px-1 py-0.5 font-mono">{row.refersTo}</td>
              <td className="px-1 py-0.5">{row.scopeLabel}</td>
              {!readOnly && (
                <td className="whitespace-nowrap px-1 py-0.5 text-right">
                  <button type="button" aria-label={`Edit ${row.name}`} className="rounded px-1 hover:bg-muted" onClick={() => edit(row)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${row.name}`}
                    className="rounded px-1 text-destructive hover:bg-muted"
                    onClick={() => {
                      state.deleteName(row.name, row.sheetId ? { sheet: row.sheetId } : {});
                      if (draft.original?.name === row.name && (draft.original.sheetId ?? '') === (row.sheetId ?? '')) setDraft(EMPTY_DRAFT);
                    }}
                  >
                    Delete
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly && (
        <form className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1" onSubmit={save} aria-label={draft.original ? `Edit name ${draft.original.name}` : 'New name'}>
          <label htmlFor="pixerate-name-manager-name">Name</label>
          <input
            id="pixerate-name-manager-name"
            className="rounded border border-border bg-background px-1 py-0.5"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <label htmlFor="pixerate-name-manager-refers">Refers to</label>
          <input
            id="pixerate-name-manager-refers"
            className="rounded border border-border bg-background px-1 py-0.5 font-mono"
            value={draft.refersTo}
            onChange={(e) => setDraft({ ...draft, refersTo: e.target.value })}
          />
          <label htmlFor="pixerate-name-manager-scope">Scope</label>
          <select
            id="pixerate-name-manager-scope"
            className="rounded border border-border bg-background px-1 py-0.5"
            value={draft.scope}
            onChange={(e) => setDraft({ ...draft, scope: e.target.value })}
          >
            <option value="">Workbook</option>
            {sheets.map((sheet) => (
              <option key={sheet.id} value={sheet.id}>
                {sheet.name}
              </option>
            ))}
          </select>
          <label htmlFor="pixerate-name-manager-comment">Comment</label>
          <input
            id="pixerate-name-manager-comment"
            className="rounded border border-border bg-background px-1 py-0.5"
            value={draft.comment}
            onChange={(e) => setDraft({ ...draft, comment: e.target.value })}
          />
          <div className="col-span-2 flex gap-2">
            <button type="submit" className="rounded bg-primary px-2 py-0.5 text-primary-foreground">
              {draft.original ? 'Save' : 'Add name'}
            </button>
            {draft.original && (
              <button
                type="button"
                className="rounded px-2 py-0.5 hover:bg-muted"
                onClick={() => {
                  setDraft(EMPTY_DRAFT);
                  setError(null);
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
      {error && (
        <div role="alert" className="text-destructive">
          {error}
        </div>
      )}
    </section>
  );
};
