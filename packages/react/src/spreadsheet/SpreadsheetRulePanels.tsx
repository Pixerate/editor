import React, { useMemo, useState } from 'react';
import {
  CONDITIONAL_FORMAT_ICON_SETS,
  CONDITIONAL_FORMAT_PRESETS,
  CONDITIONAL_FORMAT_STYLE_PRESETS,
  CONDITIONAL_FORMAT_TIME_PERIODS,
  DATA_VALIDATION_ERROR_STYLE_OPTIONS,
  DATA_VALIDATION_OPERATOR_OPTIONS,
  DATA_VALIDATION_TYPE_OPTIONS,
  createConditionalFormatRule,
  describeConditionalFormat,
  describeDataValidation,
  formatRuleRanges,
  getConditionalFormatCss,
  parseRuleRanges,
  type CellRange,
  type ConditionalFormatIconSet,
  type ConditionalFormatPresetKind,
  type ConditionalFormatRule,
  type ConditionalFormatTimePeriod,
  type DataValidationErrorStyle,
  type DataValidationOperator,
  type DataValidationType
} from '@pixerate/editor/spreadsheet';
import type { useSpreadsheetEditor } from './useSpreadsheetEditor';

type SpreadsheetState = ReturnType<typeof useSpreadsheetEditor>;

export interface SpreadsheetRulePanelProps {
  state: SpreadsheetState;
  onClose: () => void;
}

const inputClass = 'w-full rounded border border-border bg-background px-1.5 py-0.5 text-xs text-foreground';
const buttonClass = 'rounded border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-40';

function selectionText(range: CellRange | null): string {
  return range ? formatRuleRanges([range]) : 'A1';
}

/** Frame shared by both managers: a compact side panel that keeps keys away from the grid. */
const PanelFrame: React.FC<{ title: string; label: string; onClose: () => void; children: React.ReactNode }> = ({
  title,
  label,
  onClose,
  children
}) => (
  <div
    role="dialog"
    aria-label={label}
    className="fixed right-4 top-16 z-40 flex max-h-[calc(100vh-5rem)] w-80 flex-col overflow-y-auto rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg"
    style={{ background: 'var(--popover, var(--background, #fff))' }}
    onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === 'Escape') onClose();
    }}
    onContextMenu={(e) => e.stopPropagation()}
  >
    <div className="mb-2 flex items-center justify-between">
      <h2 className="text-sm font-semibold">{title}</h2>
      <button type="button" aria-label="Close" className="px-1 text-muted-foreground hover:text-foreground" onClick={onClose}>
        ✕
      </button>
    </div>
    {children}
  </div>
);

/** Swatch showing a rule's look (fill, font colour, bold) or its kind. */
function RuleSwatch({ rule }: { rule: ConditionalFormatRule }) {
  if (rule.type === 'colorScale') {
    return (
      <span
        aria-hidden="true"
        className="inline-block h-3 w-6 shrink-0 rounded-sm border border-border"
        style={{ background: `linear-gradient(90deg, ${rule.stops.map((s) => s.color).join(', ')})` }}
      />
    );
  }
  if (rule.type === 'dataBar') {
    return <span aria-hidden="true" className="inline-block h-3 w-6 shrink-0 rounded-sm" style={{ background: rule.color ?? '#638ec6' }} />;
  }
  if (rule.type === 'iconSet') return <span aria-hidden="true" className="shrink-0">●</span>;
  const css = getConditionalFormatCss(rule.style);
  return (
    <span aria-hidden="true" className="inline-flex h-4 w-6 shrink-0 items-center justify-center rounded-sm border border-border" style={css}>
      Aa
    </span>
  );
}

/**
 * Conditional formatting manager: the sheet's rules in priority order (move,
 * stop if true, delete) and a form to add a rule to a range.
 */
export const SpreadsheetConditionalFormatPanel: React.FC<SpreadsheetRulePanelProps> = ({ state, onClose }) => {
  const rules = state.document.table?.conditionalFormats ?? [];
  const [kind, setKind] = useState<ConditionalFormatPresetKind>('greaterThan');
  const [appliesTo, setAppliesTo] = useState(() => selectionText(state.selectedRange));
  const [value, setValue] = useState('');
  const [value2, setValue2] = useState('');
  const [text, setText] = useState('');
  const [formula, setFormula] = useState('=');
  const [rank, setRank] = useState('10');
  const [period, setPeriod] = useState<ConditionalFormatTimePeriod>('today');
  const [iconSet, setIconSet] = useState<ConditionalFormatIconSet>('3TrafficLights1');
  const [color, setColor] = useState('#638ec6');
  const [styleId, setStyleId] = useState(CONDITIONAL_FORMAT_STYLE_PRESETS[0].id);
  const preset = useMemo(() => CONDITIONAL_FORMAT_PRESETS.find((p) => p.kind === kind)!, [kind]);
  const ranges = parseRuleRanges(appliesTo);

  const add = () => {
    if (!ranges) return;
    state.addConditionalFormat(
      createConditionalFormatRule({
        kind,
        ranges,
        value,
        value2,
        text,
        formula,
        rank: Number(rank) || 10,
        period,
        iconSet,
        color,
        style: CONDITIONAL_FORMAT_STYLE_PRESETS.find((s) => s.id === styleId)?.style
      })
    );
  };

  return (
    <PanelFrame title="Conditional formatting" label="Conditional formatting rules" onClose={onClose}>
      <ol className="mb-3 flex flex-col gap-1" aria-label="Rules in priority order">
        {rules.length === 0 && <li className="text-muted-foreground">No rules on this sheet.</li>}
        {rules.map((rule, i) => (
          <li key={rule.id} data-rule-id={rule.id} className="flex items-center gap-1.5 rounded border border-border px-1.5 py-1">
            <RuleSwatch rule={rule} />
            <div className="min-w-0 flex-1">
              <div className="truncate" title={describeConditionalFormat(rule)}>
                {describeConditionalFormat(rule)}
              </div>
              <div className="truncate font-mono text-[10px] text-muted-foreground">{formatRuleRanges(rule.ranges)}</div>
            </div>
            <label className="flex items-center gap-0.5 text-[10px]" title="Stop if true">
              <input
                type="checkbox"
                aria-label="Stop if true"
                checked={!!rule.stopIfTrue}
                onChange={(e) => state.updateConditionalFormat(rule.id, { stopIfTrue: e.target.checked })}
              />
              Stop
            </label>
            <button type="button" aria-label="Move up" className={buttonClass} disabled={i === 0} onClick={() => state.moveConditionalFormat(rule.id, { by: -1 })}>
              ▲
            </button>
            <button
              type="button"
              aria-label="Move down"
              className={buttonClass}
              disabled={i === rules.length - 1}
              onClick={() => state.moveConditionalFormat(rule.id, { by: 1 })}
            >
              ▼
            </button>
            <button type="button" aria-label="Delete rule" className={buttonClass} onClick={() => state.deleteConditionalFormat(rule.id)}>
              ✕
            </button>
          </li>
        ))}
      </ol>

      <fieldset className="flex flex-col gap-1.5 border-t border-border pt-2">
        <legend className="sr-only">New rule</legend>
        <label className="flex flex-col gap-0.5">
          Format cells
          <select aria-label="Rule type" className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as ConditionalFormatPresetKind)}>
            {CONDITIONAL_FORMAT_PRESETS.map((p) => (
              <option key={p.kind} value={p.kind}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {preset.fields.includes('value') && (
          <input aria-label="Value" placeholder="Value or =formula" className={inputClass} value={value} onChange={(e) => setValue(e.target.value)} />
        )}
        {preset.fields.includes('value2') && (
          <input aria-label="Second value" placeholder="and" className={inputClass} value={value2} onChange={(e) => setValue2(e.target.value)} />
        )}
        {preset.fields.includes('text') && (
          <input aria-label="Text" placeholder="Text" className={inputClass} value={text} onChange={(e) => setText(e.target.value)} />
        )}
        {preset.fields.includes('formula') && (
          <input aria-label="Formula" placeholder="=$A1>10" className={inputClass} value={formula} onChange={(e) => setFormula(e.target.value)} />
        )}
        {preset.fields.includes('rank') && (
          <input aria-label="Rank" type="number" min={1} className={inputClass} value={rank} onChange={(e) => setRank(e.target.value)} />
        )}
        {preset.fields.includes('period') && (
          <select aria-label="Period" className={inputClass} value={period} onChange={(e) => setPeriod(e.target.value as ConditionalFormatTimePeriod)}>
            {CONDITIONAL_FORMAT_TIME_PERIODS.map((p) => (
              <option key={p.period} value={p.period}>
                {p.label}
              </option>
            ))}
          </select>
        )}
        {preset.fields.includes('iconSet') && (
          <select aria-label="Icon set" className={inputClass} value={iconSet} onChange={(e) => setIconSet(e.target.value as ConditionalFormatIconSet)}>
            {CONDITIONAL_FORMAT_ICON_SETS.map((set) => (
              <option key={set} value={set}>
                {set}
              </option>
            ))}
          </select>
        )}
        {preset.fields.includes('color') && (
          <input aria-label="Bar colour" type="color" className="h-6 w-12" value={color} onChange={(e) => setColor(e.target.value)} />
        )}
        {preset.usesStyle && (
          <select aria-label="Style" className={inputClass} value={styleId} onChange={(e) => setStyleId(e.target.value)}>
            {CONDITIONAL_FORMAT_STYLE_PRESETS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        )}
        <label className="flex flex-col gap-0.5">
          Applies to
          <input aria-label="Applies to" className={`${inputClass} font-mono`} value={appliesTo} onChange={(e) => setAppliesTo(e.target.value)} />
        </label>
        <div className="flex justify-between gap-2">
          <button type="button" className={buttonClass} onClick={() => setAppliesTo(selectionText(state.selectedRange))}>
            Use selection
          </button>
          <button type="button" className={buttonClass} disabled={!ranges} onClick={add}>
            Add rule
          </button>
        </div>
      </fieldset>
    </PanelFrame>
  );
};

/**
 * Data validation manager: the sheet's rules (delete), a form to validate a
 * range, and "circle invalid data".
 */
export const SpreadsheetDataValidationPanel: React.FC<SpreadsheetRulePanelProps> = ({ state, onClose }) => {
  const rules = state.document.table?.dataValidations ?? [];
  const [type, setType] = useState<DataValidationType>('list');
  const [operator, setOperator] = useState<DataValidationOperator>('between');
  const [formula1, setFormula1] = useState('');
  const [formula2, setFormula2] = useState('');
  const [errorStyle, setErrorStyle] = useState<DataValidationErrorStyle>('stop');
  const [errorMessage, setErrorMessage] = useState('');
  const [inputMessage, setInputMessage] = useState('');
  const [ignoreBlank, setIgnoreBlank] = useState(true);
  const [appliesTo, setAppliesTo] = useState(() => selectionText(state.selectedRange));
  const ranges = parseRuleRanges(appliesTo);
  const usesOperator = type === 'whole' || type === 'decimal' || type === 'date' || type === 'time' || type === 'textLength';
  const needsTwo = usesOperator && (operator === 'between' || operator === 'notBetween');
  const circles = state.controller.getInvalidDataCircles();

  const apply = () => {
    if (!ranges) return;
    state.addDataValidation({
      ranges,
      type,
      ...(usesOperator ? { operator } : {}),
      ...(formula1 ? { formula1 } : {}),
      ...(needsTwo && formula2 ? { formula2 } : {}),
      errorStyle,
      ...(errorMessage ? { errorMessage } : {}),
      ...(inputMessage ? { inputMessage } : {}),
      ignoreBlank
    });
  };

  return (
    <PanelFrame title="Data validation" label="Data validation rules" onClose={onClose}>
      <ul className="mb-3 flex flex-col gap-1" aria-label="Validation rules">
        {rules.length === 0 && <li className="text-muted-foreground">No validation on this sheet.</li>}
        {rules.map((rule) => (
          <li key={rule.id} data-rule-id={rule.id} className="flex items-center gap-1.5 rounded border border-border px-1.5 py-1">
            <div className="min-w-0 flex-1">
              <div className="truncate" title={describeDataValidation(rule)}>
                {describeDataValidation(rule)}
              </div>
              <div className="truncate font-mono text-[10px] text-muted-foreground">
                {formatRuleRanges(rule.ranges)} · {rule.errorStyle ?? 'stop'}
              </div>
            </div>
            <button type="button" aria-label="Delete rule" className={buttonClass} onClick={() => state.deleteDataValidation(rule.id)}>
              ✕
            </button>
          </li>
        ))}
      </ul>

      <fieldset className="flex flex-col gap-1.5 border-t border-border pt-2">
        <legend className="sr-only">New validation</legend>
        <label className="flex flex-col gap-0.5">
          Allow
          <select aria-label="Allow" className={inputClass} value={type} onChange={(e) => setType(e.target.value as DataValidationType)}>
            {DATA_VALIDATION_TYPE_OPTIONS.map((o) => (
              <option key={o.type} value={o.type}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {usesOperator && (
          <select aria-label="Operator" className={inputClass} value={operator} onChange={(e) => setOperator(e.target.value as DataValidationOperator)}>
            {DATA_VALIDATION_OPERATOR_OPTIONS.map((o) => (
              <option key={o.operator} value={o.operator}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        {type !== 'any' && (
          <input
            aria-label={type === 'list' ? 'Source' : type === 'custom' ? 'Formula' : needsTwo ? 'Minimum' : 'Value'}
            placeholder={type === 'list' ? 'Low,Medium,High or =$H$1:$H$5' : type === 'custom' ? '=A1>0' : 'Value or =formula'}
            className={inputClass}
            value={formula1}
            onChange={(e) => setFormula1(e.target.value)}
          />
        )}
        {needsTwo && <input aria-label="Maximum" placeholder="Maximum" className={inputClass} value={formula2} onChange={(e) => setFormula2(e.target.value)} />}
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={ignoreBlank} onChange={(e) => setIgnoreBlank(e.target.checked)} /> Ignore blank
        </label>
        <input aria-label="Input message" placeholder="Input message (optional)" className={inputClass} value={inputMessage} onChange={(e) => setInputMessage(e.target.value)} />
        <div className="flex gap-1">
          <select aria-label="Error style" className={inputClass} value={errorStyle} onChange={(e) => setErrorStyle(e.target.value as DataValidationErrorStyle)}>
            {DATA_VALIDATION_ERROR_STYLE_OPTIONS.map((o) => (
              <option key={o.style} value={o.style}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <input aria-label="Error message" placeholder="Error message (optional)" className={inputClass} value={errorMessage} onChange={(e) => setErrorMessage(e.target.value)} />
        <label className="flex flex-col gap-0.5">
          Applies to
          <input aria-label="Applies to" className={`${inputClass} font-mono`} value={appliesTo} onChange={(e) => setAppliesTo(e.target.value)} />
        </label>
        <div className="flex flex-wrap justify-between gap-2">
          <button type="button" className={buttonClass} onClick={() => setAppliesTo(selectionText(state.selectedRange))}>
            Use selection
          </button>
          <button type="button" className={buttonClass} disabled={!ranges} onClick={() => ranges && ranges.forEach((r) => state.clearDataValidation(r))}>
            Clear
          </button>
          <button type="button" className={buttonClass} disabled={!ranges} onClick={apply}>
            Apply
          </button>
        </div>
        <button type="button" className={buttonClass} aria-pressed={circles} onClick={() => state.setInvalidDataCircles(!circles)}>
          {circles ? 'Clear validation circles' : 'Circle invalid data'}
        </button>
      </fieldset>
    </PanelFrame>
  );
};
