import React, { useId, useRef, useState } from 'react';
import type { AgentPlayback } from '@pixerate/editor/tools';
import { useAgentPlayback } from '../playback/AgentPlaybackContext';
import { useElementPlaybackSurface } from '../playback/useElementPlaybackSurface';
import { PresenceLayer } from '../playback/PresenceLayer';
import {
  isParameterGroup,
  parameterLabel,
  parameterValuesEqual,
  type ParameterField,
  type ParameterGroup,
  type ParameterSchemaItem,
  type ParametersController,
  type ParametersState,
} from '@pixerate/editor/parameters';
import {
  KeyframeDiamond,
  ParameterFieldControl,
  parameterButtonClass,
  parameterInputClass,
  parameterButtonStyle,
  parameterInputStyle,
  parameterSelectStyle,
  type ParameterImageProps,
} from './fields';
import {
  useParameterComponents,
  resolveParameterComponents,
  type ParameterComponents,
} from './controls.js';
import { useParametersState } from './useParameters';

export interface ParametersPanelProps {
  controller: ParametersController;
  /** Heading (default: the schema's title). Pass `null` for none. */
  title?: React.ReactNode;
  /** Undo, redo, reset and randomize buttons (default `true`). */
  showToolbar?: boolean;
  /** The preset picker with save and delete (default `true`). */
  showPresets?: boolean;
  /** Keyframe diamonds (default: when the controller has a keyframes adapter). */
  showKeyframes?: boolean;
  /** Per-field reset buttons on changed values (default `true`). */
  showFieldReset?: boolean;
  /** Turns a picked file into a URL for image fields. */
  resolveFile?: ParameterImageProps['resolveFile'];
  /** Shown when the schema has no fields. */
  emptyMessage?: React.ReactNode;
  className?: string;
  /** Custom host controls (input, slider, select). */
  components?: ParameterComponents;
  /**
   * Agent playback: act out `parameters.*` commands here with the agent's cursor (default: the
   * nearest `AgentPlaybackProvider`; `null` turns it off).
   */
  playback?: AgentPlayback | null;
  /** The playback surface id (default `parameters`, where the parameter commands play). */
  playbackId?: string;
  /** Bring the panel on screen (switch to its tab) before the agent acts. */
  onPlaybackReveal?: () => void | Promise<void>;
}

function FieldRow({
  controller,
  state,
  field,
  idBase,
  showKeyframes,
  showFieldReset,
  resolveFile,
  components,
}: {
  controller: ParametersController;
  state: ParametersState;
  field: ParameterField;
  idBase: string;
  showKeyframes: boolean;
  showFieldReset: boolean;
  resolveFile?: ParameterImageProps['resolveFile'];
  components?: ParameterComponents;
}) {
  const label = parameterLabel(field);
  const inputId = `${idBase}-${field.id}`;
  const value = state.values[field.id];
  const error = state.errors[field.id];
  const changed = !parameterValuesEqual(value, state.defaults[field.id]);
  return (
    <div data-parameter-id={field.id} data-parameter-type={field.type} className="space-y-1">
      <div className="flex min-h-[1.25rem] items-center gap-1.5">
        {showKeyframes && (
          <KeyframeDiamond state={state.keys[field.id] ?? 'none'} label={label} onToggle={() => controller.toggleKeyframe(field.id)} />
        )}
        <label htmlFor={inputId} className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={field.description}>
          {label}
        </label>
        {showFieldReset && changed && !field.readOnly && (
          <button
            type="button"
            className="rounded px-1 text-[11px] text-muted-foreground hover:text-foreground"
            title={`Reset to ${String(state.defaults[field.id])}`}
            aria-label={`Reset ${label}`}
            onClick={() => controller.reset([field.id])}
          >
            ↺
          </button>
        )}
      </div>
      {field.description && <p className="text-[11px] leading-snug text-muted-foreground">{field.description}</p>}
      <ParameterFieldControl
        field={field}
        value={value}
        id={inputId}
        resolveFile={resolveFile}
        components={components}
        onChange={(v) => controller.setValue(field.id, v)}
        onGestureStart={() => controller.beginGesture(field.id)}
        onGestureEnd={() => controller.endGesture()}
      />
      {error && (
        <p role="alert" className="text-[11px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function PresetBar({ controller, state, components }: { controller: ParametersController; state: ParametersState; components?: ParameterComponents }) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const active = state.presets.find((p) => p.name === state.activePreset);
  const CustomPresetSelect = resolveParameterComponents(components, useParameterComponents()).select;

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const result = controller.savePreset(name);
    if (result.ok) {
      setSaving(false);
      setName('');
      setMessage(null);
    } else setMessage(result.message);
  };
  return (
    <div className="space-y-1.5" data-parameter-presets="">
      <div className="flex items-center gap-1.5">
        {CustomPresetSelect ? (
          <CustomPresetSelect
            aria-label="Preset"
            label="Preset"
            className={parameterInputClass}
            style={parameterSelectStyle}
            value={state.activePreset ?? ''}
            options={[
              { value: '', label: state.presets.length ? 'Presets…' : 'No presets' },
              ...state.presets.map((p) => ({ value: p.name, label: p.name, description: p.description })),
            ]}
            onChange={(val) => val && controller.applyPreset(String(val))}
          />
        ) : (
          <select
            aria-label="Preset"
            className={parameterInputClass}
            style={parameterSelectStyle}
            value={state.activePreset ?? ''}
            onChange={(e) => e.target.value && controller.applyPreset(e.target.value)}
          >
            <option value="" style={parameterSelectStyle}>{state.presets.length ? 'Presets…' : 'No presets'}</option>
            {state.presets.map((p) => (
              <option key={p.name} value={p.name} title={p.description} style={parameterSelectStyle}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <button type="button" className={parameterButtonClass} style={parameterButtonStyle} onClick={() => setSaving((s) => !s)} aria-expanded={saving}>
          Save…
        </button>
        {active && !active.builtIn && (
          <button type="button" className={parameterButtonClass} style={parameterButtonStyle} aria-label={`Delete preset ${active.name}`} onClick={() => controller.deletePreset(active.name)}>
            Delete
          </button>
        )}
      </div>
      {saving && (
        <form className="flex items-center gap-1.5" onSubmit={save}>
          <input
            autoFocus
            aria-label="Preset name"
            placeholder="Preset name"
            className={parameterInputClass}
            style={parameterInputStyle}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className={parameterButtonClass} style={parameterButtonStyle}>
            Save
          </button>
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

/**
 * Renders a whole parameter schema: collapsible groups, one control per visible field,
 * keyframe diamonds, per-field reset, presets, and undo / redo / reset / randomize. Slider
 * drags and colour picks are one undo step each.
 */
export function ParametersPanel({
  controller,
  title,
  showToolbar = true,
  showPresets = true,
  showKeyframes,
  showFieldReset = true,
  resolveFile,
  emptyMessage = 'No parameters.',
  className = '',
  components,
  playback,
  playbackId = 'parameters',
  onPlaybackReveal,
}: ParametersPanelProps) {
  const state = useParametersState(controller);
  // Agent playback: the cursor visits the controls a call changes.
  const rootRef = useRef<HTMLDivElement>(null);
  const ambientPlayback = useAgentPlayback();
  const playing = (playback === undefined ? ambientPlayback : playback) ?? null;
  const agentPresence = useElementPlaybackSurface(playing, playbackId, rootRef, {
    defaultKind: 'parameter',
    selectors: { parameter: (id) => `[data-parameter-id="${CSS.escape(id)}"]` },
    reveal: onPlaybackReveal,
  });
  const idBase = useId();
  const keys = showKeyframes ?? state.keyframesEnabled;
  const heading = title === undefined ? state.schema.title : title;

  const renderItems = (items: readonly ParameterSchemaItem[]): React.ReactNode =>
    items.map((item) => {
      if (state.visible[item.id] === false) return null;
      if (isParameterGroup(item)) return renderGroup(item);
      return (
        <FieldRow
          key={item.id}
          controller={controller}
          state={state}
          field={item}
          idBase={idBase}
          showKeyframes={keys}
          showFieldReset={showFieldReset}
          resolveFile={resolveFile}
          components={components}
        />
      );
    });

  const renderGroup = (group: ParameterGroup) => {
    const collapsed = !!state.collapsed[group.id];
    const bodyId = `${idBase}-group-${group.id}`;
    return (
      <section key={group.id} data-parameter-group={group.id} className="rounded-md border border-border">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => controller.toggleCollapsed(group.id)}
          className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs font-semibold text-foreground hover:bg-muted"
        >
          <span aria-hidden="true" className={`inline-block text-[10px] text-muted-foreground transition-transform ${collapsed ? '' : 'rotate-90'}`}>
            ▶
          </span>
          {parameterLabel(group)}
        </button>
        {!collapsed && (
          <div id={bodyId} className="space-y-3 border-t border-border px-2 py-2">
            {group.description && <p className="text-[11px] text-muted-foreground">{group.description}</p>}
            {renderItems(group.fields)}
          </div>
        )}
      </section>
    );
  };

  return (
    <div ref={rootRef} className={`relative space-y-3 text-foreground ${className}`} data-parameters-panel="">
      {(heading || showToolbar) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {heading && <h3 className="mr-auto text-sm font-semibold">{heading}</h3>}
          {showToolbar && (
            <div className="flex flex-wrap gap-1" role="toolbar" aria-label="Parameter actions">
              <button
                type="button"
                className={parameterButtonClass}
                style={parameterButtonStyle}
                disabled={!state.canUndo}
                title={state.canUndo ? `Undo ${state.undoLabel}` : 'Nothing to undo'}
                onClick={() => controller.undo()}
              >
                Undo
              </button>
              <button
                type="button"
                className={parameterButtonClass}
                style={parameterButtonStyle}
                disabled={!state.canRedo}
                title={state.canRedo ? `Redo ${state.redoLabel}` : 'Nothing to redo'}
                onClick={() => controller.redo()}
              >
                Redo
              </button>
              <button
                type="button"
                className={parameterButtonClass}
                style={parameterButtonStyle}
                disabled={!state.modified}
                onClick={() => controller.reset()}
              >
                Reset
              </button>
              <button
                type="button"
                className={parameterButtonClass}
                style={parameterButtonStyle}
                onClick={() => controller.randomize()}
              >
                Randomize
              </button>
            </div>
          )}
        </div>
      )}
      {showPresets && <PresetBar controller={controller} state={state} components={components} />}
      {state.fields.length === 0 ? <p className="text-xs text-muted-foreground">{emptyMessage}</p> : renderItems(state.schema.fields)}
      {/* Last, so it doesn't shift the stacked spacing. */}
      {playing && <PresenceLayer presence={agentPresence} />}
    </div>
  );
}
