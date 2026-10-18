import React, { useMemo, useState } from 'react';
import {
  describeMotionElements,
  motionCommandFields,
  motionFieldEdit,
  motionFlairPrimitive,
  type AnimationEditorController,
  type MotionFieldSpec,
} from '@pixerate/editor/animation-editor';
import { EasePicker } from './EasePicker';
import { CommitInput } from './CommitInput';
import { useAnimationEditorState } from './useAnimationEditor';

export interface CommandInspectorProps {
  controller: AnimationEditorController;
  /** An element picked on the stage, offered as a target to add. */
  picked?: string | null;
  className?: string;
}

const input = 'w-full min-w-0 rounded border border-border bg-transparent px-1 py-0.5 text-xs';


/**
 * A form for the selected command, generated from `MOTION_COMMAND_SCHEMA` (the schema the
 * agent tools take): enums as selects, numbers with their units and limits, node pickers for
 * targets and for `into` / `path`, and an ease picker. Shows the Flair primitive it plays.
 */
export function CommandInspector({ controller, picked, className = '' }: CommandInspectorProps) {
  const state = useAnimationEditorState(controller);
  const { scene, selection, readOnly, error } = state;
  const [local, setLocalState] = useState<{ text: string; revision: number } | null>(null);
  const setLocal = (text: string | null) => setLocalState(text ? { text, revision: state.revision } : null);
  const elements = useMemo(() => describeMotionElements(scene), [scene.artwork]);
  const shot = selection ? scene.shots.find((s) => s.id === selection.shot) : undefined;
  const index = selection?.command;
  const command = shot && index !== undefined ? shot.run[index] : undefined;
  if (!shot || index === undefined || !command) {
    return (
      <div className={`text-xs text-muted-foreground ${className}`} data-command-inspector="">
        Select a command to edit it.
      </div>
    );
  }
  const values = command as unknown as Record<string, unknown>;
  const fields = motionCommandFields(command.type);
  const primitive = motionFlairPrimitive(command);
  const commit = (field: MotionFieldSpec, raw: Parameters<typeof motionFieldEdit>[3]) => {
    const edit = motionFieldEdit(shot.id, index, field, raw);
    if ('error' in edit) return setLocal(edit.error);
    setLocal(null);
    controller.apply(edit, `Set ${field.label.toLowerCase()}`);
  };
  const name = (id: string) => elements.find((e) => e.id === id)?.name ?? id;
  const targets = (values.targets as string[] | undefined) ?? [];
  // A local error shows until the editor changes; then the editor's own error (if any) shows.
  const message = (local && local.revision === state.revision ? local.text : null) ?? error;

  const control = (field: MotionFieldSpec) => {
    const v = values[field.name];
    const common = { disabled: readOnly, 'aria-label': field.label, title: field.description };
    switch (field.kind) {
      case 'targets':
        return (
          <div className="flex flex-wrap items-center gap-1" data-targets="">
            {targets.map((id) => (
              <span key={id} className="flex items-center gap-0.5 rounded bg-muted px-1 text-[11px]" data-target={id}>
                {name(id)}
                {!readOnly && targets.length > 1 && (
                  <button type="button" aria-label={`Remove ${id}`} onClick={() => commit(field, targets.filter((t) => t !== id))}>
                    ×
                  </button>
                )}
              </span>
            ))}
            {!readOnly && picked && !targets.includes(picked) && (
              <button type="button" className="rounded border border-rose-500 px-1 text-[11px] text-rose-500" onClick={() => commit(field, [...targets, picked])} data-add-picked="">
                + {name(picked)}
              </button>
            )}
            {!readOnly && (
              <select className="rounded border border-border bg-transparent px-1 py-0.5 text-[11px]" aria-label="Add target" value="" onChange={(e) => e.target.value && commit(field, [...targets, e.target.value])}>
                <option value="">+ target…</option>
                {elements.filter((e) => !targets.includes(e.id)).map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name ? `${e.name} (${e.id})` : e.id}
                  </option>
                ))}
              </select>
            )}
          </div>
        );
      case 'node':
        return (
          <select className={input} {...common} value={typeof v === 'string' ? v : ''} onChange={(e) => commit(field, e.target.value)}>
            {!field.required && <option value="">—</option>}
            {elements.filter((e) => field.name !== 'path' || e.type === 'path').map((e) => (
              <option key={e.id} value={e.id}>
                {e.name ? `${e.name} (${e.id})` : e.id}
                {e.hidden ? ' · hidden' : ''}
              </option>
            ))}
          </select>
        );
      case 'enum':
        return (
          <select className={input} {...common} value={typeof v === 'string' ? v : ''} onChange={(e) => commit(field, e.target.value)}>
            {!field.required && <option value="">default</option>}
            {field.options!.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        );
      case 'boolean':
        return <input type="checkbox" {...common} checked={v === true} onChange={(e) => commit(field, e.target.checked)} />;
      case 'ease':
        return <EasePicker value={v as never} disabled={readOnly} onChange={(ease) => commit(field, ease === undefined ? '' : (ease as string))} />;
      case 'color':
        return (
          <div className="flex items-center gap-1">
            <input type="color" disabled={readOnly} aria-label={`${field.label} swatch`} value={typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : '#000000'} onChange={(e) => commit(field, e.target.value)} />
            <CommitInput className={input} {...common} value={typeof v === 'string' ? v : ''} placeholder="unchanged" onCommit={(raw) => commit(field, raw)} />
          </div>
        );
      case 'point': {
        const p = (v as { x: number; y: number } | undefined) ?? undefined;
        return (
          <div className="flex items-center gap-1">
            {(['x', 'y'] as const).map((axis) => (
              <CommitInput
                key={axis}
                className={input}
                type="number"
                disabled={readOnly}
                aria-label={`${field.label} ${axis}`}
                placeholder={axis}
                value={p ? String(p[axis]) : ''}
                onCommit={(raw) => commit(field, axis === 'x' ? { x: raw, y: p ? String(p.y) : raw ? '0' : '' } : { x: p ? String(p.x) : raw ? '0' : '', y: raw })}
              />
            ))}
          </div>
        );
      }
      case 'scale':
      case 'number':
      case 'integer':
        return (
          <div className="flex items-center gap-1">
            <CommitInput
              className={input}
              type="number"
              {...common}
              min={field.min}
              max={field.max}
              step={field.kind === 'integer' ? 1 : field.unit === 'ms' ? 50 : field.unit === '0–1' ? 0.05 : 'any'}
              placeholder="default"
              value={typeof v === 'number' ? String(v) : ''}
              onCommit={(raw) => commit(field, raw)}
            />
            {field.unit && <span className="shrink-0 text-[10px] text-muted-foreground">{field.unit}</span>}
          </div>
        );
      default:
        return <CommitInput className={input} {...common} value={typeof v === 'string' ? v : ''} onCommit={(raw) => commit(field, raw)} />;
    }
  };

  return (
    <div className={`flex flex-col gap-1.5 text-xs ${className}`} data-command-inspector="" data-command-type={command.type}>
      <div className="flex items-center gap-2">
        <span className="font-medium">
          {index + 1}. {command.type}
        </span>
        {primitive ? (
          <code className="rounded bg-muted px-1 text-[10px]" data-flair-primitive={primitive} title="The Flair motion primitive this command plays">
            {primitive}
          </code>
        ) : (
          <span className="text-[10px] text-muted-foreground">editor-only (no Flair primitive)</span>
        )}
      </div>
      {(['main', 'timing'] as const).map((group) => (
        <fieldset key={group} className="grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-1">
          <legend className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{group === 'main' ? 'Command' : 'Timing'}</legend>
          {fields
            .filter((f) => f.group === group)
            .map((field) => (
              <React.Fragment key={field.name}>
                <label className="truncate text-muted-foreground" title={field.description}>
                  {field.label}
                  {field.required ? ' *' : ''}
                </label>
                <div data-field={field.name}>{control(field)}</div>
              </React.Fragment>
            ))}
        </fieldset>
      ))}
      {message && (
        <p className="text-red-500" role="alert" data-edit-error="">
          {message}
        </p>
      )}
    </div>
  );
}
