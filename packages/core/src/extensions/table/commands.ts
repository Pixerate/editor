import type { Editor } from "@tiptap/core";
import type { CommandParamsSchema, CommandSpec } from "../../commands/registry";
import {
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  TABLE_ACTIONS,
  getTableActionState,
  getTableState,
  runTableAction,
  type TableAction,
  type TableActionParams,
} from "./actions";

export interface TableCommandOptions {
  /** Id prefix (default `table.`). */
  prefix?: string;
  group?: string;
  scope?: string;
  /** Focus the editor when a command runs (default `true`, for menus and the palette). */
  focus?: boolean;
}

const PARAMS: Partial<Record<TableAction, CommandParamsSchema>> = {
  insertTable: {
    type: "object",
    properties: {
      rows: { type: "integer", minimum: 1, maximum: MAX_TABLE_ROWS, description: "Rows (default 3)." },
      cols: { type: "integer", minimum: 1, maximum: MAX_TABLE_COLUMNS, description: "Columns (default 3)." },
      withHeaderRow: { type: "boolean", description: "Make the first row a header row (default true)." },
    },
    additionalProperties: false,
  },
  setCellAlignment: {
    type: "object",
    properties: {
      align: {
        type: ["string", "null"],
        enum: ["left", "center", "right", "justify", null],
        description: "Horizontal alignment; null clears it.",
      },
    },
    required: ["align"],
    additionalProperties: false,
  },
  setCellBackground: {
    type: "object",
    properties: {
      color: { type: ["string", "null"], description: "CSS color (e.g. #fde68a); null clears it." },
    },
    required: ["color"],
    additionalProperties: false,
  },
};

/**
 * Table commands for the command registry (`@pixerate/editor/commands`):
 * `table.insertTable` (`{ rows, cols, withHeaderRow }`), row and column
 * insertion/deletion, `table.deleteTable`, `table.mergeCells` /
 * `table.splitCell`, header toggles, cell navigation and
 * `table.setCellAlignment` / `table.setCellBackground`. Disabled commands
 * explain why ("Place the cursor in a table first."). Requires the table
 * extensions (`createRichTextPreset`'s default `table` option).
 */
export function createTableCommands(editor: Editor, options: TableCommandOptions = {}): CommandSpec[] {
  const prefix = options.prefix ?? "table.";
  const group = options.group ?? "Table";
  const scope = options.scope ? { scope: options.scope } : {};
  const focus = options.focus ?? true;

  return TABLE_ACTIONS.map(({ action, label, description, keywords }): CommandSpec => {
    const params = PARAMS[action];
    return {
      id: `${prefix}${action}`,
      label,
      group,
      keywords: [...keywords],
      description,
      ...(params ? { params } : {}),
      ...scope,
      enabled: (_ctx: unknown, p: TableActionParams | undefined) => getTableActionState(editor, action, p ?? {}),
      run: (_ctx: unknown, p: TableActionParams | undefined) => {
        if (!runTableAction(editor, action, p ?? {}, { focus })) {
          const reason = getTableActionState(editor, action, p ?? {});
          throw new Error(reason === true ? `${label} did not change the document.` : reason);
        }
        const state = getTableState(editor);
        return {
          done: true,
          table: state.inTable ? { rows: state.rows, columns: state.columns, row: state.row, column: state.column } : null,
        };
      },
    };
  });
}
