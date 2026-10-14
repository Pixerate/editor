// Test cases re-expressed from craft-libs-main/crates/settings/tests/migrate.rs and tests/recovery.rs
// (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from "vitest";
import {
  hasLoadProblems,
  loadDocument,
  loadSections,
  migrateDocument,
  type SectionSpecs,
} from "../src/persistence";

interface Prefs {
  general: { language: string };
  appearance: { theme: "light" | "dark"; uiScale: number };
}

const sections: SectionSpecs<Prefs> = {
  general: {
    parse: (v: any) => {
      if (typeof v?.language !== "string") throw new Error("language must be a string");
      return { language: v.language };
    },
    defaults: () => ({ language: "en" }),
  },
  appearance: {
    parse: (v: any) => {
      if (v?.theme !== "light" && v?.theme !== "dark") throw new Error(`unknown theme ${v?.theme}`);
      return { theme: v.theme, uiScale: typeof v.uiScale === "number" ? v.uiScale : 1 };
    },
    defaults: () => ({ theme: "light", uiScale: 1 }),
  },
};

/** v1 stored `appearance.dark: boolean`; v2 stores `appearance.theme`. */
const steps = {
  1: (doc: any) => {
    const { dark, ...rest } = doc.appearance ?? {};
    doc.appearance = { ...rest, theme: dark ? "dark" : "light" };
  },
};

describe("migrateDocument", () => {
  it("migrates an older version step by step", () => {
    const input = { version: 1, appearance: { dark: true, uiScale: 1.25 }, notes: "keep me" };
    const { doc, report } = migrateDocument(input, { currentVersion: 2, steps });
    expect(report.migratedFrom).toBe(1);
    expect(report.readOnly).toBeNull();
    expect(doc).toEqual({ version: 2, appearance: { theme: "dark", uiScale: 1.25 }, notes: "keep me" });
    expect(input.appearance).toEqual({ dark: true, uiScale: 1.25 }); // input untouched
  });

  it("runs several steps in order", () => {
    const calls: number[] = [];
    const { doc, report } = migrateDocument('{"version":0,"a":1}', {
      currentVersion: 3,
      steps: {
        0: (d) => void calls.push(0),
        1: (d) => ({ ...d, b: 2 }),
        2: (d) => void calls.push(2),
      },
    });
    expect(calls).toEqual([0, 2]);
    expect(doc).toEqual({ version: 3, a: 1, b: 2 });
    expect(report.migratedFrom).toBe(0);
  });

  it("treats a missing version as current and adds it", () => {
    const { doc, report } = migrateDocument({ general: { language: "pt" } }, { currentVersion: 2, steps });
    expect(report.migratedFrom).toBeNull();
    expect(report.version).toBeNull();
    expect(report.readOnly).toBeNull();
    expect(doc.version).toBe(2);
  });

  it("can assume an older version when the key is missing", () => {
    const { doc, report } = migrateDocument({ appearance: { dark: true } }, {
      currentVersion: 2,
      steps,
      missingVersion: 1,
    });
    expect(report.migratedFrom).toBe(1);
    expect(doc.appearance).toEqual({ theme: "dark" });
  });

  it("reports a newer version read-only and leaves the document alone", () => {
    const input = { version: 9, general: { language: "de" }, future: [1, 2] };
    const { doc, report } = migrateDocument(input, { currentVersion: 2, steps });
    expect(report.readOnly).toMatchObject({ kind: "newerVersion", version: 9, supported: 2 });
    expect(doc).toEqual(input);
    expect(hasLoadProblems(report)).toBe(true);
  });

  it("reports a missing step read-only and returns the original document", () => {
    const input = { version: 0, general: { language: "de" } };
    const { doc, report } = migrateDocument(input, { currentVersion: 2, steps });
    expect(report.readOnly).toMatchObject({ kind: "migrationFailed", from: 0 });
    expect(doc).toEqual(input);
    expect(report.migratedFrom).toBeNull();
  });

  it("never hands back half-migrated values when a step throws", () => {
    const input = { version: 0, value: 1 };
    const { doc, report } = migrateDocument(input, {
      currentVersion: 2,
      steps: {
        0: (d) => {
          d.value = 2;
        },
        1: () => {
          throw new Error("boom");
        },
      },
    });
    expect(report.readOnly).toMatchObject({ kind: "migrationFailed", from: 1 });
    expect(report.readOnly!.message).toContain("boom");
    expect(doc).toEqual({ version: 0, value: 1 });
  });

  it("reports unparsable input read-only", () => {
    expect(migrateDocument("{not json", { currentVersion: 1 }).report.readOnly?.kind).toBe("invalid");
    expect(migrateDocument([1, 2], { currentVersion: 1 }).report.readOnly?.kind).toBe("invalid");
  });

  it("supports a custom version key", () => {
    const { doc } = migrateDocument({ schema_version: 1, x: 1 }, {
      currentVersion: 2,
      versionKey: "schema_version",
      steps: { 1: (d) => ({ ...d, x: 2 }) },
    });
    expect(doc).toEqual({ schema_version: 2, x: 2 });
  });
});

describe("loadSections", () => {
  it("only resets the section with a bad value", () => {
    const { value, problems, unknown } = loadSections(
      { version: 2, general: { language: "de" }, appearance: { theme: "sepia", uiScale: 2 } },
      sections,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0].section).toBe("appearance");
    expect(problems[0].message).toContain("sepia");
    expect(value.general.language).toBe("de");
    expect(value.appearance).toEqual({ theme: "light", uiScale: 1 });
    expect(unknown).toEqual({});
  });

  it("uses defaults for missing sections without reporting them", () => {
    const { value, problems } = loadSections({}, sections);
    expect(problems).toEqual([]);
    expect(value).toEqual({ general: { language: "en" }, appearance: { theme: "light", uiScale: 1 } });
  });

  it("treats a parse returning undefined as a rejection", () => {
    const { problems, value } = loadSections({ a: 1 }, { a: { parse: () => undefined, defaults: 5 } });
    expect(problems.map((p) => p.section)).toEqual(["a"]);
    expect(value.a).toBe(5);
  });

  it("preserves unknown keys", () => {
    const { unknown } = loadSections(
      { version: 1, general: { language: "it" }, plugins: { enabled: true }, futureKey: "kept" },
      sections,
    );
    expect(unknown).toEqual({ plugins: { enabled: true }, futureKey: "kept" });
  });
});

describe("loadDocument", () => {
  it("migrates, loads sections and fills one report", () => {
    const { value, report, unknown } = loadDocument(
      JSON.stringify({ version: 1, appearance: { dark: true }, general: { language: 7 }, extra: 1 }),
      sections,
      { currentVersion: 2, steps },
    );
    expect(report.migratedFrom).toBe(1);
    expect(report.problems.map((p) => p.section)).toEqual(["general"]);
    expect(report.unknownKeys).toEqual(["extra"]);
    expect(unknown).toEqual({ extra: 1 });
    expect(value.appearance.theme).toBe("dark");
    expect(value.general.language).toBe("en");
    expect(hasLoadProblems(report)).toBe(true);
  });

  it("still shows the values of a newer document", () => {
    const { value, report } = loadDocument({ version: 9, general: { language: "de" } }, sections, {
      currentVersion: 2,
      steps,
    });
    expect(report.readOnly?.kind).toBe("newerVersion");
    expect(value.general.language).toBe("de");
  });

  it("reports nothing for a current, valid document", () => {
    const { report } = loadDocument(
      { version: 2, general: { language: "de" }, appearance: { theme: "dark", uiScale: 1 } },
      sections,
      { currentVersion: 2, steps },
    );
    expect(hasLoadProblems(report)).toBe(false);
    expect(report.version).toBe(2);
  });
});
