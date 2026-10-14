/**
 * The spreadsheet's table context menu, defined once so the React and Svelte
 * editors show the same actions. Frameworks render the items and call
 * `run()`; the controller's change listeners refresh their state.
 */
import type { SpreadsheetController } from './controller';
import type { CellRange } from './types';
import type { CellPosition } from './formula';
import { formatCellDisplay, indexToColName } from './formula';
import { isSingleCellRange, normalizeRange, rangeContains, rangesIntersect } from './table';
import { NUMBER_FORMAT_PRESETS, isGeneralNumberFormat } from './numfmt/presets';
import { createConditionalFormatRule, type ConditionalFormatPresetInput } from './conditional-format/presets';

export interface SpreadsheetMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  /** Draw a divider before this item. */
  separatorBefore?: boolean;
  /** The item is the current choice of its group (e.g. the cell's number format). */
  checked?: boolean;
  /**
   * Ask for text before running (e.g. a custom number format code): the
   * editor prompts with `label` and `defaultValue`, then calls `run(text)`;
   * cancelling skips `run`.
   */
  input?: { label: string; defaultValue?: string };
  /** Ask the user to confirm before running (e.g. deleting a sheet); the message to show. */
  confirm?: string;
  /**
   * Opens one of the editor's panels instead of running an action: the
   * editors open it (`run` does nothing).
   */
  panel?: SpreadsheetPanelId;
  run: (input?: string) => void;
}

/** Panels the spreadsheet editors can open from the context menu. */
export type SpreadsheetPanelId = 'conditionalFormatting' | 'dataValidation';

/**
 * Runs a menu item the way the editors do: an item with `confirm` first asks
 * for confirmation with `confirm` (default `window.confirm`), an item with
 * `input` asks for text with `ask` (default `window.prompt`); either is
 * skipped when cancelled. Returns whether `run` was called.
 */
export function runSpreadsheetMenuItem(
  item: SpreadsheetMenuItem,
  ask?: (label: string, defaultValue: string) => string | null | undefined,
  confirm?: (message: string) => boolean
): boolean {
  if (item.confirm) {
    const confirmed = confirm
      ? confirm(item.confirm)
      : typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(item.confirm)
        : true;
    if (!confirmed) return false;
  }
  if (!item.input) {
    item.run();
    return true;
  }
  const prompt =
    ask ?? ((label: string, value: string) => (typeof window !== 'undefined' && window.prompt ? window.prompt(label, value) : null));
  const text = prompt(item.input.label, item.input.defaultValue ?? '');
  if (text === null || text === undefined) return false;
  item.run(text);
  return true;
}

/**
 * Where to place a `position: fixed` menu opened at `point` so it stays inside
 * the viewport: it flips to the left of / above the pointer when it would
 * overflow the right / bottom edge, or, when the flipped menu would not fit
 * either, slides back just enough to fit. It is kept at least `margin` px from
 * every edge (a menu taller than the viewport is pinned to the top and should
 * scroll, e.g. with `max-height: calc(100vh - 2 * margin)`).
 */
export function clampMenuPosition(
  point: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 4
): { x: number; y: number } {
  const place = (start: number, length: number, limit: number) => {
    if (start + length <= limit - margin) return Math.max(margin, start);
    const flipped = start - length;
    // Flip when that fits; otherwise slide it back just enough to fit.
    return Math.max(margin, flipped >= margin ? flipped : limit - margin - length);
  };
  return {
    x: place(point.x, size.width, viewport.width),
    y: place(point.y, size.height, viewport.height)
  };
}

const quote = (value: unknown) => {
  const text = String(value ?? '');
  return text.length > 24 ? `"${text.slice(0, 23)}…"` : `"${text}"`;
};

/**
 * Menu items for a right-click on `cell`. When the cell is inside the
 * selection, range actions (hide, merge, transpose) apply to the selection;
 * otherwise to the clicked cell.
 */
export function getSpreadsheetMenuItems(controller: SpreadsheetController, cell: CellPosition): SpreadsheetMenuItem[] {
  const doc = controller.document;
  const column = doc.columns[cell.col];
  const row = doc.rows[cell.row];
  if (!column || !row) return [];

  const selection: CellRange =
    controller.selectedRange && rangeContains(controller.selectedRange, cell.row, cell.col)
      ? normalizeRange(controller.selectedRange)
      : { startRow: cell.row, startCol: cell.col, endRow: cell.row, endCol: cell.col };
  const colName = indexToColName(cell.col);
  const cellData = controller.getCell(row.id, column.id);
  const value = cellData.value;
  const table = doc.table ?? {};
  const filter = controller.getFilterState();
  const grouping = table.grouping;
  const rows = Array.from({ length: selection.endRow - selection.startRow + 1 }, (_, i) => selection.startRow + i);
  const cols = Array.from({ length: selection.endCol - selection.startCol + 1 }, (_, i) => selection.startCol + i);
  const anyHidden = doc.rows.some((r) => r.hidden) || doc.columns.some((c) => c.hidden);
  const hasMerge = controller.getMerges().some((m) => rangesIntersect(m, selection));
  const sortRange = isSingleCellRange(selection) ? null : selection;

  const items: SpreadsheetMenuItem[] = [
    {
      id: 'sort-asc',
      label: `Sort ascending by column ${colName}`,
      run: () => controller.sortRows([{ colId: column.id, direction: 'asc' }], { range: sortRange }),
    },
    {
      id: 'sort-desc',
      label: `Sort descending by column ${colName}`,
      run: () => controller.sortRows([{ colId: column.id, direction: 'desc' }], { range: sortRange }),
    },
    {
      id: 'filter-equals',
      label: `Show only rows where ${colName} = ${quote(formatCellDisplay(cellData))}`,
      separatorBefore: true,
      run: () => controller.addFilterRule({ colId: column.id, operator: 'equals', value: String(value ?? '') }),
    },
    {
      id: 'filter-toggle',
      label: filter.enabled ? 'Turn filters off' : 'Turn filters on',
      disabled: filter.rules.length === 0,
      run: () => controller.toggleFilters(),
    },
    {
      id: 'filter-clear',
      label: 'Clear filters',
      disabled: filter.rules.length === 0,
      run: () => controller.clearFilters(),
    },
    {
      id: 'freeze-rows',
      label: `Freeze rows 1–${cell.row + 1}`,
      separatorBefore: true,
      run: () => controller.setFrozenRowCount(cell.row + 1),
    },
    {
      id: 'freeze-columns',
      label: `Freeze columns A–${colName}`,
      run: () => controller.setFrozenColumnCount(cell.col + 1),
    },
    {
      id: 'unfreeze',
      label: 'Unfreeze rows and columns',
      disabled: !table.frozenRowCount && !table.frozenColumnCount,
      run: () => {
        controller.setFrozenRowCount(0);
        controller.setFrozenColumnCount(0);
      },
    },
    {
      id: 'header-rows',
      label: `Use rows 1–${cell.row + 1} as header rows`,
      run: () => controller.setHeaderRowCount(cell.row + 1),
    },
    {
      id: 'footer-rows',
      label: `Use rows ${cell.row + 1}–${doc.rows.length} as footer rows`,
      run: () => controller.setFooterRowCount(doc.rows.length - cell.row),
    },
    {
      id: 'hide-rows',
      label: rows.length > 1 ? `Hide ${rows.length} rows` : `Hide row ${cell.row + 1}`,
      separatorBefore: true,
      run: () => controller.hideRows(rows),
    },
    {
      id: 'hide-columns',
      label: cols.length > 1 ? `Hide ${cols.length} columns` : `Hide column ${colName}`,
      run: () => controller.hideColumns(cols),
    },
    {
      id: 'unhide-all',
      label: 'Unhide all rows and columns',
      disabled: !anyHidden,
      run: () => controller.unhideAll(),
    },
    {
      id: 'merge',
      label: 'Merge cells',
      separatorBefore: true,
      disabled: isSingleCellRange(selection),
      run: () => {
        controller.mergeCells(selection);
      },
    },
    {
      id: 'unmerge',
      label: 'Unmerge cells',
      disabled: !hasMerge,
      run: () => {
        controller.unmergeCells(selection);
      },
    },
    {
      id: 'transpose',
      label: 'Transpose',
      disabled: isSingleCellRange(selection),
      run: () => {
        controller.transposeRange(selection);
      },
    },
  ];

  // Format cells: number format presets and a custom code, for the selection.
  const currentFormat = cellData.numberFormat;
  const presetMatch = NUMBER_FORMAT_PRESETS.find((p) =>
    p.id === 'general' ? isGeneralNumberFormat(currentFormat) : p.code === currentFormat
  );
  NUMBER_FORMAT_PRESETS.forEach((preset, i) => {
    items.push({
      id: `number-format-${preset.id}`,
      label: `Format cells: ${preset.label}`,
      separatorBefore: i === 0,
      checked: presetMatch === preset,
      run: () => {
        controller.setCellNumberFormat(selection, preset.code);
      },
    });
  });
  items.push({
    id: 'number-format-custom',
    label: 'Format cells: Custom…',
    checked: !presetMatch,
    input: { label: 'Number format code, e.g. #,##0.00;[Red](#,##0.00)', defaultValue: currentFormat ?? 'General' },
    run: (code) => {
      if (code === undefined) return;
      controller.setCellNumberFormat(selection, code.trim() === '' ? null : code);
    },
  });

  if (grouping) {
    items.push(
      {
        id: 'ungroup',
        label: 'Remove categories',
        separatorBefore: true,
        run: () => controller.ungroupRows(),
      },
      ...(['sum', 'count', 'average'] as const).map((aggregate) => ({
        id: `summary-${aggregate}`,
        label: `Summarize column ${colName}: ${aggregate.toUpperCase()}`,
        run: () => controller.setGroupSummary(column.id, aggregate),
      })),
    );
  } else {
    items.push({
      id: 'group-by',
      label: `Categorize by column ${colName}`,
      separatorBefore: true,
      run: () => controller.groupRowsBy(column.id),
    });
  }

  items.push(...getRuleMenuItems(controller, selection));

  return items;
}

/** Conditional formatting and data validation items for the selection. */
function getRuleMenuItems(controller: SpreadsheetController, selection: CellRange): SpreadsheetMenuItem[] {
  const ranges = [selection];
  const hasFormats = controller.getConditionalFormats().some((rule) => rule.ranges.some((r) => rangesIntersect(r, selection)));
  const hasValidation = controller.getDataValidations().some((rule) => rule.ranges.some((r) => rangesIntersect(r, selection)));
  const add = (input: Omit<ConditionalFormatPresetInput, 'ranges'>) => {
    controller.addConditionalFormat(createConditionalFormatRule({ ...input, ranges }));
  };
  const circles = controller.getInvalidDataCircles();
  return [
    {
      id: 'conditional-format-manage',
      label: 'Conditional formatting…',
      separatorBefore: true,
      panel: 'conditionalFormatting',
      run: () => {},
    },
    {
      id: 'conditional-format-greater-than',
      label: 'Conditional formatting: Highlight cells greater than…',
      input: { label: 'Highlight cells greater than', defaultValue: '0' },
      run: (value) => {
        if (value !== undefined && value.trim() !== '') add({ kind: 'greaterThan', value: value.trim() });
      },
    },
    {
      id: 'conditional-format-duplicates',
      label: 'Conditional formatting: Highlight duplicate values',
      run: () => add({ kind: 'duplicate' }),
    },
    {
      id: 'conditional-format-color-scale',
      label: 'Conditional formatting: Color scale',
      run: () => add({ kind: 'colorScale3' }),
    },
    {
      id: 'conditional-format-data-bars',
      label: 'Conditional formatting: Data bars',
      run: () => add({ kind: 'dataBar' }),
    },
    {
      id: 'conditional-format-icon-set',
      label: 'Conditional formatting: Icon set',
      run: () => add({ kind: 'iconSet', iconSet: '3Arrows' }),
    },
    {
      id: 'conditional-format-clear',
      label: 'Clear conditional formatting from selection',
      disabled: !hasFormats,
      run: () => controller.clearConditionalFormats(selection),
    },
    {
      id: 'data-validation-manage',
      label: 'Data validation…',
      separatorBefore: true,
      panel: 'dataValidation',
      run: () => {},
    },
    {
      id: 'data-validation-list',
      label: 'Data validation: List of values…',
      input: { label: 'Allowed values, separated by commas (or a range such as =$H$1:$H$5)', defaultValue: '' },
      run: (value) => {
        if (value === undefined || value.trim() === '') return;
        controller.addDataValidation({ ranges, type: 'list', formula1: value.trim() });
      },
    },
    {
      id: 'data-validation-clear',
      label: 'Clear data validation from selection',
      disabled: !hasValidation,
      run: () => controller.clearDataValidation(selection),
    },
    {
      id: 'data-validation-circles',
      label: circles ? 'Clear validation circles' : 'Circle invalid data',
      disabled: !circles && controller.getDataValidations().length === 0,
      run: () => controller.setInvalidDataCircles(!circles),
    },
  ];
}
