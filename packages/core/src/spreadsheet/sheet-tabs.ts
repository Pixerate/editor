/**
 * Sheet-tab and Name Manager behaviour shared by the React and Svelte
 * bindings: the tab context menu, drag-to-reorder targets and the rows a
 * Name Manager panel lists.
 */
import type { SpreadsheetController } from './controller';
import type { SpreadsheetMenuItem } from './menu';
import { formatCellDisplay } from './formula/format';
import { isFormulaError } from './formula';

/**
 * Context-menu items for a sheet tab: insert, rename (asks for the name),
 * duplicate, move left/right and delete (asks to confirm; disabled for the
 * last sheet). Run them with `runSpreadsheetMenuItem`. A rename to an
 * invalid name throws; pass `onError` to report it instead.
 */
export function getSheetTabMenuItems(
  controller: SpreadsheetController,
  sheetId: string,
  options: { onError?: (message: string) => void } = {},
): SpreadsheetMenuItem[] {
  const sheets = controller.getSheets();
  const sheet = sheets.find((s) => s.id === sheetId);
  if (!sheet) return [];
  const guard = (fn: () => void) => () => {
    try {
      fn();
    } catch (err: any) {
      if (!options.onError) throw err;
      options.onError(err?.message ?? String(err));
    }
  };
  return [
    {
      id: 'sheet-insert',
      label: 'Insert sheet',
      run: guard(() => {
        controller.addSheet({ index: sheet.index + 1 });
      }),
    },
    {
      id: 'sheet-rename',
      label: 'Rename…',
      input: { label: 'Sheet name', defaultValue: sheet.name },
      run: (name) =>
        guard(() => {
          const next = (name ?? '').trim();
          if (next && next !== sheet.name) controller.renameSheet(sheetId, next);
        })(),
    },
    {
      id: 'sheet-duplicate',
      label: 'Duplicate',
      run: guard(() => {
        controller.duplicateSheet(sheetId);
      }),
    },
    {
      id: 'sheet-move-left',
      label: 'Move left',
      disabled: sheet.index === 0,
      separatorBefore: true,
      run: () => {
        controller.moveSheet(sheetId, sheet.index - 1);
      },
    },
    {
      id: 'sheet-move-right',
      label: 'Move right',
      disabled: sheet.index === sheets.length - 1,
      run: () => {
        controller.moveSheet(sheetId, sheet.index + 1);
      },
    },
    {
      id: 'sheet-delete',
      label: 'Delete',
      disabled: sheets.length <= 1,
      separatorBefore: true,
      confirm: `Delete the sheet "${sheet.name}"? Formulas that refer to it will show #REF!.`,
      run: () => {
        controller.deleteSheet(sheetId);
      },
    },
  ];
}

/**
 * The tab index a dragged tab should move to when dropped on the tab at
 * `targetIndex`: dropping on the left half of a tab places it before that
 * tab, on the right half after it.
 */
export function sheetDropIndex(fromIndex: number, targetIndex: number, dropAfter: boolean): number {
  let to = dropAfter ? targetIndex + 1 : targetIndex;
  if (fromIndex < to) to--;
  return to;
}

/** A row of a Name Manager panel. */
export interface SpreadsheetNameRow {
  name: string;
  refersTo: string;
  /** `Workbook` or the sheet's name. */
  scopeLabel: string;
  /** Sheet id for a sheet-scoped name. */
  sheetId?: string;
  /** The name's current value, as displayed (`#REF!`, `[LAMBDA]`, `{3×1 array}`). */
  value: string;
  comment?: string;
  isLambda: boolean;
}

/** Every defined name with its scope and current value, sorted by name then scope. */
export function getNameManagerRows(controller: SpreadsheetController): SpreadsheetNameRow[] {
  return controller
    .getNames()
    .map((n) => {
      let value: string;
      if (n.isLambda) {
        value = '[LAMBDA]';
      } else {
        const result = controller.evaluateFormula(`=${n.name}`, n.sheetId ? { sheet: n.sheetId } : {});
        value = result.array
          ? `{${result.array.rows}×${result.array.cols} array}`
          : isFormulaError(result.value)
            ? String(result.value)
            : formatCellDisplay({ value: result.value });
      }
      return {
        name: n.name,
        refersTo: n.refersTo,
        scopeLabel: n.sheetName ?? 'Workbook',
        ...(n.sheetId ? { sheetId: n.sheetId } : {}),
        value,
        ...(n.comment ? { comment: n.comment } : {}),
        isLambda: n.isLambda,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.scopeLabel.localeCompare(b.scopeLabel));
}
