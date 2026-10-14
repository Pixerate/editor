// Test cases re-expressed from wordcraft/crates/engine/src/cmd/mailings.rs
// (MIT OR Apache-2.0, © ArtCraft Team and contributors). See
// THIRD_PARTY_NOTICES.md.
import { describe, it, expect } from "vitest";
import {
  parseDataSource,
  detectDelimiter,
  normalizeFieldNames,
  matchFields,
  recordToValues,
  mergeRecords,
  serializeMergeOutputs,
  mapResolvedOffsetToRaw,
  type Template,
} from "../src/grammar";

describe("Mail merge: parseDataSource", () => {
  it("parses quotes, doubled quotes, CRLF and skips blank rows", () => {
    const source = parseDataSource('Name,City\n"Smith, Ann",Paris\r\nBo,"Oslo ""N"""\n\n');
    expect(source.fields).toEqual(["Name", "City"]);
    expect(source.records).toEqual([
      { Name: "Smith, Ann", City: "Paris" },
      { Name: "Bo", City: 'Oslo "N"' },
    ]);
    expect(source.format).toBe("csv");
    expect(source.delimiter).toBe(",");
    expect(source.warnings).toEqual([]);
  });

  it("auto-detects semicolons and tabs from the first line", () => {
    expect(parseDataSource("a;b\n1;2").records).toEqual([{ a: "1", b: "2" }]);
    expect(parseDataSource("a\tb\n1\t2").delimiter).toBe("\t");
    // Delimiters inside quotes in the header do not count.
    expect(detectDelimiter('"x,y,z";b\n1;2')).toBe(";");
    expect(detectDelimiter("single")).toBe(",");
    expect(parseDataSource("a|b\n1|2", { delimiter: "|" }).records).toEqual([
      { a: "1", b: "2" },
    ]);
  });

  it("names blank headers Column N and numbers duplicates", () => {
    expect(normalizeFieldNames(["Name", "", "name", " Name ", null])).toEqual([
      "Name",
      "Column 2",
      "name 2",
      "Name 3",
      "Column 5",
    ]);
    const source = parseDataSource("Name,,Name\nAda,London,A");
    expect(source.fields).toEqual(["Name", "Column 2", "Name 2"]);
    expect(source.records[0]).toEqual({ Name: "Ada", "Column 2": "London", "Name 2": "A" });
    expect(source.warnings.map((w) => w.code)).toEqual(["blank-header", "duplicate-header"]);
  });

  it("pads short rows and cuts long ones to the header", () => {
    const source = parseDataSource("a,b\n1\n1,2,3\n4,5");
    expect(source.records).toEqual([
      { a: "1", b: "" },
      { a: "1", b: "2" },
      { a: "4", b: "5" },
    ]);
    expect(source.warnings).toEqual([
      expect.objectContaining({ code: "ragged-rows", count: 2 }),
    ]);
  });

  it("names columns when there is no header row", () => {
    const source = parseDataSource("Ada,London\nAlan,Wilmslow,UK", { hasHeader: false });
    expect(source.fields).toEqual(["Column 1", "Column 2", "Column 3"]);
    expect(source.records[0]).toEqual({ "Column 1": "Ada", "Column 2": "London", "Column 3": "" });
  });

  it("caps records and fields", () => {
    const csv = ["h1,h2,h3", ...Array.from({ length: 10 }, (_, i) => `${i},x,y`)].join("\n");
    const source = parseDataSource(csv, { maxRecords: 4, maxFields: 2 });
    expect(source.fields).toEqual(["h1", "h2"]);
    expect(source.records).toHaveLength(4);
    expect(source.records[3]).toEqual({ h1: "3", h2: "x" });
    expect(source.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(["fields-truncated", "records-truncated"]),
    );
  });

  it("reads JSON arrays of objects and of arrays", () => {
    const objects = parseDataSource(
      '[{"Name":"Ada","Age":36,"VIP":true},{"City":"Paris","Name":null},{}]',
    );
    expect(objects.format).toBe("json");
    expect(objects.fields).toEqual(["Name", "Age", "VIP", "City"]);
    expect(objects.records).toEqual([
      { Name: "Ada", Age: "36", VIP: "true", City: "" },
      { Name: "", Age: "", VIP: "", City: "Paris" },
    ]);
    const rows = parseDataSource('[["Name","City"],["Ada","London"]]');
    expect(rows.records).toEqual([{ Name: "Ada", City: "London" }]);
  });

  it("accepts rows and objects directly", () => {
    expect(
      parseDataSource([
        ["Last Name", " City ", "Age"],
        ["Lovelace", "London", 36],
        ["Turing"],
      ]).records,
    ).toEqual([
      { "Last Name": "Lovelace", City: "London", Age: "36" },
      { "Last Name": "Turing", City: "", Age: "" },
    ]);
    const objects = parseDataSource([{ __proto__x: "1", nested: { a: 1 } }] as any);
    expect(objects.format).toBe("objects");
    expect(objects.records[0].nested).toBe('{"a":1}');
  });

  it("reports bad JSON instead of throwing", () => {
    expect(parseDataSource("[1,", { format: "json" }).warnings[0].code).toBe("invalid-json");
    expect(parseDataSource('{"a":1}', { format: "json" }).warnings[0].code).toBe(
      "unsupported-json",
    );
    // In auto mode, text that only looks like JSON is read as CSV.
    expect(parseDataSource("[x],y\n1,2").fields).toEqual(["[x]", "y"]);
    expect(parseDataSource("").warnings[0].code).toBe("empty");
  });

  it("keeps a field named __proto__ as data", () => {
    const source = parseDataSource("__proto__,b\n1,2");
    expect(Object.keys(source.records[0])).toEqual(["__proto__", "b"]);
    expect(Object.getPrototypeOf(source.records[0])).toBe(Object.prototype);
  });
});

describe("Mail merge: matchFields", () => {
  it("matches exactly, then ignoring case and spacing, then by alias", () => {
    const result = matchFields(
      ["City", "first_name", "Surname", "zip", "email", "favourite"],
      ["First Name", "Last Name", "City", "Postcode", "E-mail"],
    );
    expect(result.mapping).toEqual({
      City: "City",
      first_name: "First Name",
      Surname: "Last Name",
      zip: "Postcode",
      email: "E-mail",
      favourite: null,
    });
    expect(result.matches.map((m) => m.kind)).toEqual([
      "exact",
      "normalized",
      "alias",
      "alias",
      "normalized",
      null,
    ]);
    expect(result.unmatchedVariables).toEqual(["favourite"]);
    expect(result.unusedFields).toEqual([]);
  });

  it("resolves FirstName / First / GivenName to whichever exists", () => {
    for (const field of ["FirstName", "First", "GivenName", "given_name"]) {
      expect(matchFields(["firstName"], [field]).mapping.firstName).toBe(field);
    }
    expect(matchFields(["nick"], ["Nickname"], { aliases: [["nick", "nickname"]] }).mapping).toEqual({
      nick: "Nickname",
    });
  });

  it("accepts variable descriptors and builds prompt values from a record", () => {
    const { mapping } = matchFields([{ name: "first" }, { name: "note" }], ["FirstName", "Note"]);
    expect(recordToValues({ FirstName: "Ada", Note: "  " }, mapping)).toEqual({
      FirstName: "Ada",
      first: "Ada",
    });
    expect(
      recordToValues({ FirstName: "Ada", Note: "" }, mapping, { blankAsMissing: false }),
    ).toEqual({ FirstName: "Ada", first: "Ada", Note: "", note: "" });
    expect(recordToValues({ x: "1" }, { x: null })).toEqual({});
  });
});

describe("Mail merge: mergeRecords", () => {
  const csv = "First Name,Last Name,City\nAda,Lovelace,London\nAlan,Turing,Wilmslow";

  it("merges one output per record end to end", () => {
    const result = mergeRecords("Dear {firstName} {lastName}, see you in {city}.", csv);
    expect(result.outputs.map((o) => o.text)).toEqual([
      "Dear Ada Lovelace, see you in London.",
      "Dear Alan Turing, see you in Wilmslow.",
    ]);
    expect(result.text).toBe(
      "Dear Ada Lovelace, see you in London.\n\nDear Alan Turing, see you in Wilmslow.",
    );
    expect(result.mapping).toEqual({
      firstName: "First Name",
      lastName: "Last Name",
      city: "City",
    });
    expect(result.outputs[1].index).toBe(1);
    expect(result.diagnostics).toEqual([]);
    // Each output carries a source map back into the template.
    expect(mapResolvedOffsetToRaw(5, result.outputs[0].map)).toBe(5);
  });

  it("uses separators, explicit mappings and ranges", () => {
    const result = mergeRecords("{who}", csv, {
      mapping: { who: "City" },
      separator: "none",
    });
    expect(result.text).toBe("LondonWilmslow");
    expect(mergeRecords("{City}", csv, { separator: " | " }).text).toBe("London | Wilmslow");
    expect(mergeRecords("{City}", csv, { from: 2 }).text).toBe("Wilmslow");
    expect(mergeRecords("{City}", csv, { to: 1 }).text).toBe("London");
  });

  it("falls back to defaults for blank cells and reports unmapped variables", () => {
    const result = mergeRecords("Hi {name|friend}, {mood}", [
      { name: "Ada", id: "1" },
      { name: "", id: "2" },
    ]);
    expect(result.outputs.map((o) => o.text)).toEqual(["Hi Ada, {mood}", "Hi friend, {mood}"]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "unmapped-variable", name: "mood" }),
    ]);
  });

  it("drops records matching a skipIf condition", () => {
    const rows = [
      { Name: "Alpha", Skip: "yes" },
      { Name: "Beta", Skip: "no" },
    ];
    const text = (skipIf?: string) => mergeRecords("{Name}", rows, { skipIf, separator: "\n" }).text;
    expect(text("Skip=yes")).toBe("Beta");
    expect(text("Skip=no")).toBe("Alpha");
    expect(text("Skip=absent")).toBe("Alpha\nBeta");
    expect(text(undefined)).toBe("Alpha\nBeta");
    expect(
      mergeRecords("{Name}", [
        { Name: "Alpha", Skip: "yes" },
        { Name: "Beta", Skip: "YES" },
      ], { skipIf: "Skip=yes" }).text,
    ).toBe("");
    const result = mergeRecords("{Name}", rows, { skipIf: "Skip=yes" });
    expect(result.skipped).toEqual([{ index: 0, record: rows[0], reason: "skip-if" }]);
  });

  it("matches a skipIf name to a field the template does not use", () => {
    const data = "First Name,City,Budget,Status\nAda,London,1500,active\nAlan,Wilmslow,200,cancelled";
    const result = mergeRecords(
      "Portrait of {firstName} in {city}{?budget>=1000}, 8k render{/budget}",
      data,
      { skipIf: "status=cancelled", separator: "\n" },
    );
    expect(result.text).toBe("Portrait of Ada in London, 8k render");
    expect(result.skipped.map((s) => s.index)).toEqual([1]);
  });

  it("supports function and presence skipIf, and reports malformed conditions", () => {
    const rows = [{ n: "5", email: "" }, { n: "50", email: "a@b" }];
    expect(mergeRecords("{n}", rows, { skipIf: "!email" }).text).toBe("50");
    expect(mergeRecords("{n}", rows, { skipIf: "n>10" }).text).toBe("5");
    expect(
      mergeRecords("{n}", rows, { skipIf: (record, _values, index) => record.n === "5" || index > 5 }).text,
    ).toBe("50");
    const bad = mergeRecords("{n}", rows, { skipIf: "n>" });
    expect(bad.outputs).toHaveLength(2);
    expect(bad.diagnostics[0].code).toBe("invalid-skip-condition");
  });

  it("evaluates comparison sections (an IF rule) per record", () => {
    const rows = [
      { Name: "Alpha", Flag: "yes" },
      { Name: "Beta", Flag: "no" },
    ];
    const result = mergeRecords(
      "{?Flag=yes}Selected{/Flag}{!Flag=yes}Other{/Flag}",
      rows,
      { separator: "\n" },
    );
    expect(result.text).toBe("Selected\nOther");
  });

  it("expands templates and reports grammar diagnostics once", () => {
    const templates: Template[] = [{ name: "sig", body: "-- {City}" }];
    const result = mergeRecords("{?x}{City} {{sig}}", csv, { templates });
    expect(result.outputs.map((o) => o.text)).toEqual([
      "{?x}London -- London",
      "{?x}Wilmslow -- Wilmslow",
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "unclosed-section", name: "x" }),
    ]);
  });

  it("stops at maxOutputs and maxLength", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ n: String(i) }));
    const capped = mergeRecords("{n}", rows, { maxOutputs: 3 });
    expect(capped.outputs).toHaveLength(3);
    expect(capped.truncated).toBe(true);
    expect(capped.diagnostics.map((d) => d.code)).toEqual(["max-outputs"]);
    // Skipped records do not count toward the cap.
    expect(mergeRecords("{n}", rows, { maxOutputs: 3, skipIf: "n<10" }).text).toBe(
      "10\n\n11\n\n12",
    );
    const long = mergeRecords("{n}", rows, { maxLength: 5, separator: "," });
    expect(long.text).toBe("0,1,2");
    expect(long.diagnostics.map((d) => d.code)).toEqual(["max-length"]);
    expect(mergeRecords("{n}", rows, { maxOutputs: 20 }).truncated).toBe(false);
  });

  it("passes data source warnings through as diagnostics", () => {
    const result = mergeRecords("{a}", "a,a\n1,2");
    expect(result.diagnostics.map((d) => d.code)).toEqual(["data-source"]);
    expect(result.text).toBe("1");
  });

  it("serializes outputs as text or JSON", () => {
    const result = mergeRecords("{City}", csv);
    expect(serializeMergeOutputs(result.outputs)).toBe("London\n\nWilmslow");
    expect(serializeMergeOutputs(result.outputs, "text", "none")).toBe("LondonWilmslow");
    expect(JSON.parse(serializeMergeOutputs(result.outputs, "json"))).toEqual([
      { record: 1, text: "London" },
      { record: 2, text: "Wilmslow" },
    ]);
  });
});
