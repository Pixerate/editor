#!/usr/bin/env node
/**
 * Compares eval runs side by side: `node src/compare.ts results/<run-a> results/<run-b> [--out compare.md]`.
 * Prints Markdown; the runs should share tasks, samples and judge for the numbers to mean much.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { summarize, type GroupSummary } from "./report.ts";
import type { SampleResult } from "./types.ts";

export interface Run {
  /** The folder it was read from. */
  dir: string;
  meta: { model: string; judge?: string; turns: number; samples?: number };
  results: SampleResult[];
}

export function readRun(dir: string): Run {
  const file = path.join(dir, "results.json");
  const data = JSON.parse(readFileSync(file, "utf8")) as Partial<Run>;
  if (!data.meta || !Array.isArray(data.results)) throw new Error(`${file} is not an eval run's results.json.`);
  return { dir, meta: data.meta, results: data.results };
}

/** A model spec as a short name: a command model by its last word (the adapters' model id), others without their scheme. */
export const label = (spec: string) => (spec.startsWith("command:") ? spec.trim().split(/\s+/).at(-1)! : spec.replace(/^[a-z]+:/, ""));

const pct = (x: number | undefined) => (x === undefined ? "–" : `${Math.round(x * 100)}%`);
const signed = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}`;

/** Which tasks both runs have, and what differs between the runs' setups. */
export function caveats(runs: readonly Run[]): string[] {
  const notes: string[] = [];
  const judges = new Set(runs.map((r) => r.meta.judge ?? "none"));
  if (judges.size > 1) notes.push(`The runs were judged by different models (${[...judges].join(", ")}), so their judge and overall scores are not comparable.`);
  const turns = new Set(runs.map((r) => r.meta.turns));
  if (turns.size > 1) notes.push(`The runs allowed different numbers of turns (${[...turns].join(", ")}).`);
  const taskSets = runs.map((r) => new Set(r.results.map((x) => x.task)));
  const shared = [...taskSets[0]!].filter((t) => taskSets.every((s) => s.has(t)));
  const all = new Set(taskSets.flatMap((s) => [...s]));
  if (shared.length < all.size) notes.push(`Only ${shared.length} of ${all.size} tasks are in every run; the tables use only those.`);
  for (const r of runs) {
    if (r.meta.judge && runs.some((o) => o.meta.model === r.meta.judge)) notes.push(`${label(r.meta.judge)} judged its own drafts: models tend to favour their own work, so re-judge both runs with another model (\`--model replay:<run>/answers --judge …\`) before trusting a close result.`);
  }
  return [...new Set(notes)];
}

/** The comparison as Markdown. */
export function compareRuns(runs: readonly Run[]): string {
  if (runs.length < 2) throw new Error("Give at least two runs to compare.");
  const taskSets = runs.map((r) => new Set(r.results.map((x) => x.task)));
  const shared = new Set([...taskSets[0]!].filter((t) => taskSets.every((s) => s.has(t))));
  const results = runs.map((r) => r.results.filter((x) => shared.has(x.task)));
  const names = runs.map((r) => label(r.meta.model));

  const rows = (key: (r: SampleResult) => string, label: string) => {
    const groups = [...new Set(results.flat().map(key))].sort();
    const head = `| ${label} | ${names.map((n) => `${n} score`).join(" | ")} | Δ | ${names.map((n) => `${n} first try`).join(" | ")} |\n|---|${names.map(() => "---:").join("|")}|---:|${names.map(() => "---:").join("|")}|`;
    const body = groups.map((g) => {
      const s = results.map((rs) => summarize(g, rs.filter((r) => key(r) === g)));
      return `| ${g} | ${s.map((x) => `${x.overall.toFixed(1)} ± ${x.sd.toFixed(1)}`).join(" | ")} | ${signed(s[1]!.overall - s[0]!.overall)} | ${s.map((x) => pct(x.firstTry)).join(" | ")} |`;
    });
    return [head, ...body].join("\n");
  };

  const overall: GroupSummary[] = results.map((rs, i) => summarize(names[i]!, rs));
  const areas = `| | ${names.join(" | ")} |\n|---|${names.map(() => "---:").join("|")}|\n${[
    ["Score", (s: GroupSummary) => `${s.overall.toFixed(1)} ± ${s.sd.toFixed(1)}`],
    ["Samples", (s: GroupSummary) => String(s.samples)],
    ["First try", (s: GroupSummary) => pct(s.firstTry)],
    ["Saved", (s: GroupSummary) => pct(s.saved)],
    ["Paints", (s: GroupSummary) => pct(s.rendered)],
    ["Valid", (s: GroupSummary) => pct(s.validity)],
    ["As asked", (s: GroupSummary) => pct(s.requirements)],
    ["Judge", (s: GroupSummary) => pct(s.judge)],
    ["Similarity", (s: GroupSummary) => pct(s.similarity)],
    ["Turns", (s: GroupSummary) => s.turns.toFixed(2)],
    ["Tool calls", (s: GroupSummary) => s.toolCalls.toFixed(1)],
    ["Tokens in / out", (s: GroupSummary) => `${s.tokens.input.toLocaleString()} / ${s.tokens.output.toLocaleString()}`],
  ]
    .map(([label, f]) => `| ${label as string} | ${overall.map(f as (s: GroupSummary) => string).join(" | ")} |`)
    .join("\n")}`;

  // Per task, which run's mean was higher (a tie within 2 points counts as neither).
  const tasks = [...shared].sort();
  let wins = 0, losses = 0, ties = 0;
  for (const t of tasks) {
    const [a, b] = results.map((rs) => summarize(t, rs.filter((r) => r.task === t)).overall);
    if (Math.abs(b! - a!) <= 2) ties++;
    else if (b! > a!) wins++;
    else losses++;
  }

  const notes = caveats(runs);
  return [
    `# ${names.join(" vs ")}`,
    "",
    `Runs: ${runs.map((r) => `\`${r.dir}\``).join(", ")}. Judge: ${[...new Set(runs.map((r) => (r.meta.judge ? label(r.meta.judge) : "none")))].join(", ")}. Δ is ${names[1]} minus ${names[0]}.`,
    "",
    ...(notes.length ? ["## Caveats", "", ...notes.map((n) => `- ${n}`), ""] : []),
    "## Overall",
    "",
    areas,
    "",
    `Per task: ${names[1]} higher on ${wins}, ${names[0]} higher on ${losses}, within 2 points on ${ties} (of ${tasks.length}).`,
    "",
    "## By mode",
    "",
    rows((r) => r.mode, "Mode"),
    "",
    "## By host",
    "",
    rows((r) => r.host, "Host"),
    "",
    "## By type",
    "",
    rows((r) => `${r.mode} / ${r.type}`, "Type"),
    "",
    "## By task",
    "",
    rows((r) => r.task, "Task"),
    "",
    "Scores and judge grades are AI-generated; review the strokes (`samples/<task>/<n>/stroke.png`) before acting on a difference.",
    "",
  ].join("\n");
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: "string" } } });
  const report = compareRuns(positionals.map(readRun));
  if (values.out) writeFileSync(values.out, report);
  process.stdout.write(report);
}

if (import.meta.main) main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
