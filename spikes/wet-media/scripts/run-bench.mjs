#!/usr/bin/env node
/**
 * Runs the benchmark matrix in Chrome (headed, so WebGPU and rAF behave as for a user).
 * Each configuration gets a fresh page so memory and JIT state don't leak between runs.
 * While a configuration is in its measured phase this script samples:
 *   - CPU % and RSS of every Chrome process (ps), grouped into browser / renderer / gpu / other
 *   - Apple GPU "Device Utilization %" (ioreg IOAccelerator PerformanceStatistics; no sudo needed)
 *
 * usage: node scripts/run-bench.mjs [--only bench|latency|diverge|scaling] [--chrome <path>] [--quick]
 * env CHROME overrides the browser path. Results: results/<name>.json
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] ?? true : d;
};
const only = opt('only', null);
const quick = !!opt('quick', false);
const chromePath = process.env.CHROME ?? opt('chrome',
  `${homedir()}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`);
if (!existsSync(chromePath)) throw new Error(`Chrome not found at ${chromePath}`);

mkdirSync('results', { recursive: true });
const PORT = 5199;
const base = `http://localhost:${PORT}/`;

function startVite() {
  const p = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((res, rej) => {
    p.stdout.on('data', (d) => { if (String(d).includes('Local')) res(p); });
    p.on('exit', (c) => rej(new Error(`vite exited ${c}`)));
  });
}

function gpuUtil() {
  try {
    const s = execFileSync('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator'], { encoding: 'utf8' });
    const m = s.match(/"Device Utilization %"=(\d+)/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

function chromeProcs() {
  const s = execFileSync('ps', ['-axo', 'pid=,%cpu=,rss=,command='], { encoding: 'utf8' });
  const out = { browser: { cpu: 0, rssMB: 0 }, renderer: { cpu: 0, rssMB: 0 }, gpu: { cpu: 0, rssMB: 0 }, other: { cpu: 0, rssMB: 0 } };
  for (const line of s.split('\n')) {
    if (!line.includes('Google Chrome for Testing') && !line.includes(chromePath)) continue;
    const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const cmd = m[4];
    const kind = cmd.includes('--type=renderer') ? 'renderer' : cmd.includes('--type=gpu-process') ? 'gpu' : cmd.includes('--type=') ? 'other' : 'browser';
    out[kind].cpu += Number(m[2]);
    out[kind].rssMB += Number(m[3]) / 1024;
  }
  return out;
}

/** Sample while `measuring` is true; returns averages and peaks. */
function sampler() {
  let timer = null;
  const samples = [];
  return {
    start() {
      samples.length = 0;
      const tick = () => {
        samples.push({ t: Date.now(), gpu: gpuUtil(), procs: chromeProcs() });
      };
      tick();
      timer = setInterval(tick, 400);
    },
    stop() {
      clearInterval(timer);
      timer = null;
      // ps %cpu is a decaying average; drop the first sample (taken before load ramps up)
      const s = samples.slice(1);
      if (!s.length) return null;
      const avg = (f) => s.reduce((a, x) => a + (f(x) ?? 0), 0) / s.length;
      const max = (f) => Math.max(...s.map((x) => f(x) ?? 0));
      return {
        samples: s.length,
        gpuUtilAvg: avg((x) => x.gpu), gpuUtilMax: max((x) => x.gpu),
        rendererCpuAvg: avg((x) => x.procs.renderer.cpu), gpuProcCpuAvg: avg((x) => x.procs.gpu.cpu),
        rendererRssMaxMB: max((x) => x.procs.renderer.rssMB), gpuProcRssMaxMB: max((x) => x.procs.gpu.rssMB),
      };
    },
  };
}

async function runPage(browser, query, { timeout = 600_000 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const page = await ctx.newPage();
  const smp = sampler();
  let load = null;
  await page.exposeFunction('__phase', async (name) => {
    if (name === 'measure') smp.start();
    else if (name === 'idle') load = smp.stop();
  });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.goto(base + query);
  let result, error;
  try {
    await page.waitForFunction(() => window.__result || window.__error, null, { timeout, polling: 250 });
    result = await page.evaluate(() => window.__result);
    error = await page.evaluate(() => window.__error);
  } catch (e) {
    error = `timeout/crash: ${e.message}`;
  }
  // ensure sampling is stopped even on failure
  if (!load) load = smp.stop();
  await ctx.close();
  return { query, result, error, load, consoleErrors: consoleErrors.slice(0, 5) };
}

const launch = () => chromium.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--js-flags=--expose-gc', '--enable-precise-memory-info', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});

const vite = await startVite();
let browser = await launch();
const version = browser.version();
console.log('Chrome', version);

async function suite(name, queries) {
  const out = [];
  for (const q of queries) {
    process.stdout.write(`${name}: ${q} ... `);
    let r = await runPage(browser, q);
    if (r.error && /crash|closed|Target/.test(r.error)) {
      // relaunch after a renderer / GPU process crash (e.g. out of memory)
      try { await browser.close(); } catch {}
      browser = await launch();
    }
    console.log(r.error ? `ERROR ${r.error.split('\n')[0]}` : 'ok');
    const imgs = r.result?.images;
    if (imgs) {
      for (const [k, v] of Object.entries(imgs)) writeFileSync(`results/${k}.png`, Buffer.from(v.split(',')[1], 'base64'));
      r.result.images = Object.keys(imgs).map((k) => `${k}.png`);
    }
    out.push(r);
    writeFileSync(`results/${name}.json`, JSON.stringify({ chrome: version, date: new Date().toISOString(), runs: out }, null, 1));
  }
  return out;
}

const sizes = quick ? [1024] : [1024, 2048, 4096];
const wets = quick ? [0.5] : [0.1, 0.5, 1];
const impls = ['gpu', 'wasm', 'ts'];

try {
  const one = opt('query', null);
  if (one) { const r = await suite('one', [one]); console.log(JSON.stringify(r[0], null, 1).slice(0, 6000)); }
  else {
  if (!only || only === 'bench') {
    const qs = [];
    for (const impl of impls) for (const size of sizes) for (const wet of wets) qs.push(`?mode=bench&impl=${impl}&size=${size}&wet=${wet}`);
    await suite('bench', qs);
  }
  if (!only || only === 'latency') {
    const qs = [];
    for (const impl of impls) for (const size of sizes) for (const busy of [0, 0.5]) qs.push(`?mode=latency&impl=${impl}&size=${size}&busy=${busy}`);
    await suite('latency', qs);
  }
  if (!only || only === 'diverge') await suite('diverge', ['?mode=diverge&size=512&steps=500']);
  if (!only || only === 'scaling') await suite('scaling', ['?mode=scaling&size=2048&wet=1']);
  if (!only || only === 'readback') await suite('readback', ['?mode=readback&size=2048']);
  }
} finally {
  await browser.close();
  vite.kill();
}
