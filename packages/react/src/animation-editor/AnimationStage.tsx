import React, { useMemo } from 'react';
import { highlightMotionSvg, motionNodeAtElement, type AnimationEditorController, type MotionFrameOptions, type MotionOnionSkin } from '@pixerate/editor/animation-editor';
import { useAnimationEditorState } from './useAnimationEditor';

export interface AnimationStageProps {
  controller: AnimationEditorController;
  /** Control values to preview (`{ accent: "#0ea5e9" }`). */
  values?: MotionFrameOptions['values'];
  /** Faded frames either side of the playhead. */
  onionSkin?: MotionOnionSkin;
  /** Draw where nodes travel: true for every node whose place changes, or a list of ids. */
  motionPaths?: boolean | readonly string[];
  /**
   * Called when the stage is clicked, with the id of the artwork node under the pointer (the
   * innermost one; null for the background, ghosts and paths). Makes the stage pickable.
   */
  onPick?: (id: string | null, event: React.MouseEvent<HTMLDivElement>) => void;
  /** Node ids to outline (e.g. the picked element and the selected command's targets). */
  highlight?: readonly string[];
  className?: string;
}

/**
 * The animation's frame at the playhead, drawn as inline SVG scaled to the stage's width. The
 * SVG keeps the artwork's node ids, so `onPick` can say which element was clicked.
 */
export function AnimationStage({ controller, values, onionSkin, motionPaths, onPick, highlight, className = '' }: AnimationStageProps) {
  const state = useAnimationEditorState(controller);
  const { scene, time } = state;
  const key = highlight?.join('\u0000') ?? '';
  const svg = useMemo(
    () =>
      highlightMotionSvg(
        controller.toSvg(time, { pretty: false, idPrefix: 'ae-', values, onionSkin, motionPaths }).replace(/<svg ([^>]*?)width="[^"]*" height="[^"]*"/, '<svg $1width="100%" height="100%"'),
        highlight ?? [],
      ),
    [controller, scene, time, values, onionSkin, motionPaths, key],
  );
  return (
    <div
      className={`relative overflow-hidden ${onPick ? 'cursor-crosshair' : ''} ${className}`}
      style={{ aspectRatio: `${scene.artwork.width} / ${scene.artwork.height}` }}
      data-animation-stage=""
      role="img"
      aria-label={`${scene.name} at ${(time / 1000).toFixed(2)} s`}
      onClick={onPick ? (e) => onPick(motionNodeAtElement(scene, e.target as Element, e.currentTarget), e) : undefined}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
