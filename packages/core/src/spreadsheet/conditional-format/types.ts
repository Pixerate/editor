/**
 * Conditional formatting rule model.
 *
 * Portions ported from gridcraft/crates/model/src/features.rs (MIT OR
 * Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
 */
import type { CellRange } from '../types';

/** Comparison of a cell value with one value (or two for `between` / `notBetween`). */
export type ConditionalFormatOperator =
  | 'between'
  | 'notBetween'
  | 'equal'
  | 'notEqual'
  | 'greaterThan'
  | 'lessThan'
  | 'greaterThanOrEqual'
  | 'lessThanOrEqual';

/**
 * The look a matching rule adds to a cell. Colours are CSS colours, ideally
 * `#rrggbb`. Only the parts that are set apply, so several rules can combine
 * (a fill from one, bold from another).
 */
export interface ConditionalFormatStyle {
  fill?: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

/**
 * An anchor of a colour scale, data bar or icon set: the lowest / highest
 * number in the range, a fixed number, a percent of the min..max span, a
 * percentile of the values, or a formula (written for the range's top-left
 * cell, like formula rules).
 */
export type ConditionalFormatValue =
  | { type: 'min' }
  | { type: 'max' }
  | { type: 'number'; value: number }
  | { type: 'percent'; value: number }
  | { type: 'percentile'; value: number }
  | { type: 'formula'; formula: string };

/** `dates occurring` periods (weeks start on Sunday, as in Excel's US locale). */
export type ConditionalFormatTimePeriod =
  | 'yesterday'
  | 'today'
  | 'tomorrow'
  | 'last7Days'
  | 'lastWeek'
  | 'thisWeek'
  | 'nextWeek'
  | 'lastMonth'
  | 'thisMonth'
  | 'nextMonth';

/** Built-in icon sets (the number of icons is the leading digit). */
export type ConditionalFormatIconSet =
  | '3Arrows'
  | '3ArrowsGray'
  | '3TrafficLights1'
  | '3Flags'
  | '3Symbols'
  | '3Stars'
  | '4Arrows'
  | '4Rating'
  | '4TrafficLights'
  | '5Arrows'
  | '5Rating'
  | '5Quarters';

/** The condition of a rule: what it checks and the look it gives. */
export type ConditionalFormatCondition =
  | {
      /**
       * Cell value compared with `value` (and `value2` for between). A value
       * starting with `=` is a formula, relative to the range's top-left
       * cell; anything else is typed input (`10`, `5%`, `3/4/2026`, `Done`).
       */
      type: 'cellIs';
      operator: ConditionalFormatOperator;
      value: string;
      value2?: string;
      style: ConditionalFormatStyle;
    }
  | {
      /** A formula written for the range's top-left cell: `=$B2>100` formats whole rows. */
      type: 'expression';
      formula: string;
      style: ConditionalFormatStyle;
    }
  | {
      /** Case-insensitive text tests on the cell's value as text. */
      type: 'containsText' | 'notContainsText' | 'beginsWith' | 'endsWith';
      text: string;
      style: ConditionalFormatStyle;
    }
  | { type: 'blanks' | 'noBlanks' | 'errors' | 'noErrors' | 'duplicate' | 'unique'; style: ConditionalFormatStyle }
  | {
      /** Top/bottom `rank` values, or `rank` percent of them. */
      type: 'top10';
      bottom?: boolean;
      percent?: boolean;
      rank: number;
      style: ConditionalFormatStyle;
    }
  | {
      /** Above (or below) the average, optionally by `stdDev` standard deviations. */
      type: 'aboveAverage';
      below?: boolean;
      equal?: boolean;
      stdDev?: number;
      style: ConditionalFormatStyle;
    }
  | { type: 'timePeriod'; period: ConditionalFormatTimePeriod; style: ConditionalFormatStyle }
  | {
      /** Two or three stops (low, [mid,] high) with colours; the fill blends between them. */
      type: 'colorScale';
      stops: Array<{ value: ConditionalFormatValue; color: string }>;
    }
  | {
      type: 'dataBar';
      min?: ConditionalFormatValue; // default min
      max?: ConditionalFormatValue; // default max
      color?: string; // default #638ec6
      gradient?: boolean; // default true
      showValue?: boolean; // default true
    }
  | {
      type: 'iconSet';
      set?: ConditionalFormatIconSet; // default 3TrafficLights1
      /**
       * One threshold per icon, the first being the lower bound (as in
       * files), or one fewer (the lower bound left out). Default: even
       * percent steps (0, 33, 67 for three icons).
       */
      thresholds?: ConditionalFormatValue[];
      reverse?: boolean;
      showValue?: boolean; // default true
    };

export type ConditionalFormatType = ConditionalFormatCondition['type'];

/**
 * A conditional format: a condition applied to one or more ranges. Rules
 * are kept in priority order (the first rule has the highest priority).
 * Ranges are 0-based and belong to the sheet that stores the rule.
 */
export type ConditionalFormatRule = ConditionalFormatCondition & {
  id: string;
  ranges: CellRange[];
  /** When this rule matches a cell, lower-priority rules are not applied to it. */
  stopIfTrue?: boolean;
};

/** A rule to add: the id is generated when left out. */
export type NewConditionalFormatRule = ConditionalFormatCondition & {
  id?: string;
  ranges: CellRange[];
  stopIfTrue?: boolean;
};

/** The conditional look of one cell, combined from every rule that applies. */
export interface ConditionalCellFormat {
  fill?: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  /** Data bar: `fraction` (0..1) of the cell width. */
  dataBar?: { fraction: number; color: string; gradient: boolean };
  /** Icon of an icon set: `index` 0 is the lowest icon; `id` is `"<set>:<index>"`. */
  icon?: { set: ConditionalFormatIconSet; index: number; id: string };
  /** A data bar or icon set with `showValue: false`: show the bar / icon only. */
  hideValue?: boolean;
}

/** Per-cell results of evaluating the conditional formats of a sheet. */
export interface ConditionalFormatOverlay {
  /** The conditional look of (row, col), or undefined when no rule applies. */
  get(row: number, col: number): ConditionalCellFormat | undefined;
  /** Number of cells with a conditional look. */
  readonly size: number;
  /** Every formatted cell. */
  entries(): IterableIterator<[{ row: number; col: number }, ConditionalCellFormat]>;
}

/** What evaluation needs to know about a sheet. Rows and columns are 0-based. */
export interface ConditionalFormatSheet {
  rowCount: number;
  colCount: number;
  /** The cell's value: number, text (dates are ISO text), boolean, error code or ''. */
  getValue(row: number, col: number): unknown;
  /**
   * Evaluates a formula (with a leading `=`) as if it were in (row, col).
   * Without it, formula rules never match and formula anchors count as 0.
   */
  evaluateFormula?(formula: string, row: number, col: number): unknown;
  /** The current date, for `timePeriod` rules (default: now). */
  today?(): Date;
}
