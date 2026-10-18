import React, { useEffect, useMemo, useRef, useState } from "react";
import { Film } from "lucide-react";
import { VideoEditor, useVideoEditorController, useVideoEditorState, useVideoEditorTools } from "@pixerate/editor-react/video-editor";
import { demoToolRegistry } from "../agentTools";
import { VIDEO_SCRIPTS } from "../agentScripts";
import { sampleProject } from "../videoSample";
import { AgentScriptPanel } from "./AgentScriptPanel";

/** Records a few seconds of an animated canvas as WebM (browsers with MediaRecorder only). */
async function recordFootage(seconds: number): Promise<{ src: string; duration: number }> {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext("2d")!;
  const stream = canvas.captureStream(30);
  const types = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  const recorder = new MediaRecorder(stream, { mimeType: types.find((t) => MediaRecorder.isTypeSupported(t)) });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  const done = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
  const start = performance.now();
  recorder.start();
  await new Promise<void>((resolve) => {
    const frame = () => {
      const t = (performance.now() - start) / 1000;
      ctx.fillStyle = `hsl(${(t * 40) % 360} 60% 22%)`;
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = "#fde047";
      ctx.beginPath();
      ctx.arc(320 + Math.cos(t * 2) * 220, 180 + Math.sin(t * 3) * 110, 36, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 40px monospace";
      ctx.fillText(`${t.toFixed(2)} s`, 24, 52);
      if (t < seconds) requestAnimationFrame(frame);
      else resolve();
    };
    frame();
  });
  recorder.stop();
  await done;
  return { src: URL.createObjectURL(new Blob(chunks, { type: "video/webm" })), duration: Math.round(seconds * 1000) };
}

const button = "rounded border border-slate-700 px-2 py-1 hover:bg-slate-800 disabled:opacity-40";

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Video: the headless non-linear editor with the React timeline, preview, transport, inspector
 * and media bin; agent tools; ffmpeg and EDL export. The sample media is made in the browser.
 */
export function VideoTab() {
  const project = useMemo(sampleProject, []);
  const controller = useVideoEditorController({ project });
  const state = useVideoEditorState(controller);
  useVideoEditorTools(demoToolRegistry, controller, { id: "video", namespace: "video" });
  const [output, setOutput] = useState<{ title: string; text: string } | null>(null);
  const [recording, setRecording] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const agentStage = useRef<HTMLDivElement>(null);
  useEffect(() => controller.seek(1200), [controller]);
  const errors = state.issues.filter((i) => i.severity === "error").length;

  const addFootage = async () => {
    setRecording(true);
    setMessage(null);
    try {
      const { src, duration } = await recordFootage(5);
      const result = controller.apply(
        [
          { op: "add_asset", asset: { id: "footage", kind: "video", name: "footage.webm", src, duration, width: 640, height: 360, hasAudio: false } },
          { op: "add_clip", track: "v1", clip: { type: "media", asset: "footage", in: 500, duration: 4000 } },
        ],
        "Add sample footage",
      );
      setMessage(result.ok ? "Added 5 s of recorded footage at the end of Video 1." : result.error);
    } catch (e) {
      setMessage(`Could not record footage here: ${(e as Error).message}`);
    } finally {
      setRecording(false);
    }
  };

  const showFfmpeg = () => {
    try {
      const ff = controller.toFfmpeg({ output: "reel.mp4" });
      setOutput({ title: "ffmpeg command", text: [ff.command, ...ff.notes.map((n) => `# ${n}`)].join("\n\n") });
    } catch (e) {
      setOutput({ title: "ffmpeg command", text: (e as Error).message });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Film className="h-5 w-5 text-rose-400" />
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Video</h2>
          <p className="text-xs text-slate-400">
            Headless <code>VideoEditorController</code> (<code>@pixerate/editor/video-editor</code>) with the React components from{" "}
            <code>@pixerate/editor-react/video-editor</code>. Drag clips to move them (they snap to edges, markers and the playhead), drag their edges to trim (Alt to
            ripple), press S to split at the playhead and Delete to remove (Shift to ripple). Drop your own video, audio or images on the media bin. Every change is one
            undo step (⌘Z), and agents make the same edits through the <code>video__*</code> tools.
          </p>
        </div>
      </div>
      <div className="relative rounded-xl border border-slate-800 bg-slate-900/50 p-3" ref={agentStage}>
        <VideoEditor controller={controller} />
      </div>
      <AgentScriptPanel
        scripts={VIDEO_SCRIPTS}
        stage={agentStage}
        hint="Plays a scripted agent turn with the video__* tools: it reads the project, then splits, ripple deletes, trims, adds titles and markers, checks and plays."
      />
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <span>
          {state.project.tracks.reduce((n, t) => n + t.clips.length, 0)} clips · {(state.duration / 1000).toFixed(1)} s · {errors} errors · {state.issues.length - errors}{" "}
          warnings and notes
        </span>
        <button type="button" className={button} onClick={addFootage} disabled={recording || state.readOnly}>
          {recording ? "Recording 5 s…" : "Add recorded footage"}
        </button>
        <button type="button" className={button} onClick={showFfmpeg}>
          ffmpeg command
        </button>
        <button type="button" className={button} onClick={() => setOutput({ title: "CMX 3600 EDL (Video 1)", text: controller.toEdl({ track: "v1" }) })}>
          EDL
        </button>
        <button type="button" className={button} onClick={() => download("project.json", JSON.stringify(state.project, null, 2), "application/json")}>
          Download project JSON
        </button>
      </div>
      {message && <p className="text-xs text-slate-300">{message}</p>}
      {output && (
        <div className="rounded-lg border border-slate-800 bg-slate-950 p-3">
          <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
            <span>{output.title}</span>
            <button type="button" className={button} onClick={() => setOutput(null)}>
              Close
            </button>
          </div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all text-[11px] text-slate-300">{output.text}</pre>
        </div>
      )}
    </div>
  );
}
