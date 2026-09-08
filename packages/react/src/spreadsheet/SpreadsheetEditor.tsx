import React, { useRef, useState, useMemo, useEffect, useCallback } from 'react';
import {
  indexToColName,
  type SpreadsheetColumn,
  type SpreadsheetRow,
  type CellData
} from '@pixerate/editor';
import { useSpreadsheetEditor } from './useSpreadsheetEditor';

export interface SpreadsheetEditorProps {
  state?: ReturnType<typeof useSpreadsheetEditor>;
  readOnly?: boolean;
  customCellRenderer?: (props: { row: SpreadsheetRow; col: SpreadsheetColumn; cell: CellData }) => React.ReactNode;
  onAddColumnClick?: () => void;
  onColumnHeaderClick?: (col: SpreadsheetColumn) => void;
  onColumnResize?: (colId: string, width: number) => void;
}

export const SpreadsheetEditor: React.FC<SpreadsheetEditorProps> = ({
  state: externalState,
  readOnly = false,
  customCellRenderer,
  onAddColumnClick,
  onColumnHeaderClick,
  onColumnResize
}) => {
  const defaultState = useSpreadsheetEditor();
  const state = externalState || defaultState;

  const [resizingColId, setResizingColId] = useState<string | null>(null);
  const [hoveredColId, setHoveredColId] = useState<string | null>(null);
  const [resizeStartX, setResizeStartX] = useState(0);
  const [resizeStartWidth, setResizeStartWidth] = useState(0);

  const activeRawValue = useMemo(() => {
    if (!state.activeCell) return '';
    const row = state.document.rows[state.activeCell.row];
    const col = state.document.columns[state.activeCell.col];
    if (!row || !col) return '';
    return state.getCell(row.id, col.id).raw;
  }, [state.activeCell, state.document]);

  const coordLabel = useMemo(() => {
    if (!state.activeCell) return '--';
    const colName = indexToColName(state.activeCell.col);
    return `${colName}${state.activeCell.row + 1}`;
  }, [state.activeCell]);

  const handleCellClick = useCallback((rIdx: number, cIdx: number, e: React.MouseEvent) => {
    if (state.editingCell && (state.editingCell.row !== rIdx || state.editingCell.col !== cIdx)) {
      state.commitEditing();
    }
    state.selectCell(rIdx, cIdx, e.shiftKey);
  }, [state]);

  const handleCellDblClick = useCallback((rIdx: number, cIdx: number) => {
    if (readOnly) return;
    const col = state.document.columns[cIdx];
    if (col?.readOnly) return;
    state.startEditing(rIdx, cIdx);
  }, [readOnly, state]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (state.editingCell) {
      if (e.key === 'Enter') {
        e.preventDefault();
        state.commitEditing();
        state.moveCursor('down');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        state.cancelEditing();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        state.commitEditing();
        state.moveCursor(e.shiftKey ? 'left' : 'right');
      }
      return;
    }

    if (!state.activeCell) return;

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.moveCursor('up', e.shiftKey);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      state.moveCursor('down', e.shiftKey);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      state.moveCursor('left', e.shiftKey);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      state.moveCursor('right', e.shiftKey);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      state.moveCursor(e.shiftKey ? 'left' : 'right');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const col = state.document.columns[state.activeCell.col];
      if (!readOnly && !col?.readOnly) {
        state.startEditing();
      }
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      if (readOnly) return;
      const row = state.document.rows[state.activeCell.row];
      const col = state.document.columns[state.activeCell.col];
      if (row && col && !col.readOnly) {
        e.preventDefault();
        state.setCellValue(row.id, col.id, '');
      }
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
      e.preventDefault();
      if (e.shiftKey) {
        state.redo();
      } else {
        state.undo();
      }
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
      e.preventDefault();
      const tsv = state.exportToTsv();
      navigator.clipboard?.writeText(tsv);
    } else if (!readOnly && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const col = state.document.columns[state.activeCell.col];
      if (!col?.readOnly) {
        state.startEditing(state.activeCell.row, state.activeCell.col, e.key);
      }
    }
  }, [readOnly, state]);
  useEffect(() => {
    if (!resizingColId) return;

    if (typeof document !== 'undefined') {
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }

    let rafId: number | null = null;
    let pendingWidth = resizeStartWidth;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - resizeStartX;
      pendingWidth = Math.max(30, resizeStartWidth + delta);

      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          state.setColumnWidth(resizingColId, pendingWidth);
        });
      }
    };

    const handleMouseUp = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      state.setColumnWidth(resizingColId, pendingWidth);
      const col = state.document.columns.find((c) => c.id === resizingColId);
      if (col && onColumnResize) {
        onColumnResize(col.id, col.width || pendingWidth);
      }
      setResizingColId(null);
      if (typeof document !== 'undefined') {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      if (typeof document !== 'undefined') {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizingColId, resizeStartX, resizeStartWidth, state, onColumnResize]);

  const isCellSelected = (rIdx: number, cIdx: number) => {
    if (!state.selectedRange) return false;
    const minR = Math.min(state.selectedRange.startRow, state.selectedRange.endRow);
    const maxR = Math.max(state.selectedRange.startRow, state.selectedRange.endRow);
    const minC = Math.min(state.selectedRange.startCol, state.selectedRange.endCol);
    const maxC = Math.max(state.selectedRange.startCol, state.selectedRange.endCol);
    return rIdx >= minR && rIdx <= maxR && cIdx >= minC && cIdx <= maxC;
  };

  const isActiveCell = (rIdx: number, cIdx: number) => {
    return state.activeCell?.row === rIdx && state.activeCell?.col === cIdx;
  };

  return (
    <div
      className="flex flex-col h-full w-full overflow-hidden border border-border bg-background select-none outline-none text-foreground font-sans text-xs"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      role="grid"
      aria-label="Spreadsheet"
    >
      {/* Formula Bar */}
      <div className="flex items-center gap-2 border-b border-border bg-muted/20 px-3 py-1.5 text-xs font-mono">
        <div className="flex h-6 min-w-[3rem] items-center justify-center rounded border border-border bg-background px-1.5 font-semibold text-foreground">
          {coordLabel}
        </div>
        <div className="flex items-center text-muted-foreground select-none">
          <span className="italic font-serif font-bold text-sm text-primary">fx</span>
        </div>
        <input
          type="text"
          className="flex-1 bg-transparent px-2 py-0.5 outline-none font-sans text-xs text-foreground placeholder:text-muted-foreground/60 focus:bg-background focus:ring-1 focus:ring-primary rounded"
          placeholder="Enter a value or formula (e.g. =SUM(A1:A5))"
          value={state.editingCell ? state.draftValue : activeRawValue}
          onChange={(e) => {
            if (state.activeCell) {
              state.setDraftValue(e.target.value);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (state.activeCell) {
                const row = state.document.rows[state.activeCell.row];
                const col = state.document.columns[state.activeCell.col];
                if (row && col) {
                  state.setCellValue(row.id, col.id, (e.target as HTMLInputElement).value);
                }
              }
            } else if (e.key === 'Escape') {
              e.preventDefault();
              state.cancelEditing();
            }
          }}
        />
      </div>

      {/* Main Grid */}
      <div className="relative flex-1 overflow-auto">
        <table className="border-collapse table-fixed w-max min-w-full">
          <thead>
            <tr className="h-7 bg-muted/60 sticky top-0 z-20 border-b border-border shadow-xs">
              <th className="w-12 min-w-[3rem] sticky left-0 z-30 bg-muted/90 border-r border-border text-center text-[10px] text-muted-foreground font-medium">
                #
              </th>
              {state.document.columns.map((col, cIdx) => (
                <th
                  key={col.id}
                  className={`relative border-r border-border px-2 text-left font-medium text-muted-foreground hover:bg-muted/90 transition-colors group overflow-hidden max-w-0 ${
                    onColumnHeaderClick ? 'cursor-pointer' : 'cursor-default'
                  }`}
                  style={{ width: col.width || 130, minWidth: col.width || 130, maxWidth: col.width || 130, overflow: 'hidden' }}
                  onClick={() => onColumnHeaderClick?.(col)}
                >
                  <div className="flex items-center justify-between gap-1 min-w-0 overflow-hidden truncate">
                    <span className="truncate font-semibold text-foreground text-xs min-w-0">{col.title}</span>
                    <span className="text-[10px] text-muted-foreground/70 font-mono font-normal shrink-0">({col.key})</span>
                  </div>
                  {/* Column Resize Handle */}
                  <div
                    className="col-resize-handle"
                    style={{ position: 'absolute', top: 0, bottom: 0, width: 12, right: -6, cursor: 'col-resize', zIndex: 20, display: 'flex', justifyContent: 'center', touchAction: 'none' }}
                    onMouseEnter={() => setHoveredColId(col.id)}
                    onMouseLeave={() => setHoveredColId((cur) => cur === col.id ? null : cur)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setResizingColId(col.id);
                      setResizeStartX(e.clientX);
                      setResizeStartWidth(col.width || 130);
                    }}
                    role="separator"
                    aria-orientation="vertical"
                  >
                    <div
                      className="col-resize-handle-line"
                      style={{
                        width: 2,
                        height: '100%',
                        pointerEvents: 'none',
                        transition: 'background-color 150ms ease',
                        backgroundColor: resizingColId === col.id ? 'var(--primary, #6366f1)' : hoveredColId === col.id ? 'color-mix(in srgb, var(--primary, #6366f1) 75%, transparent)' : 'transparent'
                      }}
                    />
                  </div>
                </th>
              ))}
              {onAddColumnClick && (
                <th
                  className="w-10 min-w-[2.5rem] px-1 text-center bg-muted/40 hover:bg-muted cursor-pointer transition-colors"
                  onClick={onAddColumnClick}
                  title="Add Column"
                >
                  <span className="text-xs font-bold text-muted-foreground">+</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {state.document.rows.map((row, rIdx) => (
              <tr key={row.id} className="border-b border-border hover:bg-muted/10 transition-colors" style={{ height: row.height || 32 }}>
                <td className="w-12 min-w-[3rem] sticky left-0 z-10 bg-muted/50 border-r border-border text-center text-[10px] text-muted-foreground font-mono select-none">
                  {rIdx + 1}
                </td>
                {state.document.columns.map((col, cIdx) => {
                  const cell = state.getCell(row.id, col.id);
                  const selected = isCellSelected(rIdx, cIdx);
                  const active = isActiveCell(rIdx, cIdx);
                  const isEditing = state.editingCell?.row === rIdx && state.editingCell?.col === cIdx;

                  return (
                    <td
                      key={col.id}
                      className={`relative border-r border-border px-2 py-1 truncate max-w-0 text-foreground transition-colors ${
                        selected ? 'bg-primary/10' : ''
                      } ${active ? 'ring-2 ring-primary ring-inset z-10' : ''}`}
                      style={{ maxWidth: 0, overflow: 'hidden' }}
                      onClick={(e) => handleCellClick(rIdx, cIdx, e)}
                      onDoubleClick={() => handleCellDblClick(rIdx, cIdx)}
                    >
                      {isEditing ? (
                        <input
                          type="text"
                          className="absolute inset-0 w-full h-full px-2 py-1 bg-background text-foreground outline-none font-sans text-xs border-2 border-primary z-20"
                          value={state.draftValue}
                          onChange={(e) => state.setDraftValue(e.target.value)}
                          onBlur={() => state.commitEditing()}
                          autoFocus
                        />
                      ) : customCellRenderer ? (
                        customCellRenderer({ row, col, cell })
                      ) : (
                        <span className={`truncate block max-w-full ${cell.error ? 'text-destructive font-semibold' : ''}`}>
                          {cell.error || (cell.value ?? '')}
                        </span>
                      )}
                    </td>
                  );
                })}
                {onAddColumnClick && <td className="w-10 min-w-[2.5rem] bg-muted/10 border-r border-border" />}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <style>{`
        .col-resize-handle:hover .col-resize-handle-line {
          background-color: var(--primary, #6366f1);
          opacity: 0.75;
        }
        .col-resize-handle.active .col-resize-handle-line {
          background-color: var(--primary, #6366f1);
          opacity: 1;
        }
        table.table-fixed th {
          overflow: hidden;
        }
        table.table-fixed td {
          max-width: 0;
          overflow: hidden;
        }
      `}</style>
    </div>
  );
};
