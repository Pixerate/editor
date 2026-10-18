import { createVideoProject, type VideoProject } from "@pixerate/editor/video-editor";

// The Video tab's sample project. Its media is made in the browser (SVG stills, a WAV chord), so
// the demo ships no media files and the agent scripts can be replayed in tests.

const WIDTH = 1280;
const HEIGHT = 720;

/** A 1280 × 720 still as an SVG data URL, so the demo ships no media files. */
export function still(title: string, from: string, to: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="980" cy="200" r="120" fill="#ffffff" fill-opacity="0.18"/><text x="80" y="640" font-family="sans-serif" font-size="56" font-weight="700" fill="#ffffff" fill-opacity="0.85">${title}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** A soft chord with a click on every beat, as a WAV blob URL (made in the browser). */
export function music(seconds: number): string {
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

/** Three stills with a crossfade and a dip, two titles, music and two markers. */
export function sampleProject(): VideoProject {
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
