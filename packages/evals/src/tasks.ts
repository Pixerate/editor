import { readFileSync } from "node:fs";
import path from "node:path";
import { BRUSH_HOSTS, BRUSH_TYPES, type BrushHost, type BrushType, type EvalTask, type FacetCheck, type TaskMode } from "./types.ts";

/** A colour test for `$expr` checks: `v` is `#rrggbb`, `r`, `g`, `b` are 0–255. */
const colour = (test: string): FacetCheck["expect"] => ({
  $expr: `typeof v === 'string' && /^#[0-9a-f]{6}/i.test(v) && (([r, g, b]) => ${test})([1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)))`,
});
const defaultColour = (why: string, test: string): FacetCheck => ({ why, expect: { brush: { colour: { default: colour(test) } } } });

type Scratch = Omit<EvalTask, "mode" | "brushId"> & { brushId?: string };

/**
 * Scratch tasks: one or two per brush type, mostly in the paint editor, and a few for the hosts
 * that render less (canvas, vector, image). Each brief is a person's request; `checks` are what it
 * plainly asks for; `solution` is one good answer (the oracle replays it, and the tests prove the
 * checks pass after it).
 */
const SCRATCH: Scratch[] = [
  {
    id: "dry-graphite-4b",
    type: "dry",
    host: "paint",
    brief: "Make me a soft 4B graphite pencil for sketching: it should get darker the harder I press, widen when I tilt the pen, and catch the tooth of the paper.",
    checks: [
      { why: "a pencil", expect: { brush: { medium: "dry", variety: "pencil" } } },
      { why: "catches the paper grain", expect: { brush: { behaviour: { grain: { $min: 0.6 } } } } },
      { why: "darker with pressure", expect: { brush: { dynamics: { pressureOpacity: true } } } },
      { why: "widens with tilt", expect: { brush: { dynamics: { tiltSize: { $min: 0.3 } } } } },
    ],
    solution: [
      { tool: "list_brush_presets", args: { variety: "pencil" } },
      { tool: "create_brush", args: { id: "graphite-4b", name: "4B graphite", basedOn: "pencil-6b", behaviour: { grain: 0.75 } } },
      { tool: "preview_brush", args: { id: "graphite-4b" } },
    ],
  },
  {
    id: "dry-conte-canvas",
    type: "dry",
    host: "canvas",
    brief: "I draw sketchy brushed strokes on the canvas. Give me a rust-red Conté crayon: chunky, very grainy, with a slightly ragged edge.",
    checks: [
      { why: "a dry medium", expect: { brush: { medium: "dry" } } },
      { why: "very grainy", expect: { brush: { behaviour: { grain: { $min: 0.8 } } } } },
      { why: "chunky", expect: { brush: { tip: { size: { $min: 10 } } } } },
      defaultColour("rust red", "r > 110 && r > g + 40 && r > b + 40"),
    ],
    solution: [{ tool: "create_brush", args: { id: "conte-canvas", name: "Rust Conté", basedOn: "crayon", colour: { default: "#9a3b26" }, behaviour: { grain: 0.95 }, tip: { size: 16 }, dynamics: { sizeJitter: 0.15 } } }],
  },
  {
    id: "dry-pastel-image",
    type: "dry",
    host: "image",
    brief: "For the image editor: a soft chalk-pastel brush in off-white for adding grainy texture and highlights to photos.",
    checks: [
      { why: "a dry medium", expect: { brush: { medium: "dry" } } },
      { why: "grainy", expect: { brush: { behaviour: { grain: { $min: 0.6 } } } } },
      defaultColour("off-white", "r > 225 && g > 225 && b > 215"),
    ],
    solution: [{ tool: "create_brush", args: { id: "pastel-image", name: "Off-white pastel", basedOn: "soft-pastel", colour: { default: "#f8f6f0" }, behaviour: { grain: 0.85 } } }],
  },
  {
    id: "ink-dip-pen",
    type: "ink",
    host: "paint",
    brief: "A dip pen nib for calligraphy in sepia ink: hairline-thin when I move fast, swelling when I press.",
    checks: [
      { why: "an ink", expect: { brush: { medium: "ink" } } },
      { why: "thinner when fast", expect: { brush: { dynamics: { velocitySize: { $max: -0.1 } } } } },
      { why: "a fine nib", expect: { brush: { tip: { size: { $max: 10 } } } } },
      defaultColour("sepia", "r > b + 30 && r > 50 && r < 170"),
    ],
    solution: [{ tool: "create_brush", args: { id: "dip-pen", name: "Sepia dip pen", basedOn: "ink-pen", colour: { default: "#6b4423" }, dynamics: { minSize: 0.15 } } }],
  },
  {
    id: "ink-fineliner-vector",
    type: "ink",
    host: "vector",
    brief: "A 0.3 mm technical fineliner for crisp black line art in the vector editor: the same width all along, whatever the pressure.",
    checks: [
      { why: "an ink", expect: { brush: { medium: "ink" } } },
      { why: "no pressure to size", expect: { brush: { dynamics: { pressureSize: false } } } },
      { why: "a small tip", expect: { brush: { tip: { size: { $max: 5 } } } } },
      defaultColour("black", "r < 40 && g < 40 && b < 40"),
    ],
    solution: [{ tool: "create_brush", args: { id: "fineliner-vector", name: "0.3 fineliner", basedOn: "fineliner", colour: { default: "#000000" }, tip: { size: 2 }, dynamics: { pressureSize: false } } }],
  },
  {
    id: "wet-cerulean-bloom",
    type: "wet",
    host: "paint",
    brief: "A loose watercolour round for skies, in cerulean blue, that carries lots of water so washes bloom and bleed into each other.",
    checks: [
      { why: "watercolour on a wet surface", expect: { brush: { variety: "watercolor", behaviour: { surface: "wet" } } } },
      { why: "lots of water", expect: { brush: { behaviour: { wet: { water: { $min: 0.7 } } } } } },
      defaultColour("cerulean blue", "b > 120 && b > r + 50"),
    ],
    solution: [{ tool: "create_brush", args: { id: "cerulean-bloom", name: "Cerulean bloom", basedOn: "watercolor-round", colour: { default: "#2a7ab0" }, behaviour: { wet: { water: 0.85 } } } }],
  },
  {
    id: "wet-gouache-vector",
    type: "wet",
    host: "vector",
    brief: "An opaque gouache flat brush for flat poster colour in vector brushstrokes, in a warm cadmium yellow.",
    checks: [
      { why: "gouache on a wet surface", expect: { brush: { variety: "gouache", behaviour: { surface: "wet" } } } },
      { why: "a flat tip", expect: { brush: { tip: { shape: "flat" } } } },
      defaultColour("cadmium yellow", "r > 200 && g > 140 && b < 90"),
    ],
    solution: [{ tool: "create_brush", args: { id: "gouache-vector", name: "Cadmium gouache flat", basedOn: "gouache", colour: { default: "#f2b705" }, tip: { shape: "flat", roundness: 0.45, angle: 90 } } }],
  },
  {
    id: "thick-titanium-impasto",
    type: "thick",
    host: "paint",
    brief: "A heavy impasto brush that piles up ridges of buttery titanium-white oil paint with a strong gloss.",
    checks: [
      { why: "thick paint", expect: { brush: { behaviour: { surface: "thick" } } } },
      { why: "glossy", expect: { brush: { behaviour: { thick: { gloss: { $min: 0.5 } } } } } },
      defaultColour("titanium white", "r > 225 && g > 225 && b > 215"),
    ],
    solution: [{ tool: "create_brush", args: { id: "titanium-impasto", name: "Titanium impasto", basedOn: "impasto-brush", colour: { default: "#f5f3ee" }, behaviour: { thick: { gloss: 0.7 } } } }],
  },
  {
    id: "metallic-gold-leaf",
    type: "metallic",
    host: "paint",
    brief: "Gold leaf paint: a flat brush that lays down very reflective, metallic gold.",
    checks: [
      { why: "strongly metallic", expect: { brush: { behaviour: { thick: { metallic: { $min: 0.8 } } } } } },
      defaultColour("gold", "r > 150 && g > 100 && r > b + 80 && g > b + 40"),
    ],
    solution: [{ tool: "create_brush", args: { id: "gold-leaf", name: "Gold leaf", basedOn: "metallic-paint", colour: { default: "#d4a017" } } }],
  },
  {
    id: "spray-stencil-pink",
    type: "spray",
    host: "paint",
    brief: "A stencil spray can for street art: a hard-edged mist of fine droplets, in hot pink.",
    checks: [
      { why: "a spray of droplets", expect: { brush: { medium: "spray", marks: { kind: "scatter" } } } },
      defaultColour("hot pink", "r > 200 && b > 90 && g < 140"),
    ],
    solution: [{ tool: "create_brush", args: { id: "stencil-pink", name: "Hot pink can", basedOn: "spray-can", colour: { default: "#ff2d95" } } }],
  },
  {
    id: "glow-neon-tube",
    type: "glow",
    host: "paint",
    brief: "A neon-tube light brush for night scenes: an electric cyan core that glows onto the paper around it.",
    checks: [
      { why: "gives off light", expect: { brush: { light: { amount: { $min: 0.6 } } } } },
      defaultColour("cyan", "g > 150 && b > 150 && r < 130"),
    ],
    solution: [{ tool: "create_brush", args: { id: "neon-tube", name: "Cyan neon tube", basedOn: "neon-marker", colour: { default: "#22d3ee" } } }],
  },
  {
    id: "iridescent-beetle",
    type: "iridescent",
    host: "paint",
    brief: "A beetle-shell lacquer whose colour shifts from green to violet with the light, and shifts further the harder I press.",
    checks: [
      { why: "thin-film iridescence", expect: { brush: { iridescence: { thickness: { $min: 100 } } } } },
      { why: "pressure changes the film", expect: { brush: { iridescence: { pressureToThickness: { $min: 0.2 } } } } },
    ],
    solution: [{ tool: "create_brush", args: { id: "beetle", name: "Beetle lacquer", basedOn: "scarab-lacquer", iridescence: { pressureToThickness: 0.55 } } }],
  },
  {
    id: "strands-fox-fur",
    type: "strands",
    host: "paint",
    brief: "A fur brush for a fox's coat: each stroke lays many fine hairs that follow the stroke, in russet orange.",
    checks: [
      { why: "strands, not dabs", expect: { brush: { marks: { kind: "particles" } } } },
      defaultColour("russet orange", "r > 150 && r > g + 50 && g > b"),
    ],
    solution: [{ tool: "create_brush", args: { id: "fox-fur", name: "Fox fur", basedOn: "flow-fur", colour: { default: "#c2410c" } } }],
  },
  {
    id: "stickers-autumn-leaves",
    type: "stickers",
    host: "paint",
    brief: "A brush that scatters little autumn leaves along the stroke, in different sizes and keeping their own colours.",
    checks: [
      { why: "stamps as objects", expect: { brush: { tip: { shape: "stamp" }, marks: { kind: "objects" } } } },
      { why: "varied sizes", expect: { brush: { marks: { sizeJitter: { $min: 0.2 } } } } },
    ],
    solution: [{ tool: "create_brush", args: { id: "autumn-leaves", name: "Autumn leaves", basedOn: "sticker-leaves", marks: { kind: "objects", sizeJitter: 0.5 } } }],
  },
  {
    id: "living-lichen",
    type: "living",
    host: "paint",
    brief: "A lichen ink: after I paint it, branching fungus-like threads grow out from the stroke, glowing faintly green.",
    checks: [
      { why: "a living culture", expect: { brush: { culture: { $type: "object" } } } },
      { why: "glows", expect: { brush: { culture: { glow: { $min: 0.2 } } } } },
      defaultColour("green", "g > r && g > b"),
    ],
    solution: [{ tool: "create_brush", args: { id: "lichen", name: "Lichen ink", basedOn: "mycelial-ink", colour: { default: "#4d7c0f" }, culture: { glow: 0.5 } } }],
  },
  {
    id: "ethereal-secret-pen",
    type: "ethereal",
    host: "paint",
    brief: "A secret-message pen: the ink is invisible until the paint editor's UV blacklight shines on it, then it glows violet.",
    checks: [
      { why: "invisible fluorescent ink", expect: { brush: { fluorescence: { invisible: true } } } },
      defaultColour("violet", "b > 150 && r > 100 && g < 120"),
    ],
    solution: [{ tool: "create_brush", args: { id: "secret-pen", name: "Secret pen", basedOn: "uv-marker", colour: { default: "#a855f7" } } }],
  },
  {
    id: "volatile-tight-whirl",
    type: "volatile",
    host: "paint",
    brief: "A brush that drags the paint already on the canvas into a tight spiral of many turns where I draw.",
    checks: [
      { why: "a vortex", expect: { brush: { marks: { kind: "vortex" } } } },
      { why: "many turns", expect: { brush: { marks: { turns: { $min: 2 } } } } },
    ],
    solution: [{ tool: "create_brush", args: { id: "tight-whirl", name: "Tight whirl", basedOn: "vortex", marks: { kind: "vortex", turns: 4 } } }],
  },
  {
    id: "reactive-heat-ink",
    type: "reactive",
    host: "paint",
    brief: "A heat-sensitive ink that paints deep green and turns bright yellow wherever the heat brush warms it.",
    checks: [
      { why: "thermochromic", expect: { brush: { thermochromic: { hotColor: colour("r > 200 && g > 170 && b < 120") } } } },
      defaultColour("deep green", "g > r + 20 && g > b && g < 140"),
    ],
    solution: [{ tool: "create_brush", args: { id: "heat-ink", name: "Green heat ink", basedOn: "thermo-ink", colour: { default: "#065f46" }, thermochromic: { hotColor: "#facc15" } } }],
  },
  {
    id: "tool-soft-blender",
    type: "tool",
    host: "paint",
    brief: "A big, soft blending tool for smoothing pastel shading without adding any colour.",
    checks: [
      { why: "a blender tool", expect: { brush: { kind: "tool", tool: "blender" } } },
      { why: "big", expect: { brush: { tip: { size: { $min: 30 } } } } },
      { why: "soft", expect: { brush: { tip: { hardness: { $max: 0.5 } } } } },
    ],
    solution: [{ tool: "create_brush", args: { id: "soft-blender", name: "Soft blender", basedOn: "blender", tip: { size: 48, hardness: 0.3 } } }],
  },
];

/**
 * Reference tasks: a built-in preset is held out of the library, and the model sees only its
 * sample stroke. Words are added where a still stroke can't show what the brush does.
 */
const REFERENCE: { type: BrushType; host: BrushHost; preset: string; brief?: string }[] = [
  { type: "dry", host: "canvas", preset: "chalk" },
  { type: "dry", host: "image", preset: "charcoal-stick" },
  { type: "ink", host: "paint", preset: "brush-pen" },
  { type: "wet", host: "paint", preset: "watercolor-wash" },
  { type: "wet", host: "vector", preset: "gouache" },
  { type: "thick", host: "paint", preset: "paint-roller" },
  { type: "spray", host: "paint", preset: "airbrush" },
  { type: "glow", host: "paint", preset: "neon-marker" },
  { type: "iridescent", host: "paint", preset: "soap-film", brief: "Its colour is a thin-film shimmer that shifts with the light." },
  { type: "strands", host: "paint", preset: "hair-strands" },
  { type: "stickers", host: "paint", preset: "sticker-confetti" },
  { type: "living", host: "paint", preset: "coral-ink", brief: "In wet paint, a pattern grows in it before it dries." },
  { type: "ethereal", host: "paint", preset: "ghost-gouache", brief: "A little while after it is laid, its own colour fades away." },
  { type: "volatile", host: "paint", preset: "whirlpool", brief: "It winds the paint already down around where you draw." },
  { type: "reactive", host: "paint", preset: "ferro-ink", brief: "It behaves like a magnetic liquid." },
  { type: "tool", host: "paint", preset: "smudge", brief: "It works on paint already down rather than laying any." },
];

const scratch = (t: Scratch): EvalTask => ({ ...t, mode: "scratch", brushId: t.brushId ?? t.id.replace(/^[a-z]+-/, "") });
const reference = (r: (typeof REFERENCE)[number]): EvalTask => ({
  id: `ref-${r.preset}${r.host === "paint" ? "" : `-${r.host}`}`,
  type: r.type,
  mode: "reference",
  host: r.host,
  brushId: "my-brush",
  brief: r.brief ?? "",
  reference: { preset: r.preset },
});

export const BUILTIN_TASKS: readonly EvalTask[] = [...SCRATCH.map(scratch), ...REFERENCE.map(reference)];

/** Tasks from a JSON file: an array of tasks (see tasks/custom.example.json), checked. */
export function loadTaskFile(file: string): EvalTask[] {
  const raw = JSON.parse(readFileSync(path.resolve(file), "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${file} must hold an array of tasks.`);
  const tasks = raw.map((t, i) => {
    const where = `${file}: task ${i + 1}`;
    if (!t || typeof t !== "object") throw new Error(`${where} is not an object.`);
    const task = t as Partial<EvalTask>;
    if (typeof task.id !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(task.id)) throw new Error(`${where} needs a kebab-case "id".`);
    if (!BRUSH_TYPES.includes(task.type as BrushType)) throw new Error(`${where} ("${task.id}"): "type" must be one of ${BRUSH_TYPES.join(", ")}.`);
    if (!BRUSH_HOSTS.includes((task.host ?? "paint") as BrushHost)) throw new Error(`${where} ("${task.id}"): "host" must be one of ${BRUSH_HOSTS.join(", ")}.`);
    const mode: TaskMode = task.reference ? "reference" : "scratch";
    if (mode === "scratch" && !task.brief) throw new Error(`${where} ("${task.id}") needs a "brief" or a "reference": { "preset" }.`);
    return { ...task, mode, host: task.host ?? "paint", brushId: task.brushId ?? "my-brush", brief: task.brief ?? "" } as EvalTask;
  });
  const dup = tasks.find((t, i) => tasks.findIndex((o) => o.id === t.id) !== i);
  if (dup) throw new Error(`${file}: two tasks have the id "${dup.id}".`);
  return tasks;
}

/** The tasks that match every filter given (an empty filter matches all). */
export function selectTasks(tasks: readonly EvalTask[], filter: { modes?: readonly TaskMode[]; types?: readonly string[]; hosts?: readonly string[]; ids?: readonly string[] }): EvalTask[] {
  const unknown = filter.ids?.filter((id) => !tasks.some((t) => t.id === id)) ?? [];
  if (unknown.length) throw new Error(`No task ${unknown.join(", ")}; --list shows them.`);
  const badType = filter.types?.find((t) => !BRUSH_TYPES.includes(t as BrushType));
  if (badType) throw new Error(`--type takes ${BRUSH_TYPES.join(", ")}; not "${badType}".`);
  const badHost = filter.hosts?.find((h) => !BRUSH_HOSTS.includes(h as BrushHost));
  if (badHost) throw new Error(`--host takes ${BRUSH_HOSTS.join(", ")}; not "${badHost}".`);
  return tasks.filter(
    (t) =>
      (!filter.modes?.length || filter.modes.includes(t.mode)) &&
      (!filter.types?.length || filter.types.includes(t.type)) &&
      (!filter.hosts?.length || filter.hosts.includes(t.host)) &&
      (!filter.ids?.length || filter.ids.includes(t.id)),
  );
}
