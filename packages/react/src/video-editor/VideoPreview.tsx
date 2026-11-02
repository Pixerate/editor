import React, { useEffect, useMemo, useRef, useState } from 'react';
import { VideoPathGesture, VideoPreviewEngine, type VideoEditorController, type VideoPreviewOptions } from '@pixerate/editor/video-editor';
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
  const { project, pathDrawing } = useVideoEditorState(controller);
  // Drawing a path for an effect (the effects panel's Draw path): the preview takes the pointer.
  const gesture = useMemo(() => new VideoPathGesture(project), [project.width, project.height]);
  const [drawn, setDrawn] = useState<number[]>([]);
  useEffect(() => {
    if (!pathDrawing) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && controller.cancelPathDrawing();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller, pathDrawing]);
  const box = (el: Element) => el.getBoundingClientRect();
  const canvas = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(onFrame);
  frameRef.current = onFrame;
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const engine = new VideoPreviewEngine(controller, el, { resolution, onFrame: (frame) => frameRef.current?.(frame) });
    return () => engine.destroy();
  }, [controller, resolution]);
  const preview = (
    <canvas
      ref={canvas}
      className={className}
      style={{ display: 'block', width: '100%', aspectRatio: `${project.width} / ${project.height}`, background: project.background ?? '#000', ...style }}
      role="img"
      aria-label={`Preview of ${project.name ?? 'the video'}`}
      data-video-preview=""
    />
  );
  if (!pathDrawing) return preview;
  return (
    <div style={{ position: 'relative' }}>
      {preview}
      <svg
        viewBox={`0 0 ${project.width} ${project.height}`}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'crosshair', touchAction: 'none' }}
        role="application"
        aria-label="Draw the effect's path"
        data-video-path-drawing=""
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          gesture.down(e, box(e.currentTarget));
          setDrawn([...gesture.points]);
        }}
        onPointerMove={(e) => gesture.move(e, box(e.currentTarget)) && setDrawn([...gesture.points])}
        onPointerUp={() => {
          const points = gesture.up();
          setDrawn([]);
          if (points) void controller.finishPathDrawing(points);
        }}
      >
        <polyline points={drawn.join(' ')} fill="none" stroke="#22d3ee" strokeWidth={Math.max(2, project.width / 300)} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
