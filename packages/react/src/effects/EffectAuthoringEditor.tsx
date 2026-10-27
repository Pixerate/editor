import React, { useCallback, useEffect, useRef, useState } from 'react';
import { effectSampleInputs, type EffectAuthoringSession, type EffectPixels, type EffectRenderer } from '@pixerate/editor/effects';
import { useEffectAuthoring } from './useEffectAuthoring';
import { EffectParameters } from './EffectParameters';

export interface EffectAuthoringEditorProps {
  /** The effect authoring session to edit. */
  session: EffectAuthoringSession | null;
  /** Whether to show the source code editor pane when supported (default true). */
  showSource?: boolean;
  /** Whether to show the keyframe timeline below parameters (default true). */
  showTimeline?: boolean;
  /** Size of the preview canvas (default 480 × 270). */
  previewSize?: { width: number; height: number };
  /** Additional CSS class names. */
  className?: string;
}

/**
 * Visual effect authoring editor: preview canvas, source code pane with line gutter,
 * parameter controls with keyframe toggles, and keyframe timeline.
 */
export function EffectAuthoringEditor({
  session,
  showSource = true,
  showTimeline = true,
  previewSize = { width: 480, height: 270 },
  className = ''
}: EffectAuthoringEditorProps) {
  const state = useEffectAuthoring(session);

  // Preview renderer lifecycle
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<EffectRenderer | null>(null);
  const [rendererReady, setRendererReady] = useState(0);
  const renderingRef = useRef(false);
  const pendingRef = useRef(false);
  /** The playhead the next frame should show (the latest state's). */
  const timeRef = useRef(0);
  /** Sample pictures for the effect's image inputs, so filters and transitions show something. */
  const inputsRef = useRef<Record<string, EffectPixels>>({});
  /** Why the preview shows nothing: the preview could not be made, or its last frame failed. */
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Preset saving state
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetName, setPresetName] = useState('');

  // Source code pane state
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const [sourceCode, setSourceCode] = useState<string>('');
  const sourceDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // A new session must not show the last session's frame, whatever happens next.
    const canvas = canvasRef.current;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    setPreviewError(null);
    if (!session) {
      if (rendererRef.current) {
        rendererRef.current.dispose();
        rendererRef.current = null;
      }
      return;
    }

    let live = true;
    let createdRenderer: EffectRenderer | null = null;

    Promise.resolve(session.createPreview(previewSize)).then((renderer) => {
      if (!live) {
        renderer.dispose();
        return;
      }
      createdRenderer = renderer;
      rendererRef.current = renderer;
      setRendererReady((c) => c + 1);
    }).catch((e: unknown) => {
      // The session's own reason (state.previewError) when it has one, else the error's.
      if (live) setPreviewError(session.getState().previewError || (e instanceof Error ? e.message : String(e)));
    });

    return () => {
      live = false;
      if (createdRenderer) {
        (createdRenderer as EffectRenderer).dispose();
      }
      if (rendererRef.current === createdRenderer) {
        rendererRef.current = null;
      }
    };
  }, [session, previewSize.width, previewSize.height]);

  // Draws frames one at a time. A change while a frame renders asks for one more frame, which
  // then shows the latest playhead and values, so the preview never stops on a stale frame.
  const pump = useCallback(async () => {
    if (renderingRef.current) {
      pendingRef.current = true;
      return;
    }
    renderingRef.current = true;
    try {
      do {
        pendingRef.current = false;
        const renderer = rendererRef.current;
        if (!renderer) break;
        try {
          const pixels = await renderer.render({ time: timeRef.current, inputs: inputsRef.current });
          const ctx = rendererRef.current === renderer ? canvasRef.current?.getContext('2d') : null;
          if (ctx && typeof ImageData !== 'undefined') {
            ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height), 0, 0);
          }
          if (rendererRef.current === renderer) setPreviewError(null);
        } catch (e) {
          // A frame from a renderer that has since been replaced (or disposed) is skipped; a failure
          // of the current one clears the canvas and says why. The next change draws again.
          if (rendererRef.current === renderer) {
            const canvas = canvasRef.current;
            canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
            setPreviewError(e instanceof Error ? e.message : String(e));
          }
        }
      } while (pendingRef.current);
    } finally {
      renderingRef.current = false;
    }
  }, []);

  const inputSpecs = state?.description.inputs;
  useEffect(() => {
    inputsRef.current = inputSpecs ? effectSampleInputs({ inputs: inputSpecs }, previewSize) : {};
  }, [inputSpecs, previewSize.width, previewSize.height]);

  useEffect(() => {
    if (!state) return;
    timeRef.current = state.time;
    void pump();
  }, [state, rendererReady, pump]);

  // Sync source code when state.source updates externally
  useEffect(() => {
    if (state?.source !== null && state?.source !== undefined) {
      setSourceCode(state.source);
    }
  }, [state?.source]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (sourceDebounceRef.current) clearTimeout(sourceDebounceRef.current);
    };
  }, []);

  if (!session || !state) {
    return (
      <div className={`p-4 text-center text-xs text-muted-foreground ${className}`}>
        No effect authoring session is open.
      </div>
    );
  }

  const hasSource =
    showSource && state.sourceLanguage !== null && typeof session.setSource === 'function';

  const handleSourceChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setSourceCode(val);
    if (sourceDebounceRef.current) clearTimeout(sourceDebounceRef.current);
    sourceDebounceRef.current = setTimeout(() => {
      session.setSource?.(val);
    }, 300);
  };

  const handleSavePreset = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = presetName.trim();
    if (trimmed) {
      session.savePreset(trimmed);
      setSavingPreset(false);
      setPresetName('');
    }
  };

  const jumpToLine = (lineNum: number) => {
    if (!textareaRef.current) return;
    const lines = sourceCode.split('\n');
    let offset = 0;
    for (let i = 0; i < lineNum - 1 && i < lines.length; i++) {
      offset += lines[i].length + 1;
    }
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(offset, offset);
  };

  const sourceLines = sourceCode.split('\n');
  const issueLines = new Set(
    state.issues.map((i) => i.line).filter((l): l is number => typeof l === 'number')
  );

  return (
    <div className={`space-y-4 rounded border border-border bg-background p-4 text-foreground ${className}`} data-effect-authoring-editor={state.name}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted"
            aria-label={state.playing ? 'Pause playback' : 'Start playback'}
            onClick={() => (state.playing ? session.pause() : session.play())}
          >
            {state.playing ? 'Pause' : 'Play'}
          </button>
          <span className="font-mono text-xs text-muted-foreground" data-time-readout>
            {state.time}ms / {state.duration}ms
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-xs disabled:opacity-40 hover:bg-muted"
            aria-label="Undo"
            disabled={!state.canUndo}
            onClick={() => session.undo()}
          >
            Undo
          </button>
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-xs disabled:opacity-40 hover:bg-muted"
            aria-label="Redo"
            disabled={!state.canRedo}
            onClick={() => session.redo()}
          >
            Redo
          </button>

          {savingPreset ? (
            <form onSubmit={handleSavePreset} className="flex items-center gap-1">
              <input
                type="text"
                className="rounded border border-border bg-background px-1.5 py-0.5 text-xs"
                placeholder="Preset name"
                autoFocus
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
              />
              <button
                type="submit"
                className="rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground"
              >
                Save
              </button>
              <button
                type="button"
                className="rounded border border-border px-1.5 py-0.5 text-xs hover:bg-muted"
                onClick={() => setSavingPreset(false)}
              >
                Cancel
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
              onClick={() => setSavingPreset(true)}
            >
              Save preset…
            </button>
          )}
        </div>
      </div>

      {/* Main workspace: Preview + Source */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Preview Panel */}
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Preview
          </div>
          <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded border border-border bg-black">
            <canvas
              ref={canvasRef}
              width={previewSize.width}
              height={previewSize.height}
              className="h-full w-full object-contain"
              aria-label="Effect preview canvas"
            />
            {previewError && (
              <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-white/80" role="status" data-effect-preview-error>
                {previewError}
              </div>
            )}
          </div>
          {state.issues.length > 0 && (
            <div className="space-y-1 rounded border border-destructive/20 bg-destructive/10 p-2 text-xs" data-effect-issues>
              {state.issues.map((issue, idx) => (
                <div
                  key={idx}
                  className={`cursor-pointer ${issue.severity === 'error' ? 'text-destructive' : 'text-amber-500'}`}
                  onClick={() => issue.line !== undefined && jumpToLine(issue.line)}
                >
                  {issue.line !== undefined ? `Line ${issue.line}: ` : ''}
                  {issue.message}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Source Code Pane */}
        {hasSource && (
          <div className="space-y-2" data-effect-source-pane>
            <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <span>Source ({state.sourceLanguage})</span>
            </div>
            <div className="flex h-64 rounded border border-border bg-muted/20 font-mono text-xs">
              {/* Line Gutter */}
              <div ref={gutterRef} className="select-none overflow-hidden border-r border-border bg-muted/40 px-2 py-2 text-right text-muted-foreground" aria-hidden="true">
                {sourceLines.map((_, i) => {
                  const lineNum = i + 1;
                  const hasIssue = issueLines.has(lineNum);
                  return (
                    <div
                      key={i}
                      data-gutter-line={lineNum}
                      className={hasIssue ? 'font-bold text-destructive' : ''}
                    >
                      {lineNum}
                    </div>
                  );
                })}
              </div>
              {/* Textarea */}
              <textarea
                ref={textareaRef}
                value={sourceCode}
                onChange={handleSourceChange}
                onScroll={(e) => {
                  if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
                }}
                aria-label="Effect source code"
                spellCheck={false}
                wrap="off"
                className="flex-1 resize-none bg-transparent p-2 font-mono text-xs text-foreground focus:outline-none"
              />
            </div>
          </div>
        )}
      </div>

      {/* Parameters */}
      <div className="space-y-2 border-t border-border pt-4">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Parameters
        </div>
        <EffectParameters
          description={state.description}
          values={state.values}
          onChange={(control, val, gesture) => session.setValue(control, val as any, { gesture })}
          onReset={(control) => session.resetValues([control])}
          onPresetName={(name) => session.applyPreset(name)}
          renderControlAddon={(control) => {
            const track = state.tracks[control];
            const isAnimated = Boolean(track && track.length > 0);
            const hasKeyframeAtPlayhead = isAnimated && track.some((kf) => kf.time === state.time);

            return (
              <button
                type="button"
                data-keyframe-toggle={control}
                aria-label={
                  hasKeyframeAtPlayhead
                    ? `Remove keyframe for ${control}`
                    : `Add keyframe for ${control}`
                }
                onClick={() => {
                  if (hasKeyframeAtPlayhead) {
                    session.removeKeyframe(control, state.time);
                  } else {
                    session.setKeyframe(control, state.time);
                  }
                }}
                className={`rounded px-1 text-xs transition-colors ${
                  hasKeyframeAtPlayhead
                    ? 'text-primary font-bold'
                    : isAnimated
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title={hasKeyframeAtPlayhead ? 'Remove keyframe at playhead' : 'Add keyframe at playhead'}
              >
                {hasKeyframeAtPlayhead ? '◆' : '◇'}
              </button>
            );
          }}
        />
      </div>

      {/* Keyframe Timeline */}
      {showTimeline && (
        <div className="space-y-3 border-t border-border pt-4" data-effect-timeline>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Timeline
            </div>
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5">
                <span>Duration:</span>
                <DurationField duration={state.duration} onCommit={(duration) => session.setTiming({ duration })} />
                <span className="text-muted-foreground">ms</span>
              </label>

              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  aria-label="Loop playback"
                  checked={state.loop}
                  onChange={(e) => session.setTiming({ loop: e.target.checked })}
                />
                <span>Loop</span>
              </label>
            </div>
          </div>

          {/* Scrubber */}
          <div className="space-y-1">
            <input
              type="range"
              aria-label="Timeline scrubber"
              min={0}
              max={state.duration}
              value={state.time}
              onChange={(e) => session.seek(Number(e.target.value))}
              className="w-full cursor-pointer accent-primary"
            />
          </div>

          {/* Tracks */}
          {Object.entries(state.tracks).length > 0 && (
            <div className="space-y-2 pt-1">
              {Object.entries(state.tracks).map(([control, keyframes]) => {
                if (!keyframes || keyframes.length === 0) return null;
                return (
                  <div key={control} className="space-y-1" data-track={control}>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span className="font-medium">{control}</span>
                      <button
                        type="button"
                        className="text-[11px] hover:text-foreground"
                        onClick={() => session.clearTrack(control)}
                        aria-label={`Clear animation track for ${control}`}
                      >
                        Clear track
                      </button>
                    </div>
                    <div className="relative h-4 w-full rounded bg-muted/40">
                      {keyframes.map((kf, i) => {
                        const leftPct = Math.max(
                          0,
                          Math.min(100, (kf.time / (state.duration || 1)) * 100)
                        );
                        return (
                          <button
                            key={i}
                            type="button"
                            onClick={() => session.seek(kf.time)}
                            aria-label={`Seek to ${control} keyframe at ${kf.time}ms`}
                            title={`${control} @ ${kf.time}ms`}
                            style={{ left: `${leftPct}%` }}
                            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 text-[10px] text-primary hover:scale-125"
                          >
                            ◆
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The duration in ms, committed on blur or Enter (one undo step), so typing "2000" doesn't apply 2, 20 and 200 on the way. */
function DurationField({ duration, onCommit }: { duration: number; onCommit: (duration: number) => void }) {
  const [draft, setDraft] = useState(String(duration));
  useEffect(() => setDraft(String(duration)), [duration]);
  const commit = () => {
    const next = Number(draft);
    if (Number.isFinite(next) && next >= 1 && next !== duration) onCommit(next);
    else setDraft(String(duration));
  };
  return (
    <input
      type="number"
      aria-label="Duration"
      min={1}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') setDraft(String(duration));
      }}
      className="w-16 rounded border border-border bg-background px-1.5 py-0.5 text-xs font-mono"
    />
  );
}
