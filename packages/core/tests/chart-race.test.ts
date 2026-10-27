// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools";
import { CommandRegistry, createCommandToolProvider } from "../src/commands";
import {
  ChartController,
  chartFromMermaid,
  chartRaceMoment,
  chartRaceRanking,
  chartRaceValueAt,
  chartToMermaid,
  chartToOoxml,
  chartValueAtPoint,
  createChartCommands,
  createChartSpec,
  createChartToolProvider,
  describeChart,
  layoutChart,
  normalizeChartSpec,
  recommendChartTypes,
  type ChartMark,
  type ChartRaceTicker,
  type ChartScene,
  type ChartSpec,
} from "../src/chart";

const race: Partial<ChartSpec> = {
  type: "barrace",
  title: "Product sales",
  raceTopN: 3,
  categories: ["2021", "2022", "2023", "2024"],
  series: [
    { id: "core", name: "Core", values: [40, 44, 48, 50] },
    { id: "cloud", name: "Cloud", values: [10, 25, 45, 70] },
    { id: "addons", name: "Add-ons", values: [30, 28, 26, 24] },
    { id: "services", name: "Services", values: [20, null, 30, 35] },
  ],
};

const SIZE = { width: 640, height: 400 };
const scene = (spec: Partial<ChartSpec>, raceFrame?: number | null) => layoutChart(createChartSpec(spec), { ...SIZE, raceFrame });
const byKey = (s: ChartScene, key: string) => s.marks.find((m) => m.key === key);
const rect = (m: ChartMark | undefined) => {
  if (m?.kind !== "rect") throw new Error(`expected a rect, got ${m?.kind}`);
  return m;
};

/** A ticker the test advances by hand. */
function manualTicker(): ChartRaceTicker & { advance(ms: number): void; pending(): number } {
  let t = 0;
  let queued: (() => void)[] = [];
  return {
    now: () => t,
    next: (step) => {
      queued.push(step);
      return () => (queued = queued.filter((q) => q !== step));
    },
    advance(ms) {
      t += ms;
      const run = queued;
      queued = [];
      run.forEach((step) => step());
    },
    pending: () => queued.length,
  };
}

describe("race values and rankings", () => {
  it("fills gaps with the last known value and eases between time points", () => {
    expect(chartRaceValueAt({ values: [null, 5, null] }, 0)).toBe(0);
    expect(chartRaceValueAt({ values: [null, 5, null] }, 2)).toBe(5);
    expect(chartRaceMoment(4, 2.25)).toEqual({ from: 2, to: 3, t: 0.25, at: 2.25 });
    expect(chartRaceMoment(4, null)).toEqual({ from: 3, to: 3, t: 0, at: 3 });
    expect(chartRaceMoment(4, 9).at).toBe(3);
  });

  it("ranks names at a moment, places sliding between rankings", () => {
    const spec = createChartSpec(race);
    expect(chartRaceRanking(spec, 0).map((e) => e.name)).toEqual(["Core", "Add-ons", "Services", "Cloud"]);
    expect(chartRaceRanking(spec, 3).map((e) => e.name)).toEqual(["Cloud", "Core", "Services", "Add-ons"]);
    // Services has no value in 2022 and keeps 20.
    expect(chartRaceRanking(spec, 1).find((e) => e.seriesId === "services")!.value).toBe(20);
    const half = chartRaceRanking(spec, 2.5);
    const cloud = half.find((e) => e.seriesId === "cloud")!;
    expect(cloud.value).toBeCloseTo(57.5, 6);
    expect(cloud.position).toBeCloseTo(0.5, 6); // from 2nd in 2023 to 1st in 2024
    expect(cloud.rank).toBe(0); // nearest time point: 2024
  });

  it("checks raceTopN", () => {
    expect(createChartSpec({ type: "barrace" }).raceTopN).toBe(10);
    expect(normalizeChartSpec({ raceTopN: 50 }).issues[0].message).toBe("raceTopN must be a whole number of bars from 1 to 30.");
  });
});

describe("bar race layout", () => {
  it("draws the top names at the last time point by default, ranked top to bottom", () => {
    const s = scene(race);
    const y = (id: string) => rect(byKey(s, `bar-${id}`)).y;
    expect(y("cloud")).toBeLessThan(y("core"));
    expect(y("core")).toBeLessThan(y("services"));
    expect(byKey(s, "bar-addons")).toBeUndefined(); // 4th with raceTopN 3
    expect(byKey(s, "race-time")).toMatchObject({ text: "2024", role: "race-time" });
    expect(byKey(s, "label-name-cloud")).toMatchObject({ text: "Cloud", anchor: "end" });
    expect(byKey(s, "label-cloud")).toMatchObject({ text: "70" });
    expect(s.warnings.map((w) => w.message)).toContain("The race shows the top 3 of 4 names at each moment (raceTopN).");
    expect(s.marks.filter((m) => m.role === "legend-label")).toHaveLength(0);
  });

  it("draws any moment, keeping bar keys per series so frames blend", () => {
    const early = scene(race, 0);
    expect(byKey(early, "race-time")).toMatchObject({ text: "2021" });
    expect(byKey(early, "bar-cloud")).toBeUndefined();
    const mid = scene(race, 2.5);
    const later = scene(race, 2.6);
    // Cloud leads and fills the scale; Core shrinks against it as Cloud grows.
    const ratio = (sc: ChartScene) => rect(byKey(sc, "bar-core")).width / rect(byKey(sc, "bar-cloud")).width;
    expect(ratio(later)).toBeLessThan(ratio(mid));
    expect(rect(byKey(mid, "bar-cloud")).y).toBeGreaterThan(rect(byKey(later, "bar-cloud")).y);
    expect(byKey(mid, "race-time")).toMatchObject({ text: "2024" });
  });

  it("can be dragged: bars select the nearest time point and the scene has a value scale", () => {
    const s = scene(race, 1.2);
    const bar = rect(byKey(s, "bar-core"));
    expect(bar.target).toEqual({ kind: "point", seriesId: "core", index: 1 });
    expect(chartValueAtPoint(s, { x: bar.x + bar.width, y: bar.y })).toBeCloseTo(44.8, 6);
  });
});

describe("ChartController race playback", () => {
  it("shows a moment as view state, not an undo step", () => {
    const c = new ChartController({ spec: race });
    expect(c.setRaceFrame(1.5)).toEqual({ ok: true });
    expect(c.getState()).toMatchObject({ raceFrame: 1.5, racePlaying: false, canUndo: false });
    expect(c.setRaceFrame(7)).toEqual({ ok: false, message: 'The race has time points 0 to 3 ("2021" to "2024"); got 7.' });
    expect(c.setRaceFrame(null)).toEqual({ ok: true });
    expect(c.getState().raceFrame).toBeNull();
  });

  it("plays from the moment shown to the end, and can pause", () => {
    const ticker = manualTicker();
    const c = new ChartController({ spec: race, raceTicker: ticker });
    expect(c.playRace({ msPerStep: 100 })).toEqual({ ok: true });
    expect(c.getState()).toMatchObject({ raceFrame: 0, racePlaying: true });
    ticker.advance(150);
    expect(c.getState().raceFrame).toBeCloseTo(1.5, 6);
    c.pauseRace();
    expect(c.getState()).toMatchObject({ raceFrame: 1.5, racePlaying: false });
    expect(ticker.pending()).toBe(0);
    c.playRace({ msPerStep: 100 });
    ticker.advance(1000);
    // At the end playback stops and shows the last time point.
    expect(c.getState()).toMatchObject({ raceFrame: null, racePlaying: false });
    expect(new ChartController({ spec: { ...race, categories: ["only"] } }).playRace()).toMatchObject({ ok: false, message: "A race needs at least two time points (categories) to play." });
  });

  it("stops playback when a moment is chosen or the controller is destroyed", () => {
    const ticker = manualTicker();
    const c = new ChartController({ spec: race, raceTicker: ticker });
    c.playRace();
    c.setRaceFrame(2);
    expect(c.getState().racePlaying).toBe(false);
    c.playRace();
    c.destroy();
    expect(ticker.pending()).toBe(0);
  });
});

describe("races in files, summaries and agent tools", () => {
  it("is described by who leads at the start and the end", () => {
    expect(describeChart(createChartSpec(race))).toBe("Product sales: a bar race chart of 4 names over 4 time points (2021 to 2024), showing the top 3. Core leads at 2021 with 40; Cloud leads at 2024 with 70.");
  });

  it("round-trips through Mermaid, is clustered bars in Office, and is recommended for many series over time", () => {
    const spec = createChartSpec(race);
    expect(chartFromMermaid(chartToMermaid(spec)).spec).toEqual(spec);
    expect(chartToOoxml(spec).issues[0]).toBe("Bar chart races are written as clustered bar charts of every name at every time point: DrawingML has no animation.");
    const rows = [["", "A", "B", "C", "D", "E"], ["2021", 1, 2, 3, 4, 5], ["2022", 2, 3, 4, 5, 6], ["2023", 3, 4, 5, 6, 7], ["2024", 4, 5, 6, 7, 8]];
    expect(recommendChartTypes(rows).map((r) => r.type)).toContain("barrace");
  });

  it("reads rankings, shows moments and plays through the tools", async () => {
    const ticker = manualTicker();
    const controller = new ChartController({ spec: race, raceTicker: ticker });
    const registry = new ToolRegistry();
    registry.register(createChartToolProvider(controller));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result: any = await registry.callTool(name, args);
      return { error: result.isError ? (result.content[0].text as string) : null, value: result.structuredContent as any };
    };
    expect((await call("get_chart_race_ranking", { time: "2021" })).value).toEqual({
      frame: 0,
      time: "2021",
      ranking: [
        { rank: 1, series: "core", name: "Core", value: 40 },
        { rank: 2, series: "addons", name: "Add-ons", value: 30 },
        { rank: 3, series: "services", name: "Services", value: 20 },
      ],
    });
    expect(controller.getState().raceFrame).toBeNull();
    expect((await call("set_chart_race_frame", { time: 2 })).value).toMatchObject({ frame: 2, time: "2023" });
    expect(controller.getState().raceFrame).toBe(2);
    expect((await call("render_chart", { time: "2021" })).value.svg).toContain(">2021<");
    expect((await call("play_chart_race", { msPerStep: 200 })).value).toEqual({ playing: true, from: 2, durationMs: 200 });
    expect(controller.getState().racePlaying).toBe(true);
    expect((await call("set_chart_race_frame", { time: null })).value.frame).toBe(3);
    expect(controller.getState().racePlaying).toBe(false);
    expect((await call("set_chart_race_frame", { time: "2030" })).error).toBe('There is no time point "2030"; expected an index from 0 to 3 or one of "2021", "2022", "2023", "2024".');
    expect((await call("get_chart_race_ranking", { time: -1 })).error).toMatch(/There is no time point -1/);
  });

  it("offers pause only while playing in the command palette", async () => {
    const ticker = manualTicker();
    const controller = new ChartController({ spec: race, raceTicker: ticker });
    const commands = new CommandRegistry();
    commands.register(createChartCommands(controller));
    const tools = new ToolRegistry();
    tools.register(createCommandToolProvider(commands));
    const run = (id: string, params?: unknown) => tools.callTool("run_command", { id, ...(params ? { params } : {}) }) as Promise<any>;
    expect((await run("chart.pauseRace")).isError).toBe(true);
    expect((await run("chart.playRace", { msPerStep: 100 })).isError).toBeFalsy();
    expect((await run("chart.pauseRace")).isError).toBeFalsy();
    expect((await run("chart.raceRanking", { time: 3 })).structuredContent.result.ranking[0].name).toBe("Cloud");
  });
});
