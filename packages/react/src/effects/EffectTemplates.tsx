import React, { useEffect, useState } from 'react';
import { checkTemplateValues, isSubjectTemplateSlot, type EffectProvider, type EffectTemplateDescription, type EffectTemplateSlot, type EffectTemplateSummary } from '@pixerate/editor/effects';

export interface EffectTemplatesProps {
  /** The effects provider; nothing shows unless it has templates. */
  provider: EffectProvider | null | undefined;
  /**
   * Fills the chosen template (the editor's `fillTemplate`). Resolves `{ ok: false, error }` to
   * show the refusal; on success the form closes.
   */
  onFill: (template: string, values: Record<string, unknown>) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** The button that fills (default "Use template"). */
  fillLabel?: string;
  disabled?: boolean;
  className?: string;
}

const input = 'w-full min-w-0 rounded border border-border bg-transparent px-1 py-0.5 text-xs';
const btn = 'rounded border border-border px-2 py-0.5 text-[11px] disabled:opacity-40';

/** One slot's field. Text, colour and number slots start from their defaults; subject slots from empty (the default picture, or left open). */
function SlotField({ slot, value, error, onChange }: { slot: EffectTemplateSlot; value: unknown; error?: string; onChange: (v: unknown) => void }) {
  const id = `template-slot-${slot.name}`;
  let field: React.ReactNode;
  if (slot.type === 'color') field = <input id={id} className="h-6 w-10" type="color" value={String(value)} onChange={(e) => onChange(e.target.value)} />;
  else if (slot.type === 'number')
    field = <input id={id} className={input} type="number" min={slot.min} max={slot.max} step={slot.integer ? 1 : 'any'} value={String(value)} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
  else if (slot.type === 'text')
    field = (
      <div className="flex items-center gap-1">
        <input id={id} className={input} maxLength={slot.maxLength} value={String(value)} onChange={(e) => onChange(e.target.value)} />
        {slot.maxLength !== undefined && <span className="text-[10px] text-muted-foreground">{String(value).length}/{slot.maxLength}</span>}
      </div>
    );
  else
    field = (
      <input
        id={id}
        className={input}
        placeholder={slot.hasDefault ? 'URL or <svg> (default: a placeholder)' : 'URL or <svg> (empty: left open)'}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  return (
    <div className="flex flex-col gap-0.5" data-template-slot={slot.name}>
      <label htmlFor={id} className="text-muted-foreground" title={slot.description}>
        {slot.label}
      </label>
      {field}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}

/**
 * The provider's sequence templates: pick one, fill its slots in a form (built from
 * `describeTemplate`, checked with `checkTemplateValues` as you type) and use it. Hidden when the
 * provider has no templates.
 */
export function EffectTemplates({ provider, onFill, fillLabel = 'Use template', disabled = false, className = '' }: EffectTemplatesProps) {
  const [templates, setTemplates] = useState<readonly EffectTemplateSummary[]>([]);
  const [chosen, setChosen] = useState('');
  const [description, setDescription] = useState<EffectTemplateDescription | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = !!provider?.capabilities.supportsTemplates && !!provider.listTemplates && !!provider.describeTemplate;

  useEffect(() => {
    let live = true;
    setTemplates([]);
    setChosen('');
    if (supported) void Promise.resolve(provider!.listTemplates!()).then((t) => live && setTemplates(t), () => live && setTemplates([]));
    return () => {
      live = false;
    };
  }, [provider, supported]);

  useEffect(() => {
    let live = true;
    setDescription(null);
    setMessage(null);
    if (!chosen || !supported) return;
    void Promise.resolve(provider!.describeTemplate!(chosen)).then(
      (d) => {
        if (!live) return;
        setDescription(d);
        setValues(Object.fromEntries(d.slots.map((s) => [s.name, isSubjectTemplateSlot(s) ? '' : (s as { default: unknown }).default])));
      },
      (e: Error) => live && setMessage(e.message)
    );
    return () => {
      live = false;
    };
  }, [provider, supported, chosen]);

  if (!supported || !templates.length) return null;
  // Empty subject fields are left out (their default, or left open); empty numbers too.
  const given = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''));
  const problems = description ? checkTemplateValues(description.slots, given) : [];
  const problemFor = (slot: string) => problems.find((p) => p.startsWith(`Slot "${slot}"`));
  const fill = async () => {
    if (!description || problems.length) return;
    setBusy(true);
    const r = await onFill(description.id, given);
    setBusy(false);
    if (r.ok) setChosen('');
    else setMessage(r.error);
  };
  return (
    <div className={`flex flex-col gap-1 text-xs ${className}`} data-effect-templates="">
      <select className={input} aria-label="Template" disabled={disabled} value={chosen} onChange={(e) => setChosen(e.target.value)}>
        <option value="">Templates…</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} ({t.shots} shots)
          </option>
        ))}
      </select>
      {description && (
        <form
          className="flex flex-col gap-1 rounded border border-border p-1"
          data-template-form={description.id}
          onSubmit={(e) => {
            e.preventDefault();
            void fill();
          }}
        >
          <p className="text-[11px] text-muted-foreground">{description.description}</p>
          {description.slots.map((slot) => (
            <SlotField key={slot.name} slot={slot} value={values[slot.name] ?? ''} error={problemFor(slot.name)} onChange={(v) => setValues({ ...values, [slot.name]: v })} />
          ))}
          <div className="flex gap-1">
            <button type="submit" className={btn} disabled={disabled || busy || problems.length > 0}>
              {fillLabel}
            </button>
            <button type="button" className={btn} onClick={() => setChosen('')}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {message && (
        <p role="alert" className="text-[11px] text-destructive">
          {message}
        </p>
      )}
    </div>
  );
}
