import React, { useState } from 'react';
import type { ImageEditorController, SelectionMask, SelectionRecipeStep } from '@pixerate/editor/image-editor';
import { describeRecipeStep, recipeStepSetting } from '@pixerate/editor/image-editor';

export interface SelectionRecipePanelProps {
  controller: ImageEditorController;
  /** The current selection (`state.selection`), so the panel re-renders with it. */
  selection?: SelectionMask | null;
  className?: string;
}

const MODES = ['replace', 'add', 'subtract', 'intersect'] as const;
const button =
  'px-1.5 py-0.5 rounded border border-border bg-background text-[11px] text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40';

/**
 * Live selection: the steps that made the selection, editable afterwards (each change replays
 * them as one undo step), as the `*_selection_step` tools do. Freeze keeps the selection and drops
 * the steps. Hidden while the selection is frozen or empty.
 */
export const SelectionRecipePanel: React.FC<SelectionRecipePanelProps> = ({ controller, className = '' }) => {
  const [error, setError] = useState<string | null>(null);
  const recipe = controller.getSelectionRecipe();
  if (!recipe.live) return null;
  const run = (p: Promise<unknown> | unknown) => {
    setError(null);
    Promise.resolve(p).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };
  return (
    <div data-testid="selection-recipe" className={`flex flex-col gap-1 text-xs ${className}`}>
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">Selection steps</span>
        <button type="button" className={button} title="Keep the selection, drop its steps" onClick={() => run(controller.freezeSelection())}>
          Freeze
        </button>
      </div>
      <ol className="flex flex-col gap-1">
        {recipe.steps.map((step) => {
          const setting = recipeStepSetting(step);
          const shape = 'mode' in step || ['rect', 'ellipse', 'polygon', 'magic-wand', 'color-range', 'color-range-preset'].includes(step.op);
          return (
            <li key={`${step.index}:${JSON.stringify(step)}`} data-testid="selection-step" className="flex flex-wrap items-center gap-1">
              <span className="flex-1 min-w-0 truncate text-foreground">{describeRecipeStep(step as SelectionRecipeStep)}</span>
              {shape && step.index > 0 && (
                <select
                  aria-label={`Step ${step.index + 1} mode`}
                  value={(step as { mode?: string }).mode ?? 'replace'}
                  onChange={(e) => run(controller.editSelectionStep(step.index, { mode: e.target.value }))}
                  className="bg-background border border-border rounded px-1 py-0.5 text-foreground"
                >
                  {MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              )}
              {setting && (
                <label className="flex items-center gap-1 text-muted-foreground">
                  {setting.label}
                  <input
                    type="number"
                    min={setting.min}
                    max={setting.max}
                    aria-label={`Step ${step.index + 1} ${setting.label}`}
                    defaultValue={setting.value}
                    onBlur={(e) => Number(e.target.value) !== setting.value && run(controller.editSelectionStep(step.index, setting.change(Number(e.target.value))))}
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                    className="w-12 bg-background border border-border rounded px-1 py-0.5 text-foreground"
                  />
                </label>
              )}
              <button type="button" className={button} aria-label={`Remove step ${step.index + 1}`} disabled={recipe.steps.length === 1} onClick={() => run(controller.removeSelectionStep(step.index))}>
                ×
              </button>
            </li>
          );
        })}
      </ol>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
};
