import React, { useEffect, useRef } from 'react';
import type { SpreadsheetValidationAction, SpreadsheetValidationPrompt } from '@pixerate/editor/spreadsheet';

export interface SpreadsheetValidationDialogProps {
  prompt: SpreadsheetValidationPrompt;
  onResolve: (action: SpreadsheetValidationAction) => void;
}

/**
 * The data validation alert: Stop (Retry / Cancel), Warning ("Continue?"
 * Yes / No / Cancel) or Information (OK / Cancel), as in Excel.
 */
export const SpreadsheetValidationDialog: React.FC<SpreadsheetValidationDialogProps> = ({ prompt, onResolve }) => {
  const style = prompt.result.errorStyle ?? 'stop';
  const firstButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    firstButton.current?.focus();
  }, [prompt]);

  const buttons: Array<{ label: string; action: SpreadsheetValidationAction }> =
    style === 'stop'
      ? [
          { label: 'Retry', action: 'retry' },
          { label: 'Cancel', action: 'cancel' }
        ]
      : style === 'warning'
        ? [
            { label: 'Yes', action: 'accept' },
            { label: 'No', action: 'retry' },
            { label: 'Cancel', action: 'cancel' }
          ]
        : [
            { label: 'OK', action: 'accept' },
            { label: 'Cancel', action: 'cancel' }
          ];
  const icon = style === 'stop' ? '⛔' : style === 'warning' ? '⚠' : 'ℹ';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30"
      onMouseDown={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          onResolve('cancel');
        }
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="spreadsheet-validation-title"
        aria-describedby="spreadsheet-validation-message"
        data-error-style={style}
        className="w-[22rem] max-w-[calc(100vw-2rem)] rounded-md border border-border bg-popover p-4 text-xs text-popover-foreground shadow-xl"
        style={{ background: 'var(--popover, var(--background, #fff))' }}
      >
        <div className="flex items-start gap-3">
          <span aria-hidden="true" className="text-lg leading-none">{icon}</span>
          <div className="min-w-0 flex-1">
            <h2 id="spreadsheet-validation-title" className="mb-1 text-sm font-semibold">
              {prompt.result.title}
            </h2>
            <p id="spreadsheet-validation-message" className="whitespace-pre-wrap">
              {prompt.result.message}
            </p>
            {style === 'warning' && <p className="mt-2">Continue?</p>}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          {buttons.map((button, i) => (
            <button
              key={button.action}
              ref={i === 0 ? firstButton : undefined}
              type="button"
              data-action={button.action}
              className={`rounded border border-border px-3 py-1 ${i === 0 ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
              onClick={() => onResolve(button.action)}
            >
              {button.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
