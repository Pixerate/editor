#!/usr/bin/env node
// Turns results/*.json into the markdown tables pasted into RESULTS.md.
import { readFileSync, existsSync } from 'node:fs';

const load = (n) => (existsSync(`results/${n}.json`) ? JSON.parse(readFileSync(`results/${n}.json`, 'utf8')) : null);
const f = (x, d = 1) => (x == null || Number.isNaN(x) ? '–' : Number(x).toFixed(d));
const mb = (b) => (b / 2 ** 20).toFixed(0);
const label = { webgpu: 'WebGPU', ts: 'TypeScript' };
const name = (impl) => label[impl] ?? (impl?.startsWith('wasm') ? `wasm SIMD (${impl.slice(5)} worker${impl.slice(5) === '1' ? '' : 's'})` : impl);
const implOf = (q) => new URLSearchParams(q).get('impl');
const nice = { gpu: 'WebGPU', wasm: 'wasm SIMD', ts: 'TypeScript' };

const bench = load('bench');
if (bench) {
  console.log('### Steps per second\n');
  console.log('| Canvas | Wet (tiles dispatched) | WebGPU | wasm SIMD | TypeScript | GPU ÷ wasm |');
  console.log('|---|---|---|---|---|---|');
  const by = {};
  for (const r of bench.runs) {
    const q = new URLSearchParams(r.query);
    const key = `${q.get('size')}|${q.get('wet')}`;
    (by[key] ??= {})[q.get('impl')] = r;
  }
  for (const [key, v] of Object.entries(by)) {
    const [size, wet] = key.split('|');
    const any = Object.values(v).find((r) => r.result)?.result;
    const cell = (r) => (r?.result ? `${f(r.result.stepsPerSec, r.result.stepsPerSec < 10 ? 2 : 0)} (${f(r.result.msPerStep, 2)} ms)` : `fail${r?.error ? ': ' + r.error.split('\n')[0].slice(0, 60) : ''}`);
    const ratio = v.gpu?.result && v.wasm?.result ? f(v.gpu.result.stepsPerSec / v.wasm.result.stepsPerSec, 1) + '×' : '–';
    console.log(`| ${size}² | ${Number(wet) * 100}% (${any ? `${any.activeTiles}/${any.totalTiles}` : '?'}) | ${cell(v.gpu)} | ${cell(v.wasm)} | ${cell(v.ts)} | ${ratio} |`);
  }
  console.log('\n### Cell throughput (million cell-steps per second, active cells only)\n');
  console.log('| Canvas | Wet | WebGPU | wasm SIMD | TypeScript |');
  console.log('|---|---|---|---|---|');
  for (const [key, v] of Object.entries(by)) {
    const [size, wet] = key.split('|');
    const c = (r) => (r?.result ? f((r.result.activeTiles * 65536 * r.result.stepsPerSec) / 1e6, 0) : '–');
    console.log(`| ${size}² | ${Number(wet) * 100}% | ${c(v.gpu)} | ${c(v.wasm)} | ${c(v.ts)} |`);
  }
  console.log('\n### Memory and load while stepping\n');
  console.log('| Run | Sim state (MB) | Renderer RSS max (MB) | GPU-process RSS max (MB) | Renderer CPU avg % | GPU-process CPU avg % | GPU util avg / max % |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of bench.runs) {
    const q = new URLSearchParams(r.query);
    const m = r.result?.memory;
    const state = m ? mb(Object.entries(m).filter(([k]) => k !== 'wasmMemoryTotal').reduce((a, [, b]) => a + b, 0)) : '–';
    const l = r.load;
    console.log(`| ${nice[q.get('impl')]} ${q.get('size')}² ${Number(q.get('wet')) * 100}% | ${state} | ${f(l?.rendererRssMaxMB, 0)} | ${f(l?.gpuProcRssMaxMB, 0)} | ${f(l?.rendererCpuAvg, 0)} | ${f(l?.gpuProcCpuAvg, 0)} | ${f(l?.gpuUtilAvg, 0)} / ${f(l?.gpuUtilMax, 0)} |`);
  }
  const g = bench.runs.find((r) => r.result?.gpu)?.result.gpu;
  if (g) console.log(`\nAdapter: ${g.adapter}; limits ${JSON.stringify(g.limits)}`);
}

const lat = load('latency');
if (lat) {
  console.log('\n### Dab to pixels (64 px dab, then 1 step, then present the dab tiles)\n');
  console.log('| Impl | Canvas | Rest of canvas | First dab (ms) | Median of next 8 (ms) | Max (ms) |');
  console.log('|---|---|---|---|---|---|');
  for (const r of lat.runs) {
    const q = new URLSearchParams(r.query);
    const x = r.result;
    console.log(`| ${nice[implOf(r.query)]} | ${q.get('size')}² | ${Number(q.get('busy')) ? `${Number(q.get('busy')) * 100}% wet (${x?.activeTiles ?? '?'} tiles active at end)` : 'dry'} | ${x ? f(x.firstMs) : 'fail'} | ${x ? f(x.medianMs) : '–'} | ${x ? f(x.maxMs) : '–'} |`);
  }
}

const sc = load('scaling');
if (sc?.runs[0]?.result) {
  const s = sc.runs[0].result;
  console.log(`\n### wasm worker scaling (${s.size}², ${s.wet * 100}% wet, ${s.hardwareConcurrency} logical cores)\n`);
  console.log('| Workers | ms / step | steps / s | speed-up vs 1 |');
  console.log('|---|---|---|---|');
  const one = s.res[0].msPerStep;
  for (const r of s.res) console.log(`| ${r.workers} | ${f(r.msPerStep, 2)} | ${f(r.stepsPerSec, 1)} | ${f(one / r.msPerStep, 2)}× |`);
}

const dv = load('diverge');
if (dv?.runs[0]?.result) {
  const d = dv.runs[0].result;
  console.log(`\n### Divergence from the TypeScript reference (${d.size}², ${d.steps} steps, flow map + tilt, 6 dabs)\n`);
  console.log('| Impl | Step | water max abs | water rel RMS | pigment (suspended) max abs | deposit max abs | RGBA8 wet: max Δ / % px | RGBA8 dried: max Δ / % px |');
  console.log('|---|---|---|---|---|---|---|---|');
  const seen = new Set();
  for (const c of d.cmp) {
    // wasm×1 and the second GPU run are bit-identical to their siblings (see the hashes)
    if (c.impl === 'wasm×1' || seen.has(c.impl)) continue;
    seen.add(c.impl);
    for (const s of c.byStep) {
      if (s.step % 100 || s.step === 0) continue;
      console.log(`| ${name(c.impl)} | ${s.step} | ${s.rho.maxAbs.toExponential(1)} | ${s.rho.relRms.toExponential(1)} | ${s.p.maxAbs.toExponential(1)} | ${s.d.maxAbs.toExponential(1)} | ${s.wetRgba8.maxChannelDiff} / ${(s.wetRgba8.fracPixelsDiffer * 100).toFixed(3)} | ${s.dryRgba8.maxChannelDiff} / ${(s.dryRgba8.fracPixelsDiffer * 100).toFixed(3)} |`);
    }
  }
  console.log('\nState hashes at step 500 (FNV-1a of the f32 planes and of the dried RGBA8):\n');
  console.log('| Run | State | Dried RGBA8 |');
  console.log('|---|---|---|');
  for (const h of d.dryHash) console.log(`| ${name(h.impl)} | \`${h.state}\` | \`${h.dryBake}\` |`);
  console.log('\nConservation with evaporation and absorption off (300 steps):\n');
  console.log('| Impl | Water drift | Pigment drift |');
  console.log('|---|---|---|');
  for (const c of d.conservation) console.log(`| ${name(c.impl)} | ${c.waterDrift.toExponential(1)} | ${c.pigmentDrift.toExponential(1)} |`);
  console.log('\nRun time of the 500-step check:', d.meta.map((m) => `${name(m.impl)} ${f(m.ms / 1000, 2)} s`).join(', '));
}
