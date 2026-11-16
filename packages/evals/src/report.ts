import type { SampleResult } from "./types.ts";

/** Averages over a group of samples. */
export interface GroupSummary {
  group: string;
  samples: number;
  /** Mean and standard deviation of the overall score, 0–100. */
  overall: number;
  sd: number;
  /** Shares, 0–1. */
  firstTry: number;
  saved: number;
  rendered: number;
  validity: number;
  requirements: number;
  /** Means, 0–1, over the samples that have them (undefined when none do). */
  judge?: number;
  similarity?: number;
  turns: number;
  toolCalls: number;
  tokens: { input: number; output: number };
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const meanOf = (xs: readonly (number | undefined)[]) => {
  const present = xs.filter((x): x is number => x !== undefined);
  return present.length ? mean(present) : undefined;
};

export function summarize(group: string, results: readonly SampleResult[]): GroupSummary {
  const overall = mean(results.map((r) => r.overall));
  const sd = Math.sqrt(mean(results.map((r) => (r.overall - overall) ** 2)));
  return {
    group,
    samples: results.length,
    overall,
    sd,
    firstTry: mean(results.map((r) => (r.firstTry ? 1 : 0))),
    saved: mean(results.map((r) => ((r.scores.validity ?? 0) > 0 ? 1 : 0))),
    rendered: mean(results.map((r) => r.scores.render ?? 0)),
    validity: mean(results.map((r) => r.scores.validity ?? 0)),
    requirements: mean(results.map((r) => r.scores.requirements ?? 0)),
    judge: meanOf(results.map((r) => r.scores.judge)),
    similarity: meanOf(results.map((r) => r.scores.similarity)),
    turns: mean(results.map((r) => r.turns)),
    toolCalls: mean(results.map((r) => r.toolCalls)),
    tokens: { input: results.reduce((s, r) => s + r.usage.input, 0), output: results.reduce((s, r) => s + r.usage.output, 0) },
  };
}

/** Summaries overall, by mode, by host, by mode and type, and by task. */
export function groups(results: readonly SampleResult[]) {
  const by = (key: (r: SampleResult) => string) => {
    const map = new Map<string, SampleResult[]>();
    for (const r of results) map.set(key(r), [...(map.get(key(r)) ?? []), r]);
    return [...map].map(([g, rs]) => summarize(g, rs));
  };
  return {
    all: summarize("all", results),
    byMode: by((r) => r.mode),
    byHost: by((r) => `host ${r.host}`).sort((a, b) => a.group.localeCompare(b.group)),
    byType: by((r) => `${r.mode} / ${r.type}`).sort((a, b) => a.group.localeCompare(b.group)),
    byTask: by((r) => r.task),
  };
}

const pct = (x: number | undefined) => (x === undefined ? "–" : `${Math.round(x * 100)}%`);

function table(rows: readonly GroupSummary[]): string {
  const head = "| | n | score | first try | saved | paints | valid | as asked | judge | similarity | turns | tool calls |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|";
  const body = rows.map(
    (s) =>
      `| ${s.group} | ${s.samples} | ${s.overall.toFixed(1)} ± ${s.sd.toFixed(1)} | ${pct(s.firstTry)} | ${pct(s.saved)} | ${pct(s.rendered)} | ${pct(s.validity)} | ${pct(s.requirements)} | ${pct(s.judge)} | ${pct(s.similarity)} | ${s.turns.toFixed(1)} | ${s.toolCalls.toFixed(1)} |`,
  );
  return [head, ...body].join("\n");
}

/** The run as Markdown. */
export function markdownReport(results: readonly SampleResult[], meta: { model: string; judge?: string; turns: number; started: string }): string {
  const g = groups(results);
  const failures = results
    .flatMap((r) => r.checks.filter((c) => !c.pass).map((c) => c.name))
    .reduce((m, name) => m.set(name, (m.get(name) ?? 0) + 1), new Map<string, number>());
  const topFailures = [...failures].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const toolUse = results.reduce((m, r) => {
    for (const [name, n] of Object.entries(r.tools)) m.set(name, (m.get(name) ?? 0) + n);
    return m;
  }, new Map<string, number>());
  const lines = [
    `# Brush drafting eval`,
    "",
    `Model **${meta.model}**, judge ${meta.judge ? `**${meta.judge}**` : "none (look graded only on reference tasks, by stroke similarity)"}, up to ${meta.turns} turn(s) per sample. Started ${meta.started}. Tokens: ${g.all.tokens.input.toLocaleString()} in, ${g.all.tokens.output.toLocaleString()} out (drafting only).`,
    "",
    "Scores are 0–100 (valid 15%, as asked 25%, paints 15%, look 45%). *First try*: the brush was saved and no write tool was refused on the way. *Valid*: saved, and the host can paint it. *As asked*: the type's family and what the brief plainly asks for (on reference tasks, the same kind, medium, surface, marks and tip as the held-out preset). *Judge*: a vision model's grade of the stroke and settings. *Similarity*: coverage, colour and placement likeness to the reference stroke (rough).",
    "",
    "## Overall",
    "",
    table([g.all, ...g.byMode, ...g.byHost]),
    "",
    "## By type",
    "",
    table(g.byType),
    "",
    "## By task",
    "",
    table(g.byTask),
    "",
    "## Commonest failed checks",
    "",
    topFailures.length ? topFailures.map(([name, n]) => `- ${name}: ${n}`).join("\n") : "None.",
    "",
    "## Tools called",
    "",
    [...toolUse].sort((a, b) => b[1] - a[1]).map(([name, n]) => `- \`${name}\`: ${n}`).join("\n") || "None.",
    "",
    "## Judge notes",
    "",
    results.filter((r) => r.judge?.notes).map((r) => `- ${r.task}#${r.sample}: ${r.judge!.notes}`).join("\n") || "None.",
    "",
    "## Errors",
    "",
    results.filter((r) => r.error).map((r) => `- ${r.task}#${r.sample}: ${r.error}`).join("\n") || "None.",
    "",
    "Judge grades are AI-generated; look at the strokes (`samples/<task>/<n>/stroke.png`) before acting on them.",
    "",
  ];
  return lines.join("\n");
}
