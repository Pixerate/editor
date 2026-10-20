import type { ModelCapabilities } from "@pixerate/editor/generation";
import type { VectorArtGenerator } from "@pixerate/editor/vector";

// A pretend generative backend for the demo, so the vector editor's generative prompts work
// offline: a "sketcher" that writes SVG from keywords in the prompt, and a "pictures" model that
// paints a small picture (traced or stylised into vectors by the editor). A real host sends the
// planned request to its model instead.

export const DEMO_VECTOR_MODELS: ModelCapabilities[] = [
  { id: "demo-sketcher", media: "text", name: "Demo sketcher (SVG)", description: "Writes SVG from keywords: sun, tree, house, rocket, flower, star." },
  { id: "demo-pictures", media: "image", name: "Demo pictures", aspectRatios: { options: ["1:1", "4:3", "16:9"] }, seed: true },
];

const SKETCHES: Record<string, string> = {
  sun: '<circle cx="50" cy="50" r="22" fill="#facc15"/><g stroke="#f59e0b" stroke-width="6" stroke-linecap="round"><path d="M50 8V20M50 80V92M8 50H20M80 50H92M20 20L28 28M72 72L80 80M80 20L72 28M20 80L28 72"/></g>',
  tree: '<rect x="44" y="60" width="12" height="32" fill="#92400e"/><path d="M50 8L82 64H18Z" fill="#16a34a"/>',
  house: '<rect x="22" y="46" width="56" height="44" fill="#fca5a5"/><path d="M14 50L50 16L86 50Z" fill="#b91c1c"/><rect x="44" y="64" width="14" height="26" fill="#7c2d12"/>',
  rocket: '<path d="M50 6C66 22 68 50 62 72H38C32 50 34 22 50 6Z" fill="#e2e8f0"/><circle cx="50" cy="38" r="8" fill="#38bdf8"/><path d="M38 60L24 80H40ZM62 60L76 80H60Z" fill="#ef4444"/><path d="M42 72H58L50 94Z" fill="#f97316"/>',
  flower: '<g fill="#f472b6"><circle cx="50" cy="28" r="14"/><circle cx="72" cy="50" r="14"/><circle cx="50" cy="72" r="14"/><circle cx="28" cy="50" r="14"/></g><circle cx="50" cy="50" r="10" fill="#fde047"/>',
  star: '<path d="M50 8L61 38H93L67 57L77 88L50 69L23 88L33 57L7 38H39Z" fill="#facc15"/>',
};

/** A small picture: a sky gradient, a sun placed by the seed, and hills. */
function paint(seed: number) {
  const w = 96;
  const h = 72;
  const data = new Uint8ClampedArray(w * h * 4);
  const sx = 20 + (seed % 56);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      let c: number[];
      if (Math.hypot(x - sx, y - 22) < 11) c = [250, 204, 21];
      else if (y > 48 + 6 * Math.sin((x + seed) / 12)) c = [22, 163, 74];
      else c = [96 + y, 165 + y, 250];
      data.set([...c, 255], k);
    }
  return { width: w, height: h, data };
}

export const demoVectorGenerate: VectorArtGenerator = async (request, { model }) => {
  // Pretend the request takes a moment.
  await new Promise((r) => setTimeout(r, 250));
  if (model.media === "image") return { image: paint(request.seed ?? 7) };
  const words = (request.prompt ?? "").toLowerCase().split(/[^a-z]+/);
  const found = Object.keys(SKETCHES).filter((k) => words.some((w) => w.startsWith(k)));
  const parts = (found.length ? found : ["star"]).map((k, i, all) => `<g transform="translate(${i * 100} 0)">${SKETCHES[k]}</g>`);
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${parts.length * 100}" height="100">${parts.join("")}</svg>` };
};
