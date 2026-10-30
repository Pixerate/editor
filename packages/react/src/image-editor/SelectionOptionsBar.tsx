import React, { useState } from 'react';
import type { ColorRangePreset, ImageEditorController, SelectionDisplay, SelectionMask, SelectionModifyOp, SelectionToolOptions } from '@pixerate/editor/image-editor';
import {
  COLOR_RANGE_PRESETS,
  COLOR_RANGE_PRESET_LABELS,
  SELECTION_MODES,
  SELECTION_MODE_LABELS,
  SELECTION_TOOLS,
  describeSelection,
} from '@pixerate/editor/image-editor';
import { imageRangeClass } from './styles';
import { ImageCheckbox, ImageRange, ImageSelect } from './controls/controls.js';

export interface SelectionOptionsBarProps {
  controller: ImageEditorController;
  options: SelectionToolOptions;
  onOptionsChange: (next: SelectionToolOptions) => void;
  /** The current selection (pass `state.selection` so the bar re-renders with it). */
  selection?: SelectionMask | null;
  /** The current Quick Mask view flag (`state.quickMask`). */
  quickMask?: boolean;
  /** How the canvas shows the selection (`state.selectionDisplay`); wins over `quickMask`. */
  selectionDisplay?: SelectionDisplay;
  className?: string;
}

const MODIFY_OPS: { op: SelectionModifyOp; label: string }[] = [
  { op: 'expand', label: 'Expand' },
  { op: 'contract', label: 'Contract' },
  { op: 'feather', label: 'Feather' },
  { op: 'border', label: 'Border' },
  { op: 'smooth', label: 'Smooth' },
];

const DISPLAYS: { id: SelectionDisplay; label: string }[] = [
  { id: 'ants', label: 'Ants' },
  { id: 'quickMask', label: 'Quick Mask' },
  { id: 'none', label: 'Hidden' },
];

const numberInput = 'w-14 bg-background border border-border rounded px-1 py-0.5 text-foreground';

const btn = (on: boolean) =>
  `px-2 py-1 rounded-md border text-[11px] transition-colors ${
    on ? 'bg-primary border-primary text-primary-foreground' : 'bg-background border-border text-foreground hover:bg-accent hover:text-accent-foreground'
  }`;

/**
 * Options bar of the selection tools: tool, mode (new / add / subtract / intersect), feather,
 * magic wand tolerance, contiguous and colour distance, Color Range (click to sample, Shift-click
 * to add, Alt-click to remove; fuzziness, localized, invert, presets), anti-alias, sample merged,
 * Select › All / Deselect / Inverse, Modify (grow, shrink, feather, border, smooth) and how the
 * selection shows (marching ants, Quick Mask or hidden). With a segmentation
 * provider on the controller it adds Select › Subject (a description and a button).
 */
export const SelectionOptionsBar: React.FC<SelectionOptionsBarProps> = ({
  controller,
  options,
  onOptionsChange,
  selection,
  quickMask,
  selectionDisplay,
  className = '',
}) => {
  const [radius, setRadius] = useState(2);
  const set = (patch: Partial<SelectionToolOptions>) => onOptionsChange({ ...options, ...patch });
  const sel = selection === undefined ? controller.getSelection() : selection;
  const display: SelectionDisplay = selectionDisplay ?? (quickMask === undefined ? controller.getSelectionDisplay() : quickMask ? 'quickMask' : 'ants');
  const [preset, setPreset] = useState<ColorRangePreset>('reds');
  const [rangeStatus, setRangeStatus] = useState<string | null>(null);
  const [colorStatus, setColorStatus] = useState<string | null>(null);
  const [strokeWidth, setStrokeWidth] = useState(4);
  const [strokeLocation, setStrokeLocation] = useState<'inside' | 'center' | 'outside'>('outside');
  const edit = (fn: () => unknown) => {
    setColorStatus(null);
    try {
      fn();
    } catch (err) {
      setColorStatus(err instanceof Error ? err.message : String(err));
    }
  };
  const runColor = async (op: 'grow' | 'similar') => {
    setColorStatus(null);
    const opts = { tolerance: options.tolerance, sampleMerged: options.sampleMerged, sample: options.sample };
    try {
      await (op === 'grow' ? controller.growSelection(opts) : controller.selectSimilar(opts));
    } catch (err) {
      setColorStatus(err instanceof Error ? err.message : String(err));
    }
  };
  const applyPreset = async () => {
    setRangeStatus(null);
    try {
      await controller.selectColorRangePreset(preset, {
        mode: options.mode,
        feather: options.feather ?? 0,
        invert: options.rangeInvert ?? false,
        falloff: options.fuzziness ?? 20,
        sampleMerged: options.sampleMerged,
        sample: options.sample,
      });
    } catch (err) {
      setRangeStatus(err instanceof Error ? err.message : String(err));
    }
  };
  const [subject, setSubject] = useState('');
  const [segmenting, setSegmenting] = useState(false);
  const [subjectStatus, setSubjectStatus] = useState<string | null>(null);
  const selectSubject = async () => {
    const target = subject.trim();
    if (!target || segmenting) return;
    setSegmenting(true);
    setSubjectStatus(null);
    try {
      const { segments } = await controller.selectSubject(target, { mode: options.mode });
      setSubjectStatus(segments.length ? null : `Nothing matching “${target}” was found.`);
    } catch (err) {
      setSubjectStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setSegmenting(false);
    }
  };
  return (
    <div data-testid="selection-options-bar" className={`flex flex-col gap-3 text-xs ${className}`}>
      <div role="group" aria-label="Selection tool" className="flex flex-wrap gap-1">
        {SELECTION_TOOLS.map((t) => (
          <button key={t.id} type="button" aria-pressed={options.tool === t.id} className={btn(options.tool === t.id)} onClick={() => set({ tool: t.id })}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="group" aria-label="Selection mode" className="flex flex-wrap gap-1">
        {SELECTION_MODES.map((m) => (
          <button key={m} type="button" aria-pressed={options.mode === m} className={btn(options.mode === m)} onClick={() => set({ mode: m })}>
            {SELECTION_MODE_LABELS[m]}
          </button>
        ))}
      </div>
      {options.tool === 'wand' && (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="flex justify-between text-muted-foreground">
              <span>Tolerance</span>
              <span className="font-mono">{options.tolerance}</span>
            </span>
            <ImageRange label="Tolerance" min={0} max={255} step={1} value={options.tolerance} onChange={(v) => set({ tolerance: v })} />
          </label>
          <label className="flex items-center gap-2 text-foreground">
            <ImageCheckbox label="Contiguous" checked={options.contiguous} onChange={(on) => set({ contiguous: on })} />
            Contiguous
          </label>
          <label className="flex items-center gap-2 text-foreground">
            Distance
            <ImageSelect
              label="Colour distance"
              value={options.distance}
              options={[
                { value: 'rgb', label: 'RGB' },
                { value: 'perceptual', label: 'Perceptual' },
              ]}
              onChange={(v) => set({ distance: v as 'rgb' | 'perceptual' })}
            />
          </label>
          <label className="flex items-center gap-2 text-foreground">
            <ImageCheckbox label="Sample adjusted image" checked={options.sampleMerged} onChange={(on) => set({ sampleMerged: on })} />
            Sample adjusted image
          </label>
          <label className="flex items-center gap-2 text-foreground">
            Sample
            <ImageSelect
              label="Sample from"
              value={options.sample ?? 'composite'}
              options={[
                { value: 'composite', label: 'All layers' },
                { value: 'active-layer', label: 'Active layer' },
              ]}
              onChange={(v) => set({ sample: v as 'composite' | 'active-layer' })}
            />
          </label>
        </div>
      )}
      {options.tool === 'polygon' && (
        <p className="text-muted-foreground">Click to add corners (Shift for 45°), drag for a free-hand stretch; double-click, Enter or a click on the first corner closes it, Backspace removes a corner, Escape cancels.</p>
      )}
      {options.tool === 'magnetic' && (
        <div data-testid="magnetic-lasso-options" className="flex flex-col gap-2">
          <p className="text-muted-foreground">Click on an edge, then move along it: the outline snaps to the edge and adds points as it goes. Click to add a point; double-click, Enter or a click on the start closes it, Backspace removes the last point, Escape cancels.</p>
          <label className="flex flex-col gap-1">
            <span className="flex justify-between text-muted-foreground">
              <span>Width</span>
              <span className="font-mono">{options.magneticWidth ?? 10} px</span>
            </span>
            <ImageRange label="Magnetic lasso width" min={1} max={256} step={1} value={options.magneticWidth ?? 10} onChange={(v) => set({ magneticWidth: v })} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="flex justify-between text-muted-foreground">
              <span>Contrast</span>
              <span className="font-mono">{options.magneticContrast ?? 10}%</span>
            </span>
            <ImageRange label="Magnetic lasso contrast" min={1} max={100} step={1} value={options.magneticContrast ?? 10} onChange={(v) => set({ magneticContrast: v })} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="flex justify-between text-muted-foreground">
              <span>Frequency</span>
              <span className="font-mono">{options.magneticFrequency ?? 57}</span>
            </span>
            <ImageRange label="Magnetic lasso frequency" min={0} max={100} step={1} value={options.magneticFrequency ?? 57} onChange={(v) => set({ magneticFrequency: v })} />
          </label>
        </div>
      )}
      {options.tool === 'quick' && (
        <div data-testid="quick-selection-options" className="flex flex-col gap-2">
          <p className="text-muted-foreground">Paint inside the area: the selection grows out to its edges. Each stroke adds (Alt-drag subtracts).</p>
          <label className="flex flex-col gap-1">
            <span className="flex justify-between text-muted-foreground">
              <span>Size</span>
              <span className="font-mono">{options.quickSize ?? 30} px</span>
            </span>
            <ImageRange label="Quick selection size" min={1} max={500} step={1} value={options.quickSize ?? 30} onChange={(v) => set({ quickSize: v })} />
          </label>
          <label className="flex items-center gap-2 text-foreground">
            <ImageCheckbox label="Sample all layers" checked={options.quickSampleAll ?? true} onChange={(on) => set({ quickSampleAll: on })} />
            Sample all layers
          </label>
          <label className="flex items-center gap-2 text-foreground">
            <ImageCheckbox label="Auto-enhance edges" checked={options.quickEnhance ?? false} onChange={(on) => set({ quickEnhance: on })} />
            Auto-enhance edges
          </label>
        </div>
      )}
      {options.tool === 'object' && (
        <div data-testid="object-selection-options" className="flex flex-col gap-2">
          <p className="text-muted-foreground">Drag a box loosely around an object, or click on it. Shift adds, Alt subtracts.</p>
          <label className="flex items-center gap-2 text-foreground">
            <ImageCheckbox label="Object sample all layers" checked={options.objectSampleAll ?? true} onChange={(on) => set({ objectSampleAll: on })} />
            Sample all layers
          </label>
          <label className="flex items-center gap-2 text-foreground">
            <ImageCheckbox label="Object auto-enhance edges" checked={options.objectEnhance ?? false} onChange={(on) => set({ objectEnhance: on })} />
            Auto-enhance edges
          </label>
        </div>
      )}
      {(options.tool === 'type' || options.tool === 'type-vertical') && (
        <div data-testid="type-mask-options" className="flex flex-col gap-2">
          <p className="text-muted-foreground">
            {options.tool === 'type-vertical' ? 'Click where the column starts: the letters are stacked down from there, centred on the click.' : 'Click where the text starts (its baseline).'} Shift-click adds, Alt-click subtracts.
          </p>
          <label className="flex items-center gap-1 text-muted-foreground">
            Text
            <input
              type="text"
              aria-label="Type mask text"
              value={options.typeText ?? 'Type'}
              onChange={(e) => set({ typeText: e.target.value })}
              className="min-w-0 flex-1 bg-background border border-border rounded px-1 py-0.5 text-foreground"
            />
          </label>
          <label className="flex items-center gap-1 text-muted-foreground">
            Size
            <input
              type="number"
              min={1}
              step={1}
              aria-label="Type mask size"
              value={options.typeSize ?? 72}
              onChange={(e) => set({ typeSize: Math.max(1, Number(e.target.value) || 1) })}
              className={numberInput}
            />
            px
          </label>
          <label className="flex items-center gap-1 text-muted-foreground">
            Font
            <input
              type="text"
              aria-label="Type mask font"
              value={options.typeFamily ?? 'sans-serif'}
              onChange={(e) => set({ typeFamily: e.target.value })}
              className="min-w-0 flex-1 bg-background border border-border rounded px-1 py-0.5 text-foreground"
            />
          </label>
        </div>
      )}
      {options.tool === 'range' && (
        <div data-testid="color-range-options" className="flex flex-col gap-2">
          <p className="text-muted-foreground">Click a colour to select it; Shift-click adds a colour, Alt-click removes one.</p>
          <label className="flex flex-col gap-1">
            <span className="flex justify-between text-muted-foreground">
              <span>Fuzziness</span>
              <span className="font-mono">{options.fuzziness ?? 40}</span>
            </span>
            <ImageRange label="Fuzziness" min={0} max={200} step={1} value={options.fuzziness ?? 40} onChange={(v) => set({ fuzziness: v })} />
          </label>
          <label className="flex items-center gap-1 text-muted-foreground">
            Localized radius
            <input
              type="number"
              min={0}
              step={1}
              aria-label="Localized radius"
              value={options.localized ?? 0}
              onChange={(e) => set({ localized: Math.max(0, Number(e.target.value) || 0) })}
              className={numberInput}
            />
            px
          </label>
          <label className="flex items-center gap-2 text-foreground">
            <ImageCheckbox label="Invert" checked={options.rangeInvert ?? false} onChange={(on) => set({ rangeInvert: on })} />
            Invert
          </label>
          <div className="flex items-center gap-1">
            <ImageSelect
              label="Color Range preset"
              value={preset}
              options={COLOR_RANGE_PRESETS.map((p) => ({ value: p, label: COLOR_RANGE_PRESET_LABELS[p] }))}
              onChange={(v) => setPreset(v as ColorRangePreset)}
            />
            <button type="button" className={btn(false)} onClick={() => void applyPreset()}>
              Select
            </button>
          </div>
          {rangeStatus && (
            <p role="status" className="text-muted-foreground">
              {rangeStatus}
            </p>
          )}
        </div>
      )}
      <label className="flex items-center gap-1 text-muted-foreground">
        Feather
        <input
          type="number"
          min={0}
          max={1000}
          step={0.5}
          aria-label="Feather"
          value={options.feather ?? 0}
          onChange={(e) => set({ feather: Math.max(0, Number(e.target.value) || 0) })}
          className={numberInput}
        />
        px
      </label>
      {controller.segmentationProvider && (
        <form
          data-testid="select-subject"
          className="flex flex-col gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            void selectSubject();
          }}
        >
          <div className="flex gap-1">
            <input
              type="text"
              aria-label="Subject to select"
              placeholder="Subject, e.g. the dog"
              value={subject}
              disabled={segmenting}
              onChange={(e) => setSubject(e.currentTarget.value)}
              className="min-w-0 flex-1 bg-background border border-border rounded px-2 py-1 text-foreground"
            />
            <button type="submit" className={btn(false)} disabled={segmenting || !subject.trim()} aria-busy={segmenting}>
              {segmenting ? 'Selecting…' : 'Select Subject'}
            </button>
          </div>
          {subjectStatus && (
            <p role="status" className="text-muted-foreground">
              {subjectStatus}
            </p>
          )}
        </form>
      )}
      <label className="flex items-center gap-2 text-foreground">
        <ImageCheckbox label="Anti-alias" checked={options.antiAlias} onChange={(on) => set({ antiAlias: on })} />
        Anti-alias
      </label>
      <div className="flex flex-wrap gap-1">
        <button type="button" className={btn(false)} onClick={() => controller.selectAll()}>
          Select All
        </button>
        <button type="button" className={btn(false)} disabled={!sel} onClick={() => controller.deselect()}>
          Deselect
        </button>
        <button type="button" className={btn(false)} onClick={() => controller.invertSelection()}>
          Inverse
        </button>
        <button type="button" className={btn(false)} disabled={!controller.canReselect()} onClick={() => controller.reselect()}>
          Reselect
        </button>
        <button type="button" className={btn(false)} disabled={!sel} title="Add connected pixels of a selected colour (wand tolerance)" onClick={() => void runColor('grow')}>
          Grow
        </button>
        <button type="button" className={btn(false)} disabled={!sel} title="Add every pixel of a selected colour (wand tolerance)" onClick={() => void runColor('similar')}>
          Similar
        </button>
      </div>
      <div role="group" aria-label="Show selection" className="flex flex-wrap items-center gap-1">
        <span className="text-muted-foreground">Show</span>
        {DISPLAYS.map((d) => (
          <button key={d.id} type="button" aria-pressed={display === d.id} className={btn(display === d.id)} onClick={() => controller.setSelectionDisplay(d.id)}>
            {d.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <label className="flex items-center gap-1 text-muted-foreground">
          Radius
          <input
            type="number"
            min={0}
            max={500}
            step={1}
            aria-label="Modify radius"
            value={radius}
            onChange={(e) => setRadius(Math.max(0, Number(e.target.value) || 0))}
            className={numberInput}
          />
        </label>
        {MODIFY_OPS.map(({ op, label }) => (
          <button key={op} type="button" className={btn(false)} disabled={!sel} onClick={() => controller.modifySelection(op, radius)}>
            {label}
          </button>
        ))}
      </div>
      <div role="group" aria-label="Edit selection" className="flex flex-wrap items-center gap-1">
        <label className="flex items-center gap-1 text-muted-foreground">
          Stroke
          <input
            type="number"
            min={1}
            max={250}
            step={1}
            aria-label="Stroke width"
            value={strokeWidth}
            onChange={(e) => setStrokeWidth(Math.min(250, Math.max(1, Number(e.target.value) || 1)))}
            className={numberInput}
          />
          px
        </label>
        <ImageSelect
          label="Stroke location"
          value={strokeLocation}
          options={[
            { value: 'outside', label: 'Outside' },
            { value: 'center', label: 'Center' },
            { value: 'inside', label: 'Inside' },
          ]}
          onChange={(v) => setStrokeLocation(v as 'inside' | 'center' | 'outside')}
        />
        <button type="button" className={btn(false)} disabled={!sel} onClick={() => edit(() => controller.strokeSelection({ width: strokeWidth, location: strokeLocation }))}>
          Stroke
        </button>
        <button type="button" className={btn(false)} disabled={!sel} onClick={() => edit(() => controller.cropToSelection())}>
          Crop to Selection
        </button>
        <button type="button" className={btn(false)} disabled={!sel} onClick={() => edit(() => controller.contentAwareFill({ output: 'new-layer' }))}>
          Content-Aware Fill
        </button>
      </div>
      <div role="group" aria-label="Clipboard" className="flex flex-wrap gap-1">
        <button type="button" className={btn(false)} onClick={() => edit(() => controller.copyPixels())}>
          Copy
        </button>
        <button type="button" className={btn(false)} onClick={() => edit(() => controller.copyPixels({ merged: true }))}>
          Copy Merged
        </button>
        <button type="button" className={btn(false)} disabled={!sel} onClick={() => edit(() => controller.cutPixels())}>
          Cut
        </button>
        <button type="button" className={btn(false)} onClick={() => edit(() => controller.pastePixels('new-layer'))}>
          Paste
        </button>
        <button type="button" className={btn(false)} onClick={() => edit(() => controller.pastePixels('in-place'))}>
          Paste in Place
        </button>
        <button type="button" className={btn(false)} disabled={!sel} onClick={() => edit(() => controller.pastePixels('into'))}>
          Paste Into
        </button>
        <button type="button" className={btn(false)} disabled={!sel} onClick={() => edit(() => controller.pastePixels('outside'))}>
          Paste Outside
        </button>
      </div>
      {colorStatus && (
        <p role="status" className="text-muted-foreground">
          {colorStatus}
        </p>
      )}
      <p data-testid="selection-status" className="text-muted-foreground">
        {describeSelection(sel)}
      </p>
    </div>
  );
};
