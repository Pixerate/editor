import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BrushHost, EvalTask, Part } from "./types.ts";

/** The skills a model gets, as `@pixerate/editor` ships them: the reference skill, then the workflow. */
export const SKILLS = ["pixerate-brushes", "pixerate-brushes-design"] as const;

const skillsDir = fileURLToPath(new URL("../../core/skills/", import.meta.url));

/** A skill's SKILL.md, without its front matter. */
export function readSkill(name: string): string {
  return readFileSync(`${skillsDir}${name}/SKILL.md`, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

/** A reference task's stroke: the picture, the colour preview_brush drew it in, and whether that is the brush's own. */
export interface ReferenceView {
  png: Buffer;
  colour?: string;
  ownColour: boolean;
}

/** What preview_brush does to colours, which the model and the judge need to read a stroke. */
export const PREVIEW_COLOUR_NOTE = "preview_brush darkens or lightens a colour until it reads against the paper, so a white or pale brush previews darker than it is.";

/** What each host leaves out, which a brush made for it should not be marked down for. */
export const HOST_LIMITS: Record<BrushHost, string> = {
  paint: "",
  image: "The image editor ignores paper grain (behaviour.grain) and tip grain, and has no wet, thick, particle or stamp brushes: texture there comes from jitter and scatter.",
  canvas: "Canvas strokes take only dry dab brushes and ignore velocity, tip grain and count.",
  vector: "Vector strokes paint light brushes as plain colour and take no thick paint, particles, stamps or erasers.",
};

/** What each host is, in the words a person setting the task would use. */
export const HOST_WORDS: Record<BrushHost, string> = {
  paint: "the paint editor (it renders every kind of brush)",
  image: "the image editor (dry dab brushes, the Mixer Brush and the eraser only)",
  canvas: "brushed strokes on the canvas (dry dab brushes only)",
  vector: "brushstrokes in the vector editor (dry and wet dab brushes, the Mixer Brush, smudge and blender)",
};

/**
 * The system prompt: the brush skills exactly as shipped, then how the job ends. So the eval
 * measures the model and the docs agents get; a change to a skill shows up in the scores.
 */
export function systemPrompt(): string {
  return [
    "You design brushes in the Pixerate brush library for a person, through the brush tools. The skills below are your reference.",
    ...SKILLS.map((s) => `<skill name="${s}">\n${readSkill(s)}\n</skill>`),
    "Work with the tools until the brush is saved under the id you are given and does what was asked. Look at it with preview_brush before you finish. When it is done, reply with one or two sentences saying what you made, and call no more tools.",
  ].join("\n\n");
}

/** The task's first message: the brief (and the reference strokes), the id and the host. */
export function taskMessage(task: EvalTask, reference?: ReferenceView): Part[] {
  const where = `It is for ${HOST_WORDS[task.host]}; the tools you have are that host's.`;
  if (task.mode === "reference") {
    if (!reference) throw new Error(`Reference task "${task.id}" has no reference strokes.`);
    const colour = !reference.colour
      ? ""
      : reference.ownColour
        ? ` It is drawn in ${reference.colour}, from the brush's own default colour (${PREVIEW_COLOUR_NOTE})`
        : ` It is drawn in ${reference.colour}, preview_brush's fallback for its medium: the brush has no default colour of its own, so the person paints it in theirs.`;
    return [
      {
        type: "text",
        text: `Make a brush that paints like this one. This is its sample stroke, as preview_brush draws it at 512 × 160.${colour}`,
      },
      { type: "image", png: reference.png, label: "Reference stroke" },
      { type: "text", text: [task.brief, `Save it with the id \`${task.brushId}\` and a name of your choosing. ${where}`].filter(Boolean).join("\n\n") },
    ];
  }
  return [{ type: "text", text: `${task.brief}\n\nSave it with the id \`${task.brushId}\` and a name of your choosing. ${where}` }];
}

/** Sent once when the model stops without having saved the brush, as a person would say. */
export function notSavedMessage(task: EvalTask): Part[] {
  return [{ type: "text", text: `There is no brush \`${task.brushId}\` in the library yet. Please save it under that id.` }];
}
