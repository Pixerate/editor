import { HOST_WORDS } from "./prompt.ts";
import type { EvalTask, JudgeScores, Model, Part } from "./types.ts";

export const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    fidelity: { type: "integer", description: "1-5" },
    medium: { type: "integer", description: "1-5" },
    craft: { type: "integer", description: "1-5" },
    settings: { type: "integer", description: "1-5" },
    notes: { type: "string" },
  },
  required: ["fidelity", "medium", "craft", "settings", "notes"],
  additionalProperties: false,
} as const;

const SYSTEM = `You grade brushes designed for a digital painting library. You see the sample stroke a drafted brush paints (an S-curve drawn with rising then falling pressure, in the brush's own colour), its settings as JSON, and either the request it was made for or the sample stroke of a reference brush it was meant to match. Grade what the stroke and the settings show, not what the brush's name claims.

Score each from 1 to 5:
- fidelity: does it do what was asked? With a request: every element of it is there (5), most (3), little (1). With a reference: a painter would take it for the same brush (5), the same kind of brush with clear differences in width, texture, colour or behaviour (3), a different brush (1).
- medium: does the stroke read as the material it imitates (graphite, ink, watercolour, oil, metal, light, hair…) with its texture, edges, opacity and pressure response (5), passably (3), not at all (1)?
- craft: would a brush designer ship it? Clean, even, free of artefacts such as visible dab spacing, banding, clipped or blown-out areas, unless the medium calls for them (5); passable (3); broken or ugly (1).
- settings: are the settings what an expert would choose for it: a sensible size, spacing, dynamics and a clear name (the id was given by the request: don't grade it), no needless or contradictory facets (5); some odd or missing (3); poor (1)? Some behaviour (paint that grows, fades, reacts to heat or a blacklight) shows only in the settings: judge it there.

Be strict and consistent: 5 is rare. Answer with JSON only: {"fidelity", "medium", "craft", "settings", "notes"}, notes a sentence or two on the biggest problems.`;

/** The judge's request for one drafted brush. */
export function judgeParts(task: EvalTask, candidate: Buffer, settings: unknown, reference?: Buffer): Part[] {
  const parts: Part[] = [{ type: "text", text: `Brush type: ${task.type}. It is for ${HOST_WORDS[task.host]}.` }];
  if (task.mode === "scratch") parts.push({ type: "text", text: `Request: ${task.brief}` });
  else if (reference) parts.push({ type: "text", text: `The reference brush's stroke${task.brief ? ` (notes: ${task.brief})` : ""}:` }, { type: "image", png: reference, label: "Reference" });
  parts.push({ type: "text", text: "The drafted brush's stroke:" }, { type: "image", png: candidate, label: "Candidate" });
  parts.push({ type: "text", text: `Its settings:\n${JSON.stringify(settings, null, 2)}` });
  return parts;
}

/** The JSON object in a judge's answer, checked. */
export function parseJudge(text: string): JudgeScores {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) throw new Error(`The judge's answer holds no JSON object: ${text.slice(0, 200)}`);
  const raw = JSON.parse(match[0]) as Record<string, unknown>;
  const score = (key: string) => {
    const n = Number(raw[key]);
    if (!Number.isFinite(n) || n < 1 || n > 5) throw new Error(`The judge's ${key} is ${String(raw[key])}, not 1 to 5.`);
    return Math.round(n);
  };
  return { fidelity: score("fidelity"), medium: score("medium"), craft: score("craft"), settings: score("settings"), notes: String(raw.notes ?? "") };
}

/** Asks the judge model, returning its scores. */
export async function judge(model: Model, key: string, parts: Part[]): Promise<JudgeScores> {
  const response = await model.generate({ system: SYSTEM, messages: [{ role: "user", content: parts }], schema: JUDGE_SCHEMA as unknown as Record<string, unknown>, key });
  return parseJudge(response.text);
}

/** The judge's scores as one number, 0 to 1: fidelity counts double. */
export function judgeScore(s: JudgeScores): number {
  return (2 * (s.fidelity - 1) + (s.medium - 1) + (s.craft - 1) + (s.settings - 1)) / 20;
}
