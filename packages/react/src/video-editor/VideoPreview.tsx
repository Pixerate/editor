import React, { useEffect, useRef } from 'react';
import { VideoPreviewEngine, type VideoEditorController, type VideoPreviewOptions } from '@pixerate/editor/video-editor';
import { useVideoEditorState } from './useVideoEditor';

export interface VideoPreviewProps {
  controller: VideoEditorController;
  /** Canvas pixels per frame pixel (default: fits the displayed width at the device pixel ratio, at most 1). */
  resolution?: number;
  /** Called after each frame is drawn. */
  onFrame?: VideoPreviewOptions['onFrame'];
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Plays the controller's project on a canvas the shape of its frame: a `VideoPreviewEngine` keeps
 * one `<video>` / `<audio>` element per playing clip in step with the playhead and draws each frame.
 * The engine is created when the canvas mounts and destroyed on unmount or when the controller changes.
 */
export function VideoPreview({ controller, resolution, onFrame, className = '', style }: VideoPreviewProps) {
  const { project } = useVideoEditorState(controller);
  const canvas = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(onFrame);
  frameRef.current = onFrame;
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const engine = new VideoPreviewEngine(controller, el, { resolution, onFrame: (frame) => frameRef.current?.(frame) });
    return () => engine.destroy();
  }, [controller, resolution]);
  return (
    <canvas
      ref={canvas}
      className={className}
      style={{ display: 'block', width: '100%', aspectRatio: `${project.width} / ${project.height}`, background: project.background ?? '#000', ...style }}
      role="img"
      aria-label={`Preview of ${project.name ?? 'the video'}`}
      data-video-preview=""
    />
  );
}
