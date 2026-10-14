import type { SpreadsheetController } from './controller';

/**
 * Controller methods the React and Svelte spreadsheet bindings expose as-is,
 * so both frameworks offer the same table operations. They need no extra
 * state syncing: the controller reports changes through `onDocumentChange`
 * and `onSelectionChange`.
 */
export const SPREADSHEET_TABLE_ACTIONS = [
  'sortRows',
  'getFilterState',
  'setFilterRules',
  'addFilterRule',
  'updateFilterRule',
  'removeFilterRule',
  'clearFilters',
  'setFiltersEnabled',
  'toggleFilters',
  'setHeaderRowCount',
  'setFooterRowCount',
  'setHeaderColumnCount',
  'setFrozenRowCount',
  'setFrozenColumnCount',
  'hideRows',
  'unhideRows',
  'hideColumns',
  'unhideColumns',
  'unhideAll',
  'getMerges',
  'getMergeAt',
  'mergeCells',
  'unmergeCells',
  'autofill',
  'groupRowsBy',
  'ungroupRows',
  'setGroupSummary',
  'setGroupCollapsed',
  'toggleGroupCollapsed',
  'getGroups',
  'transposeRange',
  'exportToCsv',
  'importFromCsv',
  'copyToClipboardData',
  'pasteClipboardData'
] as const;

export type SpreadsheetTableActionName = (typeof SPREADSHEET_TABLE_ACTIONS)[number];
export type SpreadsheetTableActions = Pick<SpreadsheetController, SpreadsheetTableActionName>;

/** The table operations of `controller`, bound so they can be passed around. */
export function bindSpreadsheetTableActions(controller: SpreadsheetController): SpreadsheetTableActions {
  const actions = {} as Record<string, unknown>;
  for (const name of SPREADSHEET_TABLE_ACTIONS) {
    actions[name] = (controller[name] as (...args: unknown[]) => unknown).bind(controller);
  }
  return actions as SpreadsheetTableActions;
}
