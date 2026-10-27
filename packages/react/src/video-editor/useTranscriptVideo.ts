import { useEffect, useRef, useSyncExternalStore } from 'react';
import { TranscriptVideoController, type TranscriptVideoOptions, type TranscriptVideoState, type VideoEditorController } from '@pixerate/editor/video-editor';

/**
 * A `TranscriptVideoController` over a video editor for the component's lifetime (rebuilt when the
 * editor, track or `planFirst` change; destroyed on unmount).
 */
export function useTranscriptVideoController(controller: VideoEditorController, options: TranscriptVideoOptions = {}): TranscriptVideoController {
  const ref = useRef<{ key: string; editor: VideoEditorController; transcript: TranscriptVideoController } | null>(null);
  const key = `${options.track ?? ''}|${options.planFirst ? 1 : 0}`;
  if (!ref.current || ref.current.editor !== controller || ref.current.key !== key) {
    ref.current?.transcript.destroy();
    ref.current = { key, editor: controller, transcript: new TranscriptVideoController(controller, options) };
  }
  const transcript = ref.current.transcript;
  useEffect(() => () => transcript.destroy(), [transcript]);
  return transcript;
}

/** The transcript controller's state (re-renders when the words, the word under the playhead or the selection change). */
export function useTranscriptVideoState(transcript: TranscriptVideoController): TranscriptVideoState {
  return useSyncExternalStore(transcript.subscribe, transcript.getState, transcript.getState);
}
