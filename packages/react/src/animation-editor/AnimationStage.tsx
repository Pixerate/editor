import React, { useMemo, useRef } from 'react';
import { highlightMotionSvg, motionCameraTransform, motionCameraViewAt, motionNodeAtElement, type AnimationEditorController, type MotionFrameOptions, type MotionOnionSkin, type MotionRecordGestureMode } from '@pixerate/editor/animation-editor';
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
  /**
   * While the controller records a take (`startRecording`), what dragging an element does:
   * `move` it, `scale` it about its centre or `rotate` it (default `move`). Each pointer move
   * is a sample of the take.
   */
  recordMode?: MotionRecordGestureMode;
  className?: string;
}

/**
 * The animation's frame at the playhead, drawn as inline SVG scaled to the stage's width. The
 * SVG keeps the artwork's node ids, so `onPick` can say which element was clicked.
 */
export function AnimationStage({ controller, values, onionSkin, motionPaths, onPick, highlight, recordMode = 'move', className = '' }: AnimationStageProps) {
  const state = useAnimationEditorState(controller);
  const { scene, time, recording } = state;
  const samples = recording?.samples ?? -1;
  const dragging = useRef<number | null>(null);
  const point = (e: React.PointerEvent<HTMLDivElement>) => controller.clientToDocument(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
  const key = highlight?.join('\u0000') ?? '';
  const svg = useMemo(
    () =>
      highlightMotionSvg(
        controller.toSvg(time, { pretty: false, idPrefix: 'ae-', values, onionSkin, motionPaths }).replace(/<svg ([^>]*?)width="[^"]*" height="[^"]*"/, '<svg $1width="100%" height="100%"'),
        highlight ?? [],
      ),
    [controller, scene, time, samples, values, onionSkin, motionPaths, key, state.effectsProvider],
  );
  // A camera move's tilt and turn are 3D, so the stage element turns (its roll and blur are in the SVG).
  const stageRef = useRef<HTMLDivElement | null>(null);
  const view = useMemo(() => motionCameraViewAt(controller.viewScene(), time, state.effectsProvider), [controller, scene, time, samples, state.effectsProvider]);
  const transform = motionCameraTransform(view, stageRef.current?.clientWidth || scene.artwork.width);
  return (
    <div
      ref={stageRef}
      className={`relative overflow-hidden ${recording ? 'cursor-grab touch-none' : onPick ? 'cursor-crosshair' : ''} ${className}`}
      style={{ aspectRatio: `${scene.artwork.width} / ${scene.artwork.height}`, ...(transform ? { transform } : {}) }}
      data-animation-stage=""
      data-recording={recording ? '' : undefined}
      role="img"
      aria-label={`${scene.name} at ${(time / 1000).toFixed(2)} s`}
      onClick={onPick ? (e) => onPick(motionNodeAtElement(scene, e.target as Element, e.currentTarget), e) : undefined}
      onPointerDown={
        recording
          ? (e) => {
              const id = motionNodeAtElement(scene, e.target as Element, e.currentTarget);
              if (!id || !controller.beginRecordGesture(id, recordMode, point(e))) return;
              dragging.current = e.pointerId;
              e.currentTarget.setPointerCapture?.(e.pointerId);
              e.preventDefault();
            }
          : undefined
      }
      onPointerMove={recording ? (e) => dragging.current === e.pointerId && controller.updateRecordGesture(point(e)) : undefined}
      onPointerUp={
        recording
          ? (e) => {
              if (dragging.current !== e.pointerId) return;
              dragging.current = null;
              controller.endRecordGesture();
            }
          : undefined
      }
      onPointerCancel={recording ? () => ((dragging.current = null), controller.endRecordGesture()) : undefined}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
