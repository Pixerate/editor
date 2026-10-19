import React, { useEffect } from 'react';
import type { VideoEditorController, VideoEditorOptions } from '@pixerate/editor/video-editor';
import { ClipInspector } from './ClipInspector';
import { MediaBin } from './MediaBin';
import { TranscriptPanel } from './TranscriptPanel';
import { useVideoEditor } from './useVideoEditor';
import { VideoPreview } from './VideoPreview';
import { VideoScopes } from './VideoScopes';
import { VideoTimeline } from './VideoTimeline';
import { VideoTransport } from './VideoTransport';

export interface VideoEditorProps {
  /** The controller to edit. Without it one is created from `options` for the component's lifetime. */
  controller?: VideoEditorController;
  /** Options for the controller created when `controller` is not given. */
  options?: VideoEditorOptions;
  /**
   * Show the editing UI: the media bin's imports, the transport's edit buttons, timeline dragging
   * and track toggles, and the clip inspector (default true). False also makes the project read-only
   * while mounted.
   */
  editable?: boolean;
  /** Timeline zoom in pixels per second (with `onPxPerSecondChange` the host owns it). */
  pxPerSecond?: number;
  onPxPerSecondChange?: (pxPerSecond: number) => void;
  /** Canvas pixels per frame pixel for the preview (see `<VideoPreview resolution>`). */
  resolution?: number;
  /** List the project's issues under the timeline (default true). */
  showIssues?: boolean;
  /** Show the transcript panel for editing by text (default true). */
  showTranscript?: boolean;
  /** Show colour scopes (histogram, luma waveform, vectorscope) of the preview under it (default false). */
  showScopes?: boolean;
  className?: string;
}

/**
 * A whole non-linear video editor for a `VideoEditorController`: the media bin, the preview, the
 * transport, the timeline and the clip inspector, with the project's issues listed under the
 * timeline. Every edit is one undo step; the controller's agent tools edit the same project.
 */
export function VideoEditor({ controller: given, options, editable = true, pxPerSecond, onPxPerSecondChange, resolution, showIssues = true, showTranscript = true, showScopes = false, className = '' }: VideoEditorProps) {
  const { controller, state } = useVideoEditor(given ?? options ?? {});
  useEffect(() => {
    if (editable) return;
    const was = controller.getState().readOnly;
    controller.setReadOnly(true);
    return () => controller.setReadOnly(was);
  }, [controller, editable]);
  const { issues } = state;
  const issueList = showIssues && issues.length > 0 && (
    <ul className="space-y-0.5 text-xs" aria-label="Video issues" data-video-issues="">
      {issues.map((issue, i) => (
        <li key={i} className={issue.severity === 'error' ? 'text-red-500' : issue.severity === 'warning' ? 'text-amber-500' : 'text-muted-foreground'} data-issue={issue.code}>
          {issue.message}
        </li>
      ))}
    </ul>
  );
  return (
    <div className={`flex flex-col gap-3 ${className}`} data-video-editor="">
      <div className={`grid gap-3 ${editable ? 'lg:grid-cols-[16rem_minmax(0,1fr)_18rem]' : ''}`}>
        {editable && <MediaBin controller={controller} className="min-w-0" />}
        <div className="flex min-w-0 flex-col gap-2">
          <VideoPreview controller={controller} resolution={resolution} className="rounded-md border border-border" />
          <VideoTransport controller={controller} editable={editable} />
          {showScopes && <VideoScopes controller={controller} />}
        </div>
        {editable && <ClipInspector controller={controller} className="min-w-0" />}
      </div>
      <VideoTimeline controller={controller} editable={editable} pxPerSecond={pxPerSecond} onPxPerSecondChange={onPxPerSecondChange} />
      {showTranscript && <TranscriptPanel controller={controller} editable={editable} />}
      {issueList}
    </div>
  );
}
