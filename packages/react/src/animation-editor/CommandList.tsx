import React, { useState } from 'react';
import {
  MOTION_COMMAND_TYPES,
  defaultMotionCommand,
  duplicateMotionCommandEdit,
  motionCommandRows,
  type AnimationEditorController,
  type MotionCommandType,
} from '@pixerate/editor/animation-editor';
import { useAnimationEditorState } from './useAnimationEditor';

export interface CommandListProps {
  controller: AnimationEditorController;
  /** The shot to list (default: the selected shot, else the first). */
  shot?: string;
  /** Targets for a new command (e.g. the element picked on the stage); default: the selected command's. */
  targets?: readonly string[];
  className?: string;
}

const btn = 'rounded border border-border px-1.5 py-0.5 text-[11px] disabled:opacity-40';

/**
 * A shot's commands in order: select one to inspect it, change `with` and `delay` inline, move,
 * duplicate or delete it, and add new ones. Each change is one `controller.apply` edit (one undo
 * step); a refused edit shows its reason.
 */
export function CommandList({ controller, shot, targets, className = '' }: CommandListProps) {
  const state = useAnimationEditorState(controller);
  const { scene, selection, readOnly, error } = state;
  const shotId = shot ?? selection?.shot ?? scene.shots[0]?.id;
  const current = scene.shots.find((s) => s.id === shotId);
  const [type, setType] = useState<MotionCommandType>('enter');
  const [local, setLocalState] = useState<{ text: string; revision: number } | null>(null);
  const setLocal = (text: string | null) => setLocalState(text ? { text, revision: state.revision } : null);
  if (!current) return <div className={`text-xs text-muted-foreground ${className}`} data-command-list="">Add a shot to start.</div>;
  const rows = motionCommandRows(scene, current.id);
  const selected = selection?.shot === current.id ? selection.command : undefined;
  const run = (edit: Parameters<AnimationEditorController['apply']>[0], label: string) => {
    setLocal(null);
    return controller.apply(edit, label);
  };
  const add = () => {
    const from = targets?.length ? targets : selected !== undefined ? ((current.run[selected] as { targets?: string[] }).targets ?? []) : [];
    const command = defaultMotionCommand(type, from, scene);
    if ('error' in command) return setLocal(command.error);
    const at = selected !== undefined ? selected + 1 : current.run.length;
    const result = run({ op: 'add_commands', shot: current.id, commands: [command], at }, `Add ${type}`);
    if (result.ok) controller.select({ shot: current.id, command: at });
  };
  // A local error shows until the editor changes; then the editor's own error (if any) shows.
  const message = (local && local.revision === state.revision ? local.text : null) ?? error;

  return (
    <div className={`flex flex-col gap-1 text-xs ${className}`} data-command-list="" data-for-shot={current.id}>
      <div className="font-medium">
        Commands in <span className="text-rose-500">{current.label ?? current.id}</span>
      </div>
      <ol className="flex flex-col gap-1" aria-label="Commands">
        {rows.map((row) => {
          const c = row.command as { with?: string; delay?: number };
          const isSelected = row.index === selected;
          return (
            <li
              key={`${row.index}:${row.summary}`}
              className={`flex flex-wrap items-center gap-1 rounded border px-1.5 py-1 ${isSelected ? 'border-rose-500 bg-rose-500/10' : 'border-border'}`}
              data-command={row.index}
              data-selected={isSelected || undefined}
              onClick={() => controller.select({ shot: current.id, command: row.index })}
            >
              <span className="min-w-0 flex-1 truncate" title={row.summary}>
                {row.index + 1}. {row.summary}
              </span>
              {row.flairPrimitive && (
                <code className="rounded bg-muted px-1 text-[10px] text-muted-foreground" data-flair-primitive={row.flairPrimitive}>
                  {row.flairPrimitive}
                </code>
              )}
              <span className="tabular-nums text-[10px] text-muted-foreground">{((row.end - row.start) / 1000).toFixed(2)} s</span>
              <div className="flex w-full items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <select
                  className="rounded border border-border bg-transparent px-1 py-0.5 text-[11px]"
                  aria-label="Starts"
                  value={c.with ?? 'after'}
                  disabled={readOnly || row.index === 0}
                  onChange={(e) =>
                    run(
                      e.target.value === 'after' ? { op: 'update_command', shot: current.id, command: row.index, remove: ['with'] } : { op: 'update_command', shot: current.id, command: row.index, set: { with: e.target.value } },
                      'Change start',
                    )
                  }
                >
                  <option value="after">after previous</option>
                  <option value="previous">with previous</option>
                </select>
                <label className="flex items-center gap-0.5 text-muted-foreground">
                  +
                  <input
                    key={String(c.delay ?? '')}
                    className="w-14 rounded border border-border bg-transparent px-1 py-0.5 text-[11px] tabular-nums"
                    type="number"
                    min={0}
                    step={50}
                    aria-label="Delay"
                    placeholder="0"
                    defaultValue={c.delay ?? ''}
                    disabled={readOnly}
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                    onBlur={(e) => {
                      const raw = e.currentTarget.value.trim();
                      if (raw === String(c.delay ?? '')) return;
                      const n = Number(raw);
                      if (raw && !(Number.isFinite(n) && n >= 0)) return setLocal('Delay must be a number of ms, 0 or more.');
                      run(raw && n > 0 ? { op: 'update_command', shot: current.id, command: row.index, set: { delay: n } } : { op: 'update_command', shot: current.id, command: row.index, remove: ['delay'] }, 'Change delay');
                    }}
                  />
                  ms
                </label>
                <span className="ml-auto flex gap-0.5">
                  <button type="button" className={btn} aria-label="Move up" disabled={readOnly || row.index === 0} onClick={() => run({ op: 'move_command', shot: current.id, command: row.index, to: row.index - 1 }, 'Move command').ok && controller.select({ shot: current.id, command: row.index - 1 })}>
                    ↑
                  </button>
                  <button type="button" className={btn} aria-label="Move down" disabled={readOnly || row.index === rows.length - 1} onClick={() => run({ op: 'move_command', shot: current.id, command: row.index, to: row.index + 1 }, 'Move command').ok && controller.select({ shot: current.id, command: row.index + 1 })}>
                    ↓
                  </button>
                  <button type="button" className={btn} aria-label="Duplicate" disabled={readOnly} onClick={() => run(duplicateMotionCommandEdit(scene, current.id, row.index), 'Duplicate command').ok && controller.select({ shot: current.id, command: row.index + 1 })}>
                    ⧉
                  </button>
                  <button type="button" className={btn} aria-label="Delete" disabled={readOnly} onClick={() => run({ op: 'delete_commands', shot: current.id, commands: [row.index] }, 'Delete command')}>
                    ✕
                  </button>
                </span>
              </div>
            </li>
          );
        })}
      </ol>
      {!readOnly && (
        <div className="flex items-center gap-1">
          <select className="flex-1 rounded border border-border bg-transparent px-1 py-0.5" aria-label="New command type" value={type} onChange={(e) => setType(e.target.value as MotionCommandType)}>
            {MOTION_COMMAND_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button type="button" className={btn} onClick={add} data-add-command="">
            Add command
          </button>
        </div>
      )}
      {message && (
        <p className="text-red-500" role="alert" data-edit-error="">
          {message}
        </p>
      )}
    </div>
  );
}
