import React from 'react';
import { motionIssueLine, type AnimationEditorController, type MotionFrameOptions } from '@pixerate/editor/animation-editor';
import { AnimationStage } from './AnimationStage';
import { ShotTimeline } from './ShotTimeline';
import { useAnimationEditorState } from './useAnimationEditor';

export interface AnimationEditorProps {
  controller: AnimationEditorController;
  values?: MotionFrameOptions['values'];
  /** List the scene's issues under the timeline (default true). */
  showIssues?: boolean;
  className?: string;
}

/** Stage, shot timeline and issue list for an `AnimationEditorController`. */
export function AnimationEditor({ controller, values, showIssues = true, className = '' }: AnimationEditorProps) {
  const { issues } = useAnimationEditorState(controller);
  return (
    <div className={`flex flex-col gap-2 ${className}`} data-animation-editor="">
      <AnimationStage controller={controller} values={values} className="rounded-md border border-border bg-muted/40" />
      <ShotTimeline controller={controller} />
      {showIssues && issues.length > 0 && (
        <ul className="space-y-0.5 text-xs" aria-label="Animation issues">
          {issues.map((issue, i) => (
            <li key={i} className={issue.severity === 'error' ? 'text-red-500' : issue.severity === 'warning' ? 'text-amber-500' : 'text-muted-foreground'}>
              {motionIssueLine(issue)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
