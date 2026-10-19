#!/usr/bin/env node
// Fills RESULTS.template.md with the tables from scripts/summarize.mjs and results/*.json -> RESULTS.md
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const tables = execFileSync('node', ['scripts/summarize.mjs'], { encoding: 'utf8' });
const section = (title) => {
  const i = tables.indexOf(`### ${title}`);
  if (i < 0) return `_${title}: not run_`;
  const j = tables.indexOf('\n### ', i + 4);
  return tables.slice(i, j < 0 ? undefined : j).trim();
};
let t = readFileSync('RESULTS.template.md', 'utf8');
t = t.replace('{{steps}}', `${section('Steps per second')}\n\n${section('Cell throughput')}`);
t = t.replace('{{memory}}', section('Memory and load'));
t = t.replace('{{latency}}', section('Dab to pixels'));
t = t.replace('{{scaling}}', section('wasm worker scaling'));
t = t.replace('{{diverge}}', section('Divergence from the TypeScript reference'));
if (existsSync('results/readback.json')) {
  const rb = JSON.parse(readFileSync('results/readback.json', 'utf8')).runs[0].result.res;
  const rows = rb.map((r) => `| ${r.impl.startsWith('wasm') ? 'wasm path (JS shading, main thread)' : 'WebGPU (shade + copy + mapAsync)'} | ${r.tiles} | ${r.mbPerFrame} | ${r.medianMs.toFixed(1)} |`);
  t = t.replace('{{readback}}', ['| Path | Tiles | MB | Median ms |', '|---|---|---|---|', ...rows].join('\n'));
}
if (existsSync('results/safari.json')) {
  const runs = JSON.parse(readFileSync('results/safari.json', 'utf8')).runs;
  const get = (q) => {
    const r = runs.find((x) => x.query.includes(q))?.result;
    return r ? `${r.stepsPerSec.toFixed(0)} (${r.msPerStep.toFixed(2)} ms)` : 'not run';
  };
  t = t.replace('{{s_gpu2048}}', get('impl=gpu&size=2048')).replace('{{s_wasm2048}}', get('impl=wasm&size=2048'))
    .replace('{{s_gpu4096}}', get('impl=gpu&size=4096')).replace('{{s_wasm4096}}', get('impl=wasm&size=4096'));
}
writeFileSync('RESULTS.md', t);
