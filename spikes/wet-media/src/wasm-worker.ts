/// <reference lib="webworker" />
/**
 * One wasm SIMD worker. All workers share one WebAssembly.Memory. Per step:
 *   1. step tiles (taken from the active list with an atomic counter, so work balances)
 *   2. barrier; the leader grows the active set from the flags
 *   3. barrier; halo exchange of the freshly written set, tiles again taken atomically
 *   4. barrier
 */
import {
  CTL_ACTIVE_COUNT, CTL_BAR_COUNT, CTL_BAR_GEN, CTL_PARITY, CTL_WORK,
  type Layout, Views, applyFlags, fillHalo, slotBase,
} from './wasm-layout';

const CTL_WORK2 = 9;

let layout: Layout;
let memory: WebAssembly.Memory;
let stepFn: (base: number, parity: number, hasFlow: number) => number;
let id = 0;
let nWorkers = 1;

function barrier(ctl: Int32Array): void {
  const gen = Atomics.load(ctl, CTL_BAR_GEN);
  if (Atomics.add(ctl, CTL_BAR_COUNT, 1) === nWorkers - 1) {
    Atomics.store(ctl, CTL_BAR_COUNT, 0);
    Atomics.add(ctl, CTL_BAR_GEN, 1);
    Atomics.notify(ctl, CTL_BAR_GEN);
  } else {
    while (Atomics.load(ctl, CTL_BAR_GEN) === gen) Atomics.wait(ctl, CTL_BAR_GEN, gen);
  }
}

function run(steps: number): number {
  const v = new Views(memory.buffer);
  const ctl = v.ctl;
  let parity = ctl[CTL_PARITY];
  let busy = 0;
  for (let s = 0; s < steps; s++) {
    const t0 = performance.now();
    // 1. step
    for (;;) {
      const a = Atomics.add(ctl, CTL_WORK, 1);
      if (a >= ctl[CTL_ACTIVE_COUNT]) break;
      const tile = v.list[a];
      v.flags[tile] = stepFn(slotBase(layout, v.table[tile]), parity, layout.hasFlow ? 1 : 0);
    }
    if (id === 0) Atomics.store(ctl, CTL_WORK2, 0);
    busy += performance.now() - t0;
    barrier(ctl);
    // 2. grow
    if (id === 0) {
      Atomics.store(ctl, CTL_WORK, 0);
      applyFlags(layout, v);
    }
    barrier(ctl);
    // 3. halo exchange of the set just written
    const t1 = performance.now();
    for (;;) {
      const a = Atomics.add(ctl, CTL_WORK2, 1);
      if (a >= ctl[CTL_ACTIVE_COUNT]) break;
      fillHalo(layout, v, v.list[a], 1 - parity);
    }
    busy += performance.now() - t1;
    parity = 1 - parity;
    barrier(ctl);
  }
  if (id === 0) ctl[CTL_PARITY] = parity;
  return busy;
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') {
    layout = m.layout;
    memory = m.memory;
    id = m.id;
    nWorkers = m.nWorkers;
    const inst = await WebAssembly.instantiate(m.module as WebAssembly.Module, {
      env: { memory, abort: () => { throw new Error('abort'); } },
    });
    stepFn = inst.exports.step as typeof stepFn;
    self.postMessage({ type: 'ready', id });
  } else if (m.type === 'run') {
    if (m.nWorkers) nWorkers = m.nWorkers;
    if (id >= nWorkers) return;
    const busy = run(m.steps);
    self.postMessage({ type: 'done', id, busy });
  }
};
