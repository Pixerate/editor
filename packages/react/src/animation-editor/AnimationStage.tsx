import React, { useMemo } from 'react';
import type { AnimationEditorController, MotionFrameOptions } from '@pixerate/editor/animation-editor';
import { useAnimationEditorState } from './useAnimationEditor';

export interface AnimationStageProps {
  controller: AnimationEditorController;
  /** Control values to preview (`{ accent: "#0ea5e9" }`). */
  values?: MotionFrameOptions['values'];
  className?: string;
}

/** The animation's frame at the playhead, drawn as inline SVG scaled to the stage's width. */
export function AnimationStage({ controller, values, className = '' }: AnimationStageProps) {
  const state = useAnimationEditorState(controller);
  const { scene, time } = state;
  const svg = useMemo(
    () => controller.toSvg(time, { pretty: false, idPrefix: 'ae-', values }).replace(/<svg ([^>]*?)width="[^"]*" height="[^"]*"/, '<svg $1width="100%" height="100%"'),
    [controller, scene, time, values],
  );
  return (
    <div
      className={`relative overflow-hidden ${className}`}
      style={{ aspectRatio: `${scene.artwork.width} / ${scene.artwork.height}` }}
      data-animation-stage=""
      role="img"
      aria-label={`${scene.name} at ${(time / 1000).toFixed(2)} s`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
