import React, { useMemo, useRef, useState } from 'react';
import type { AgentPlayback, PlaybackRect, PlaybackRef } from '@pixerate/editor/tools';
import { useAgentPlayback } from '../playback/AgentPlaybackContext';
import { usePlaybackSurface } from '../playback/usePlaybackSurface';
import { PresenceLayer } from '../playback/PresenceLayer';
import { indexMotionNodes, motionIssueLine, type AnimationEditorController, type MotionFrameOptions, type MotionOnionSkin } from '@pixerate/editor/animation-editor';
import { AnimationStage } from './AnimationStage';
import { CommandInspector } from './CommandInspector';
import { CommandList } from './CommandList';
import { PlayheadScrubber } from './PlayheadScrubber';
import { SceneSettings } from './SceneSettings';
import { ShotInspector } from './ShotInspector';
import { useAnimationEditorState } from './useAnimationEditor';
import type { EffectProvider } from '@pixerate/editor/effects';
import { useEffects } from '../effects';
import { AnimationEffectsPanel } from './AnimationEffectsPanel';

export interface AnimationEditorProps {
  controller: AnimationEditorController;
  values?: MotionFrameOptions['values'];
  /** Faded frames either side of the playhead (see `<AnimationStage onionSkin>`). Default: an Onion skin toggle. */
  onionSkin?: MotionOnionSkin;
  /** Draw where nodes travel (see `<AnimationStage motionPaths>`). Default: a Motion paths toggle. */
  motionPaths?: boolean | readonly string[];
  /** List the scene's issues under the timeline (default true). */
  showIssues?: boolean;
  /**
   * Show the hand-editing panels: the command list and inspector, the shot inspector, scene
   * settings, undo / redo and picking on the stage (default true). False shows the stage,
   * scrubber and issues only.
   */
  editable?: boolean;
  /**
   * An effects provider (see `@pixerate/editor/effects`), registered with the controller while
   * mounted: provider motion applied to the picked element and vector effects, with an Effects
   * panel. Optional: without one the editor is as before.
   */
  effects?: EffectProvider | null;
  className?: string;
  /**
   * Agent playback: act out the animation tools' calls here with the agent's cursor (default: the
   * nearest `AgentPlaybackProvider`; `null` turns it off).
   */
  playback?: AgentPlayback | null;
  /** The playback surface id (default `animation`, where the animation tool providers play). */
  playbackId?: string;
  /** Bring the editor on screen (switch to its tab) before the agent acts. */
  onPlaybackReveal?: () => void | Promise<void>;
}

const ONION: MotionOnionSkin = { before: 3, after: 1 };
const btn = 'rounded border border-border px-2 py-0.5 text-xs disabled:opacity-40';

/**
 * A whole animation editor for an `AnimationEditorController`: the stage (click an element to
 * pick it, shift-click to add it to or remove it from the selected command's targets), the
 * playhead scrubber, and panels to edit commands, shots and scene settings by hand. Every edit
 * is one undo step.
 */
export function AnimationEditor({ controller, values, onionSkin, motionPaths, showIssues = true, editable = true, effects, className = '', playback, playbackId = 'animation', onPlaybackReveal }: AnimationEditorProps) {
  const state = useAnimationEditorState(controller);

  // Agent playback: the agent's cursor in pixels of the editor's box, finding shots in the
  // timeline and elements on the stage (whose SVG keeps the artwork's ids, prefixed `ae-`).
  const rootRef = useRef<HTMLDivElement>(null);
  const ambientPlayback = useAgentPlayback();
  const playing = (playback === undefined ? ambientPlayback : playback) ?? null;
  const rectIn = (el: Element | null | undefined): PlaybackRect | null => {
    const box = rootRef.current?.getBoundingClientRect();
    const r = el?.getBoundingClientRect();
    return box && r && r.width > 0 ? { x: r.left - box.left, y: r.top - box.top, width: r.width, height: r.height } : null;
  };
  const agentPresence = usePlaybackSurface(playing, playbackId, {
    defaultKind: 'shot',
    locate: (ref: PlaybackRef) => {
      const root = rootRef.current;
      if (!root) return null;
      if (ref.kind === 'shot') return rectIn(root.querySelector(`[data-shot="${CSS.escape(ref.id)}"]`));
      if (ref.kind === 'element') return rectIn(root.querySelector(`[data-animation-stage] [id="ae-${CSS.escape(ref.id)}"]`));
      return null;
    },
    bounds: () => {
      const r = rootRef.current?.getBoundingClientRect();
      return r && r.width > 0 ? { x: 0, y: 0, width: r.width, height: r.height } : null;
    },
    visible: () => {
      const r = rootRef.current?.getBoundingClientRect();
      return !!r && r.width > 0 && r.height > 0 && !(typeof document !== 'undefined' && document.visibilityState === 'hidden');
    },
    toViewport: (p) => {
      const r = rootRef.current?.getBoundingClientRect();
      return { x: (r?.left ?? 0) + p.x, y: (r?.top ?? 0) + p.y };
    },
    fromViewport: (p) => {
      const r = rootRef.current?.getBoundingClientRect();
      return { x: p.x - (r?.left ?? 0), y: p.y - (r?.top ?? 0) };
    },
    reveal: () => onPlaybackReveal?.(),
  });
  const presenceLayer = playing ? <PresenceLayer presence={agentPresence} /> : null;
  useEffects(controller, effects);
  const { issues, scene, selection, readOnly } = state;
  const [picked, setPicked] = useState<string | null>(null);
  const [onion, setOnion] = useState(false);
  const [paths, setPaths] = useState(false);
  const command = selection?.command !== undefined ? scene.shots.find((s) => s.id === selection.shot)?.run[selection.command] : undefined;
  const targets = command && 'targets' in command ? command.targets : [];
  const nodes = useMemo(() => indexMotionNodes(scene.artwork.nodes), [scene.artwork]);
  const pickedValid = picked && nodes.has(picked) ? picked : null;
  const onPick = (id: string | null, event: { shiftKey: boolean }) => {
    if (event.shiftKey && id && command && 'targets' in command && selection?.command !== undefined && !readOnly) {
      const next = targets.includes(id) ? targets.filter((t) => t !== id) : [...targets, id];
      if (next.length) controller.apply({ op: 'update_command', shot: selection.shot, command: selection.command, set: { targets: next } }, next.length > targets.length ? 'Add target' : 'Remove target');
      return;
    }
    setPicked(id);
  };
  const stage = (
    <AnimationStage
      controller={controller}
      values={values}
      onionSkin={onionSkin ?? (onion ? ONION : undefined)}
      motionPaths={motionPaths ?? paths}
      onPick={editable ? onPick : undefined}
      highlight={editable ? [...(pickedValid ? [pickedValid] : []), ...targets] : undefined}
      className="rounded-md border border-border bg-muted/40"
    />
  );
  const issueList = showIssues && issues.length > 0 && (
    <ul className="space-y-0.5 text-xs" aria-label="Animation issues">
      {issues.map((issue, i) => (
        <li key={i} className={issue.severity === 'error' ? 'text-red-500' : issue.severity === 'warning' ? 'text-amber-500' : 'text-muted-foreground'}>
          {motionIssueLine(issue)}
        </li>
      ))}
    </ul>
  );
  if (!editable)
    return (
      <div ref={rootRef} className={`relative flex flex-col gap-2 ${className}`} data-animation-editor="">
        {presenceLayer}
        {stage}
        <PlayheadScrubber controller={controller} />
        {issueList}
      </div>
    );

  return (
    <div
      ref={rootRef}
      className={`relative grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem] ${className}`}
      data-animation-editor=""
      onKeyDown={(e) => {
        const el = e.target as HTMLElement;
        if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
        e.preventDefault();
        if (e.shiftKey) controller.redo();
        else controller.undo();
      }}
    >
      {presenceLayer}
      <div className="flex min-w-0 flex-col gap-2">
        {stage}
        <PlayheadScrubber controller={controller} />
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <button type="button" className={btn} onClick={() => controller.undo()} disabled={!state.canUndo} title={state.canUndo ? `Undo ${state.undoLabel}` : 'Nothing to undo'} data-undo="">
            Undo
          </button>
          <button type="button" className={btn} onClick={() => controller.redo()} disabled={!state.canRedo} title={state.canRedo ? `Redo ${state.redoLabel}` : 'Nothing to redo'} data-redo="">
            Redo
          </button>
          {onionSkin === undefined && (
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={onion} onChange={(e) => setOnion(e.target.checked)} /> Onion skin
            </label>
          )}
          {motionPaths === undefined && (
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={paths} onChange={(e) => setPaths(e.target.checked)} /> Motion paths
            </label>
          )}
          <span className="ml-auto" data-picked-element={pickedValid ?? undefined}>
            {pickedValid ? (
              <>
                Picked <code className="text-rose-500">{pickedValid}</code>{' '}
                <button type="button" className="underline" onClick={() => setPicked(null)}>
                  clear
                </button>
              </>
            ) : (
              'Click the stage to pick an element; shift-click to toggle it as a target.'
            )}
          </span>
        </div>
        {issueList}
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <CommandList controller={controller} targets={pickedValid ? [pickedValid] : undefined} />
        {(state.effectsProvider || controller.appliedEffects().length > 0) && <AnimationEffectsPanel controller={controller} node={pickedValid} className="border-t border-border pt-2" />}
        <CommandInspector controller={controller} picked={pickedValid} className="border-t border-border pt-2" />
        <details open className="border-t border-border pt-2">
          <summary className="cursor-pointer text-xs font-medium">Shot</summary>
          <ShotInspector controller={controller} className="mt-1" />
        </details>
        <details className="border-t border-border pt-2">
          <summary className="cursor-pointer text-xs font-medium">Scene settings</summary>
          <SceneSettings controller={controller} className="mt-1" />
        </details>
      </div>
    </div>
  );
}
