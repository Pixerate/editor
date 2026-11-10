import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createFakeEffectProvider } from '../src/effects';
import { createPaintConformanceHost } from '../src/paint-editor';
import { decodePng } from '../src/raster';
import { ConformanceIds, conformanceValuesMatch, normalizeConformanceValue, omitConformancePaths, runConformanceScenario, type ConformanceScenario } from '../src/tools/conformance';
import { validateJsonSchema, type JsonSchema } from '../src/tools/schema';

/**
 * Replays the paint scenarios of `@pixerate/conformance` (`domains/paint/fixtures`), the ones the
 * Swift port replays too, and checks this core still produces what they record. After an intended
 * change, run `pnpm --filter @pixerate/editor build && pnpm conformance:record` and commit.
 */
const dir = new URL('../../conformance/domains/paint/fixtures/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const scenarios = files.map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as ConformanceScenario);
const schema = JSON.parse(readFileSync(new URL('../../conformance/schema/fixture.schema.json', import.meta.url), 'utf8')) as JsonSchema;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('the paint conformance scenarios', () => {
  it('are valid scenarios, each named after its file', () => {
    expect(scenarios.length).toBeGreaterThan(0);
    for (const [i, s] of scenarios.entries()) {
      expect(validateJsonSchema(s, schema), files[i]).toEqual([]);
      expect(`${s.id}.json`).toBe(files[i]);
      for (const step of s.steps) expect(step.expect, `${s.id} ${step.tool} is recorded`).toBeDefined();
    }
  });

  it('use every paint tool at least once (a new tool needs a scenario)', () => {
    const tools = (JSON.parse(readFileSync(new URL('../tools.json', dir), 'utf8')) as { providers: Array<{ tools: Array<{ name: string }> }> }).providers.flatMap((p) => p.tools.map((t) => t.name));
    const used = new Set(scenarios.flatMap((s) => s.steps.map((step) => step.tool)));
    expect(tools.filter((t) => !used.has(t))).toEqual([]);
    expect([...used].filter((t) => !tools.includes(t))).toEqual([]);
  });

  it.each(scenarios.map((s) => [s.id, s] as const))('%s replays as recorded', async (_id, scenario) => {
    const outputs = await runConformanceScenario(scenario, createPaintConformanceHost(scenario.setup ?? {}, { effects: createFakeEffectProvider() }));
    scenario.steps.forEach((step, i) => {
      const label = `step ${i + 1} (${step.tool})`;
      const out = outputs[i]!;
      // Numbers within CONFORMANCE_NUMBER_TOLERANCE match (trig may differ in the last bits across CPUs); toEqual shows the diff.
      if (!conformanceValuesMatch(out.result, step.expect!.result)) expect(out.result, label).toEqual(step.expect!.result);
      expect(out.isError, label).toBe(step.expect!.isError === true);
      if ((step.reload || step.load !== undefined) && !conformanceValuesMatch(out.loaded, step.expect!.loaded)) expect(out.loaded, `${label} loaded`).toEqual(step.expect!.loaded);
      if (step.document && !conformanceValuesMatch(out.document, step.expect!.document)) expect(out.document, `${label} document`).toEqual(step.expect!.document);
      if (step.pixels) {
        const recorded = step.expect!.pixels!;
        expect(sha256(out.pixels!.data), `${label} pixels`).toBe(recorded.sha256);
        const png = decodePng(new Uint8Array(readFileSync(new URL(recorded.file, dir))));
        expect([png.width, png.height], `${label} ${recorded.file}`).toEqual([recorded.width, recorded.height]);
        expect(sha256(new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength)), `${recorded.file} holds the recorded pixels`).toBe(recorded.sha256);
      }
    });
  }, 60_000);

  // A reload step compares the other implementation's reopened document with this core's, which
  // only proves a feature survives saving if this core's own save → load → save loses nothing.
  const reloading = scenarios.filter((s) => s.steps.some((step) => step.reload));
  it.each(reloading.map((s) => [s.id, s] as const))('%s reopens what it saved unchanged', async (_id, scenario) => {
    const host = createPaintConformanceHost(scenario.setup ?? {}, { effects: createFakeEffectProvider() });
    const save = host.save!.bind(host);
    const load = host.load!.bind(host);
    // `lastGrownAt` is the clock at save time (growWhileClosed); everything else must come back as saved.
    const comparable = (doc: unknown) => {
      const copy = JSON.parse(JSON.stringify(doc)) as { cultures?: { lastGrownAt?: number } };
      delete copy.cultures?.lastGrownAt;
      return copy;
    };
    let pending: { pixels: string } | null = null;
    let checked = 0;
    host.save = () => {
      pending = { pixels: sha256(host.pixels({}).data) };
      return save();
    };
    host.load = (document) => {
      const reload = pending;
      pending = null;
      const problems = load(document);
      // `load` steps open another document on purpose; only reloads must change nothing.
      if (!reload) return problems;
      checked++;
      expect(problems, `${scenario.id}: problems reopening its own save`).toEqual([]);
      expect(comparable(save()), `${scenario.id}: the document saved again after reopening`).toEqual(comparable(document));
      expect(sha256(host.pixels({}).data), `${scenario.id}: the pixels after reopening`).toBe(reload.pixels);
      return problems;
    };
    await runConformanceScenario(scenario, host);
    expect(checked).toBe(scenario.steps.filter((step) => step.reload).length);
  }, 60_000);
});

describe('conformance normalization', () => {
  const isId = (v: string) => /^pl[0-9a-z]{9,}$/.test(v);

  it('numbers generated ids in a fixed order and replaces them everywhere, keeping other ids', () => {
    const ids = new ConformanceIds();
    const value = { layers: [{ name: 'B', id: 'plb000000002' }, { id: 'pla000000001', name: 'A' }], active: 'pla000000001', strokeId: 's1', brush: 'ink-pen' };
    // Keys are walked sorted, so `active` numbers its id before `layers` does
    expect(normalizeConformanceValue(value, ids, isId)).toEqual({ active: '@1', brush: 'ink-pen', layers: [{ id: '@2', name: 'B' }, { id: '@1', name: 'A' }], strokeId: 's1' });
    // The numbering carries over, ids inside messages and object keys are replaced too
    expect(normalizeConformanceValue({ message: 'Unknown layer "plb000000002".', byLayer: { pla000000001: 1 }, id: 'plc000000003' }, ids, isId)).toEqual({ byLayer: { '@1': 1 }, id: '@3', message: 'Unknown layer "@2".' });
    expect(ids.resolve('@3')).toBe('plc000000003');
  });

  it('hides binary payloads and clock times', () => {
    const ids = new ConformanceIds();
    expect(normalizeConformanceValue({ png: 'A'.repeat(200), short: 'AAAA', url: 'data:image/png;base64,AA', at: '2026-11-04T01:06:52.993Z', day: '2026-11-04' }, ids)).toEqual({ at: '<time>', day: '2026-11-04', png: '<binary>', short: 'AAAA', url: '<binary>' });
  });

  it('leaves out ignored paths, with * for every element or member', () => {
    expect(omitConformancePaths({ a: 1, backend: { x: 1 }, layers: [{ engine: 1, id: 'x' }, { engine: 2, id: 'y' }] }, ['/backend', '/layers/*/engine'])).toEqual({ a: 1, layers: [{ id: 'x' }, { id: 'y' }] });
    expect(omitConformancePaths({ m: { a: { k: 1, j: 2 }, b: { k: 3 } } }, ['/m/*/k'])).toEqual({ m: { a: { j: 2 }, b: {} } });
  });
});

describe('conformance value matching', () => {
  it('matches numbers within a relative 1e-9, like the Swift runner, and nothing else loosely', () => {
    expect(conformanceValuesMatch({ m: [0.6595295122134217, 173.18813153712776] }, { m: [0.6595295122134215, 173.18813153712782] })).toBe(true);
    expect(conformanceValuesMatch({ a: 1 }, { a: 1.000001 })).toBe(false);
    expect(conformanceValuesMatch({ a: 'x' }, { a: 'y' })).toBe(false);
    expect(conformanceValuesMatch({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(conformanceValuesMatch([1, 2], [1, 2, 3])).toBe(false);
    expect(conformanceValuesMatch({ a: null }, { a: 0 })).toBe(false);
  });
});
