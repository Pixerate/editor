import React, { useEffect, useMemo, useState } from "react";
import { Film } from "lucide-react";
import { createVideoProject, type VideoProject } from "@pixerate/editor/video-editor";
import { VideoEditor, useVideoEditorController, useVideoEditorState, useVideoEditorTools } from "@pixerate/editor-react/video-editor";
import { demoToolRegistry } from "../agentTools";

const WIDTH = 1280;
const HEIGHT = 720;

/** A 1280 × 720 still as an SVG data URL, so the demo ships no media files. */
function still(title: string, from: string, to: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="980" cy="200" r="120" fill="#ffffff" fill-opacity="0.18"/><text x="80" y="640" font-family="sans-serif" font-size="56" font-weight="700" fill="#ffffff" fill-opacity="0.85">${title}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** A soft chord with a click on every beat, as a WAV blob URL (made in the browser). */
function music(seconds: number): string {
  const rate = 22050;
  const n = Math.round(seconds * rate);
  const data = new DataView(new ArrayBuffer(44 + n * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => data.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  data.setUint32(4, 36 + n * 2, true);
  text(8, "WAVEfmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, rate, true);
  data.setUint32(28, rate * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  text(36, "data");
  data.setUint32(40, n * 2, true);
  const chords = [
    [220, 277.18, 329.63],
    [196, 246.94, 293.66],
    [174.61, 220, 261.63],
    [196, 246.94, 329.63],
  ];
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const chord = chords[Math.floor(t / 3) % chords.length];
    let v = chord.reduce((sum, f) => sum + Math.sin(2 * Math.PI * f * t), 0) / chord.length;
    const beat = t % 0.5;
    v = v * 0.35 + (beat < 0.03 ? Math.sin(2 * Math.PI * 1000 * t) * (1 - beat / 0.03) * 0.3 : 0);
    data.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 32767, true);
  }
  return URL.createObjectURL(new Blob([data], { type: "audio/wav" }));
}

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

function sampleProject(): VideoProject {
  const base = createVideoProject({ name: "Pixerate reel", width: WIDTH, height: HEIGHT, fps: 30 });
  return {
    ...base,
    background: "#020617",
    assets: [
      { id: "sunrise", kind: "image", name: "sunrise.svg", src: still("Sunrise", "#f97316", "#7c3aed"), width: WIDTH, height: HEIGHT },
      { id: "ocean", kind: "image", name: "ocean.svg", src: still("Ocean", "#0ea5e9", "#1e3a8a"), width: WIDTH, height: HEIGHT },
      { id: "forest", kind: "image", name: "forest.svg", src: still("Forest", "#22c55e", "#14532d"), width: WIDTH, height: HEIGHT },
      { id: "music", kind: "audio", name: "music.wav", src: music(12), duration: 12000 },
    ],
    tracks: [
      {
        id: "titles",
        kind: "video",
        name: "Titles",
        clips: [
          { id: "title", type: "text", text: "Pixerate video editor", start: 300, duration: 2700, fadeIn: 400, fadeOut: 400, fontSize: 72 },
          { id: "lower-third", type: "text", text: "Drag clips · drag edges to trim · S splits", start: 4600, duration: 2800, fontSize: 36, background: "#0f172acc", transform: { y: 250 }, fadeIn: 200, fadeOut: 200 },
        ],
      },
      {
        id: "v1",
        kind: "video",
        name: "Video 1",
        clips: [
          { id: "shot-1", type: "media", asset: "sunrise", start: 0, duration: 4000, transform: { scale: 1.05 } },
          { id: "shot-2", type: "media", asset: "ocean", start: 4000, duration: 4000, transition: { type: "crossfade", duration: 800 } },
          { id: "shot-3", type: "media", asset: "forest", start: 8000, duration: 4000, transition: { type: "dip", duration: 600 }, fadeOut: 800 },
        ],
      },
      { id: "a1", kind: "audio", name: "Music", clips: [{ id: "score", type: "media", asset: "music", start: 0, duration: 12000, volume: 0.4, fadeIn: 500, fadeOut: 1500 }] },
    ],
    markers: [
      { id: "m-ocean", time: 4000, label: "Ocean" },
      { id: "m-forest", time: 8000, label: "Forest" },
    ],
  };
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
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
        <VideoEditor controller={controller} />
      </div>
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
