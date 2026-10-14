import { describe, it, expect, vi } from "vitest";
import {
  TokenError,
  TokenStore,
  createTokenStore,
  checkTokenAlias,
  exportTokensCss,
  exportW3CTokens,
  exportW3CTokensJson,
  findTokenCollection,
  findTokenMode,
  findTokenVariable,
  formatTokenValue,
  getTokenCssName,
  getTokenCssVariables,
  importW3CTokens,
  isTokenInScope,
  normalizeTokenColor,
  normalizeTokenName,
  normalizeTokenScopes,
  parseTokenState,
  resolveToken,
  resolveTokenValue,
  tokenSlug,
  TOKEN_SCOPES_BY_TYPE,
  W3C_TOKENS_EXTENSION,
  type TokenState,
} from "../src/tokens";

function counterIds() {
  let n = 0;
  return (kind: string) => `${kind}-${++n}`;
}

/** A "Theme" collection with Light and Dark modes and a colour variable `bg` (white / black). */
function theme() {
  const store = createTokenStore({ createId: counterIds() });
  const c = store.createCollection("Theme", ["Light", "Dark"]);
  const bg = store.createVariable({ collectionId: c.id, name: "bg", type: "color", values: { Light: "#FFFFFF", Dark: "#000000" } });
  const [light, dark] = c.modes;
  return { store, c, bg, light, dark };
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TokenError);
    expect((error as TokenError).code).toBe(code);
    return error as TokenError;
  }
  throw new Error(`expected ${code}`);
}

describe("colours", () => {
  it("normalises hex, rgb(), names and colour objects", () => {
    expect(normalizeTokenColor("#FFF")).toBe("#ffffff");
    expect(normalizeTokenColor("#0D99FF")).toBe("#0d99ff");
    expect(normalizeTokenColor("#0000ff80")).toBe("#0000ff80");
    expect(normalizeTokenColor("#000f")).toBe("#000000");
    expect(normalizeTokenColor("rgb(255, 0, 0)")).toBe("#ff0000");
    expect(normalizeTokenColor("rgba(255 0 0 / 50%)")).toBe("#ff000080");
    expect(normalizeTokenColor("rgba(0,0,255,0.5)")).toBe("#0000ff80");
    expect(normalizeTokenColor("transparent")).toBe("#00000000");
    expect(normalizeTokenColor({ r: 1, g: 0, b: 0, a: 0.5 })).toBe("#ff000080");
    expect(normalizeTokenColor({ colorSpace: "srgb", components: [0, 1, 0], alpha: 1 })).toBe("#00ff00");
    for (const bad of ["red-ish", "#12", "rgb(1,2)", 3, null, "rgb(" + "1,".repeat(100) + ")"]) {
      expect(normalizeTokenColor(bad)).toBeNull();
    }
  });
});

describe("collections, modes and variables", () => {
  it("types and their starting values: black, 0, empty, true in every mode", () => {
    const store = createTokenStore({ createId: counterIds() });
    const c = store.createCollection("C", ["A", "B"]);
    const cases = [
      ["color", "#000000"],
      ["number", 0],
      ["string", ""],
      ["boolean", true],
    ] as const;
    for (const [type, want] of cases) {
      const v = store.createVariable({ collectionId: c.id, name: type, type });
      expect(Object.keys(v.valuesByMode)).toHaveLength(2);
      expect(Object.values(v.valuesByMode).every((x) => x === want)).toBe(true);
    }
    expectCode(() => store.createVariable({ collectionId: c.id, name: "x", type: "date" as any }), "invalid-type");
    expectCode(() => store.createVariable({ collectionId: c.id, name: "y", type: "number", value: "wide" }), "invalid-value");
    expect(findTokenVariable(store.getState(), "y")).toBeUndefined();
  });

  it("new collections get a Default mode; names are unique and exportable", () => {
    const store = createTokenStore({ createId: counterIds() });
    const c = store.createCollection("Brand");
    expect(c.modes.map((m) => m.name)).toEqual(["Default"]);
    expectCode(() => store.createCollection("Brand"), "duplicate-name");
    store.createVariable({ collectionId: c.id, name: " color / bg ", type: "color" });
    expect(findTokenVariable(store.getState(), "color/bg")).toBeDefined();
    expectCode(() => store.createVariable({ collectionId: c.id, name: "color/bg", type: "color" }), "duplicate-name");
    expectCode(() => store.createVariable({ collectionId: c.id, name: "color", type: "color" }), "name-conflict");
    expectCode(() => store.createVariable({ collectionId: c.id, name: "color/bg/hover", type: "color" }), "name-conflict");
    for (const bad of ["a.b", "{x}", "$a", "a//b", ""]) expectCode(() => normalizeTokenName(bad), "invalid-name");
  });

  it("modes: new and duplicated values, reordering, the default, removal", () => {
    const { store, c, bg } = theme();
    const value = (mode: string) => store.getState().variables[0].valuesByMode[findTokenMode(findTokenCollection(store.getState(), "Theme")!, mode)!.id];
    store.addMode(c.id, "Dim");
    expect(value("Dim")).toBe(value("Light"));
    store.addMode(c.id, "Dark 2", { from: "Dark" });
    expect(value("Dark 2")).toBe(value("Dark"));
    expectCode(() => store.addMode(c.id, "X", { from: "Nope" }), "not-found");
    expectCode(() => store.addMode(c.id, "Dim"), "duplicate-name");

    // Auto follows the default mode; an explicit mode stays.
    const dark = findTokenMode(store.getState().collections[0], "Dark")!;
    const light = findTokenMode(store.getState().collections[0], "Light")!;
    expect(resolveTokenValue(store.getState(), bg.id)).toBe("#ffffff");
    store.setDefaultMode(c.id, dark.id);
    expect(store.getState().collections[0].modes.map((m) => m.name)).toEqual(["Dark", "Light", "Dim", "Dark 2"]);
    expect(resolveTokenValue(store.getState(), bg.id)).toBe("#000000");
    expect(resolveTokenValue(store.getState(), bg.id, { [c.id]: light.id })).toBe("#ffffff");
    // Moving past the end clamps; one undo step per move.
    store.moveMode(c.id, dark.id, 99);
    expect(store.getState().collections[0].modes.at(-1)!.name).toBe("Dark");
    expect(resolveTokenValue(store.getState(), bg.id)).toBe("#ffffff");
    store.undo();
    expect(resolveTokenValue(store.getState(), bg.id)).toBe("#000000");
    expectCode(() => store.moveMode(c.id, "Nope", 0), "not-found");

    // Renaming and removing; a collection keeps one mode. An unknown mode in a context is Auto.
    store.renameMode(c.id, "Dim", "Dimmed");
    expect(findTokenMode(store.getState().collections[0], "Dimmed")).toBeDefined();
    store.removeMode(c.id, light.id);
    expect(store.getState().variables[0].valuesByMode[light.id]).toBeUndefined();
    expect(resolveTokenValue(store.getState(), bg.id, { [c.id]: light.id })).toBe("#000000");
    for (const m of store.getState().collections[0].modes.slice(1)) store.removeMode(c.id, m.id);
    expectCode(() => store.removeMode(c.id, store.getState().collections[0].modes[0].id), "last-mode");
  });

  it("aliases: same type, chains, no cycles (also when creating)", () => {
    const { store, c } = theme();
    const brand = store.createCollection("Brand", ["Base"]);
    const blue = store.createVariable({ collectionId: brand.id, name: "blue", type: "color", value: "#0000FF" });
    const n = store.createVariable({ collectionId: brand.id, name: "n", type: "number", value: 4 });
    const accent = store.createVariable({ collectionId: c.id, name: "accent", type: "color", value: { alias: blue.id } });
    const link = store.createVariable({ collectionId: c.id, name: "link", type: "color", value: { alias: accent.id } });
    const r = resolveToken(store.getState(), link.id);
    expect(r.ok && r.value).toBe("#0000ff");
    expect(r.ok && r.chain).toEqual([link.id, accent.id, blue.id]);
    store.setValue(blue.id, "#00FF00");
    expect(resolveTokenValue(store.getState(), link.id)).toBe("#00ff00");

    const loop = expectCode(() => store.setValue(blue.id, { alias: link.id }), "alias-cycle");
    expect(loop.message).toBe("The alias would create a cycle: `blue` → `link` → `accent` → `blue`");
    expectCode(() => store.setValue(accent.id, { alias: accent.id }), "alias-cycle");
    expectCode(() => store.setValue(accent.id, { alias: n.id }), "type-mismatch");
    expectCode(() => store.createVariable({ collectionId: c.id, name: "x", type: "color", value: { alias: n.id } }), "type-mismatch");
    expectCode(() => store.createVariable({ collectionId: c.id, name: "y", type: "color", value: { alias: "missing" } }), "alias-missing");
    expect(findTokenVariable(store.getState(), "x")).toBeUndefined();
    expect(findTokenVariable(store.getState(), "y")).toBeUndefined();
    expect(formatTokenValue(store.getState(), { alias: blue.id })).toBe("→ blue");
  });

  it("a cycle that only spans modes is still refused (any mode can close it)", () => {
    const { store, c, dark } = theme();
    const a = store.createVariable({ collectionId: c.id, name: "a", type: "color" });
    const b = store.createVariable({ collectionId: c.id, name: "b", type: "color" });
    store.setValue(a.id, { alias: b.id }); // Light
    expectCode(() => store.setValue(b.id, { alias: a.id }, dark.id), "alias-cycle");
  });

  it("resolution reports cycles and missing targets in hand-made states", () => {
    const state: TokenState = {
      collections: [{ id: "c", name: "C", modes: [{ id: "m", name: "M" }] }],
      variables: [
        { id: "a", name: "a", collectionId: "c", type: "color", valuesByMode: { m: { alias: "b" } } },
        { id: "b", name: "b", collectionId: "c", type: "color", valuesByMode: { m: { alias: "a" } } },
        { id: "d", name: "d", collectionId: "c", type: "color", valuesByMode: { m: { alias: "gone" } } },
        { id: "e", name: "e", collectionId: "c", type: "color", valuesByMode: { m: { alias: "f" } } },
        { id: "f", name: "f", collectionId: "c", type: "number", valuesByMode: { m: 1 } },
      ],
    };
    const cycle = resolveToken(state, "a");
    expect(cycle).toMatchObject({ ok: false, code: "cycle", chain: ["a", "b", "a"] });
    expect(!cycle.ok && cycle.message).toBe("Alias cycle: `a` → `b` → `a`");
    expect(resolveToken(state, "d")).toMatchObject({ ok: false, code: "missing" });
    expect(resolveToken(state, "e")).toMatchObject({ ok: false, code: "type-mismatch" });
    expect(resolveToken(state, "nope")).toMatchObject({ ok: false, code: "missing" });
    expect(checkTokenAlias(state, { id: "x", name: "x", type: "color" }, "a")).toBeNull();

    // parseTokenState breaks the loop and drops the dangling / mistyped aliases.
    const { state: fixed, issues } = parseTokenState(JSON.stringify(state));
    expect(issues.length).toBeGreaterThanOrEqual(3);
    for (const id of ["a", "b", "d", "e"]) expect(resolveToken(fixed, id).ok).toBe(true);
  });

  it("aliases across collections read the target in its own collection's mode", () => {
    const { store, c, dark } = theme();
    const brand = store.createCollection("Brand", ["Normal", "Contrast"]);
    const ink = store.createVariable({ collectionId: brand.id, name: "ink", type: "color", values: { Normal: "#111111", Contrast: "#000000" } });
    const text = store.createVariable({ collectionId: c.id, name: "text", type: "color", value: { alias: ink.id } });
    const contrast = brand.modes[1];
    expect(resolveTokenValue(store.getState(), text.id, { [c.id]: dark.id })).toBe("#111111");
    expect(resolveTokenValue(store.getState(), text.id, { [c.id]: dark.id, [brand.id]: contrast.id })).toBe("#000000");
  });

  it("scopes limit pickers only; unknown scopes are refused", () => {
    const store = createTokenStore({ createId: counterIds() });
    const c = store.createCollection("C");
    const radius = store.createVariable({ collectionId: c.id, name: "radius", type: "number", value: 8 });
    store.updateVariable(radius.id, { scopes: ["CORNER_RADIUS"], description: "Corners" });
    const v = store.getState().variables[0];
    expect(v.scopes).toEqual(["CORNER_RADIUS"]);
    expect(v.description).toBe("Corners");
    expect(isTokenInScope(v, "CORNER_RADIUS")).toBe(true);
    expect(isTokenInScope(v, "WIDTH_HEIGHT")).toBe(false);
    expect(isTokenInScope(v, undefined)).toBe(true);
    for (const want of ["GAP", "CORNER_RADIUS", "FONT_WEIGHT", "FONT_SIZE", "LINE_HEIGHT", "LETTER_SPACING", "PARAGRAPH_SPACING", "PARAGRAPH_INDENT", "OPACITY", "EFFECT_FLOAT", "STROKE_FLOAT", "TEXT_CONTENT", "WIDTH_HEIGHT"]) {
      expect(TOKEN_SCOPES_BY_TYPE.number).toContain(want);
    }
    expect(normalizeTokenScopes("number", [...TOKEN_SCOPES_BY_TYPE.number])).toBeUndefined();
    expect(normalizeTokenScopes("color", ["ALL_FILLS", "ALL_FILLS"])).toEqual(["ALL_FILLS"]);
    expect(isTokenInScope({ scopes: ["ALL_FILLS"] }, "TEXT_FILL")).toBe(true);
    expectCode(() => store.updateVariable(radius.id, { scopes: ["TEXT_FILL"] }), "unknown-scope");
    store.updateVariable(radius.id, { scopes: null });
    expect(store.getState().variables[0].scopes).toBeUndefined();
  });

  it("renaming keeps ids (and so bindings); deleting detaches aliases to the values per mode", () => {
    const { store, c, bg, light, dark } = theme();
    const surface = store.createVariable({ collectionId: c.id, name: "surface", type: "color", value: { alias: bg.id } });
    store.renameVariable(bg.id, "color/bg");
    expect(store.getState().variables[0]).toMatchObject({ id: bg.id, name: "color/bg" });
    expectCode(() => store.renameVariable(bg.id, "surface"), "duplicate-name");

    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.deleteVariables(bg.id)).toEqual([bg.id]);
    const after = store.getState().variables.find((v) => v.id === surface.id)!;
    expect(after.valuesByMode[light.id]).toBe("#ffffff");
    expect(after.valuesByMode[dark.id]).toBe("#000000");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({ source: "edit", reason: "deleteVariables", deletedVariableIds: [bg.id] });
    expect(resolveTokenValue(listener.mock.calls[0][0].previous, bg.id)).toBe("#ffffff");

    // Undo brings the variable and the alias back.
    store.undo();
    expect(store.getState().variables.find((v) => v.id === surface.id)!.valuesByMode[light.id]).toEqual({ alias: bg.id });
    expect(listener.mock.calls[1][0]).toMatchObject({ source: "undo", deletedVariableIds: [] });
    store.redo();
    expect(findTokenVariable(store.getState(), "color/bg")).toBeUndefined();
  });

  it("deleting a collection detaches aliases from other collections (in its default mode)", () => {
    const { store, c, bg } = theme();
    const other = store.createCollection("Other");
    const o = store.createVariable({ collectionId: other.id, name: "o", type: "color", value: { alias: bg.id } });
    const deleted = store.deleteCollection(c.id);
    expect(deleted).toEqual([bg.id]);
    expect(store.getState().collections.map((x) => x.name)).toEqual(["Other"]);
    expect(Object.values(store.getState().variables.find((v) => v.id === o.id)!.valuesByMode)).toEqual(["#ffffff"]);
  });
});

describe("TokenStore", () => {
  it("one undo step and one event per edit, transactions group, refused edits change nothing", () => {
    const { store, c } = theme();
    const events: string[] = [];
    store.subscribe((e) => events.push(`${e.source}:${e.reason}`));
    const before = store.getState();
    store.transact("make sizes", () => {
      store.createVariable({ collectionId: c.id, name: "space/sm", type: "number", value: 4, unit: "px" });
      store.createVariable({ collectionId: c.id, name: "space/md", type: "number", value: 8, unit: "px" });
    });
    expect(events).toEqual(["edit:make sizes"]);
    expect(store.getState().variables).toHaveLength(3);
    store.undo();
    expect(store.getState()).toBe(before);

    const snapshot = store.getState();
    expect(() =>
      store.transact("bad", () => {
        store.createVariable({ collectionId: c.id, name: "ok", type: "number" });
        store.createVariable({ collectionId: c.id, name: "ok", type: "number" });
      }),
    ).toThrow(TokenError);
    expect(store.getState()).toBe(snapshot);
    expectCode(() => store.setValue("nope", 1), "not-found");
    expect(store.getState()).toBe(snapshot);
    expect(events).toEqual(["edit:make sizes", "undo:make sizes"]);

    // No-op edits record nothing.
    const bg = store.getState().variables[0];
    store.setValue(bg.id, "#FFF");
    expect(store.getState()).toBe(snapshot);
    expect(store.canRedo()).toBe(true);
  });

  it("load() validates untrusted data and clears history", () => {
    const { store } = theme();
    const issues = store.load('{"collections":[{"id":"c","name":"C","modes":[]}],"variables":[{"id":"v"}]}');
    expect(issues).toHaveLength(2);
    expect(store.getState().collections).toEqual([]);
    expect(store.canUndo()).toBe(false);
    const round = new TokenStore();
    round.load(JSON.stringify(theme().store));
    expect(round.getState().variables[0].name).toBe("bg");
  });
});

describe("CSS custom properties", () => {
  function cssTheme() {
    const store = createTokenStore({ createId: counterIds() });
    const c = store.createCollection("Theme", ["Light", "Dark"]);
    store.createVariable({ collectionId: c.id, name: "color/primary", type: "color", values: { Light: "#0000ff80", Dark: "#ffffff" } });
    store.createVariable({ collectionId: c.id, name: "radius", type: "number", values: { Light: 4, Dark: 6.5 }, unit: "px" });
    store.createVariable({ collectionId: c.id, name: "label", type: "string", value: 'Say "hi"</style>' });
    store.createVariable({ collectionId: c.id, name: "on", type: "boolean", value: false });
    const primary = store.getState().variables[0];
    const accent = store.createVariable({ collectionId: c.id, name: "accent", type: "color", value: "#000000" });
    store.setValue(accent.id, { alias: primary.id }, "Dark");
    return { store, c };
  }

  it("default mode on :root, other modes by attribute; aliases refer to their target", () => {
    const { store } = cssTheme();
    const css = exportTokensCss(store.getState());
    for (const want of [
      ":root {\n",
      "  --color-primary: #0000ff80;\n",
      "  --radius: 4px;\n",
      ':root[data-mode="dark"] {\n',
      "  --radius: 6.5px;\n",
      "  --accent: var(--color-primary);\n",
      '  --label: "Say \\"hi\\"\\3c /style>";\n',
      "  --on: false;\n",
    ]) {
      expect(css).toContain(want);
    }
    expect(css).not.toContain("</style>");
    const nested = exportTokensCss(store.getState(), { nested: true, prefix: "ds", attribute: "data-theme" });
    expect(nested).toContain(':root, [data-theme="light"] {');
    expect(nested).toContain(':root[data-theme="dark"], [data-theme="dark"] {');
    expect(nested).toContain("--ds-color-primary");
  });

  it("resolved variables for a mode context, for inline styles", () => {
    const { store, c } = cssTheme();
    const dark = c.modes[1].id;
    expect(getTokenCssVariables(store.getState(), { [c.id]: dark })).toMatchObject({
      "--color-primary": "#ffffff",
      "--accent": "#ffffff",
      "--radius": "6.5px",
    });
    expect(getTokenCssVariables(store.getState())["--accent"]).toBe("#000000");
    expect(tokenSlug("Color/Bg Muted")).toBe("color-bg-muted");
    expect(getTokenCssName(store.getState(), store.getState().variables[0], { collectionPrefix: true })).toBe("--theme-color-primary");
  });
});

describe("W3C design tokens", () => {
  function ioTheme() {
    const store = createTokenStore({ createId: counterIds() });
    const c = store.createCollection("Theme", ["Light", "Dark"]);
    const primary = store.createVariable({ collectionId: c.id, name: "color/primary", type: "color", values: { Light: "#0000ff80", Dark: "#ffffff" } });
    store.createVariable({ collectionId: c.id, name: "radius", type: "number", values: { Light: 4, Dark: 6.5 }, unit: "px" });
    store.createVariable({ collectionId: c.id, name: "label", type: "string", value: 'Say "hi"' });
    store.createVariable({ collectionId: c.id, name: "on", type: "boolean", value: false });
    const accent = store.createVariable({ collectionId: c.id, name: "accent", type: "color", value: "#000000" });
    store.setValue(accent.id, { alias: primary.id }, "Dark");
    store.updateVariable(store.getState().variables[1].id, { scopes: ["CORNER_RADIUS"], description: "Corners" });
    return { store, c };
  }

  /** Collections and variables by name with values by mode name (aliases by target name). */
  function byName(state: TokenState) {
    return state.variables
      .map((v) => {
        const c = state.collections.find((x) => x.id === v.collectionId)!;
        return [c.name, v.name, v.type, v.unit, v.scopes, c.modes.map((m) => [m.name, formatTokenValue(state, v.valuesByMode[m.id])])];
      })
      .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  }

  it("exports nested groups with $type, $value, references and our extension", () => {
    const { store } = ioTheme();
    const doc = exportW3CTokens(store.getState()) as any;
    expect(doc.Theme.color.primary).toMatchObject({ $type: "color", $value: "#0000ff80" });
    expect(doc.Theme.radius).toMatchObject({ $type: "dimension", $value: { value: 4, unit: "px" }, $description: "Corners" });
    expect(doc.Theme.label).toMatchObject({ $type: "string", $value: 'Say "hi"' });
    expect(doc.Theme.on).toMatchObject({ $type: "boolean", $value: false });
    expect(doc.Theme.accent.$extensions[W3C_TOKENS_EXTENSION].modes).toEqual({ Light: "#000000", Dark: "{Theme.color.primary}" });
    expect(doc.Theme.$extensions[W3C_TOKENS_EXTENSION].modes.map((m: any) => m.name)).toEqual(["Light", "Dark"]);

    const dark = store.getState().collections[0].modes[1].id;
    const plain = exportW3CTokens(store.getState(), { extensions: false, modes: { [store.getState().collections[0].id]: dark }, colorFormat: "object" }) as any;
    expect(plain.Theme.$extensions).toBeUndefined();
    expect(plain.Theme.accent).toEqual({ $type: "color", $value: "{Theme.color.primary}" });
    expect(plain.Theme.color.primary.$value).toEqual({ colorSpace: "srgb", components: [1, 1, 1], alpha: 1, hex: "#ffffff" });
  });

  it("round-trips into another store, keeping ids, and merges by name into the same one", () => {
    const { store, c } = ioTheme();
    const text = exportW3CTokensJson(store.getState());

    // Into another store: the same collections, variables, values, aliases, scopes and ids.
    const other = createTokenStore({ createId: counterIds() });
    let report!: ReturnType<typeof importW3CTokens>["report"];
    other.update("import", (s) => {
      const r = importW3CTokens(s, text);
      report = r.report;
      return r.state;
    });
    expect(report).toMatchObject({ collectionsAdded: 1, variablesAdded: 5, variablesUpdated: 0, warnings: [] });
    expect(byName(other.getState())).toEqual(byName(store.getState()));
    expect(other.getState().variables.map((v) => v.id)).toEqual(store.getState().variables.map((v) => v.id));
    expect(other.getState().collections).toEqual(store.getState().collections);

    // Back into the same store: nothing new, nothing changed.
    const before = store.getState();
    const again = importW3CTokens(before, JSON.parse(text));
    expect(again.report).toMatchObject({ collectionsAdded: 0, variablesAdded: 0, variablesUpdated: 5, modesAdded: 0 });
    expect(again.state).toEqual(before);

    // Edited values update in place; a new mode is added and the others get a value in it.
    const edited = JSON.parse(text);
    edited.Theme.radius.$extensions[W3C_TOKENS_EXTENSION].modes.Light = { value: 12, unit: "px" };
    edited.Theme.radius.$extensions[W3C_TOKENS_EXTENSION].modes.Dim = 1;
    edited.Theme.$extensions[W3C_TOKENS_EXTENSION].modes.push({ id: "x", name: "Dim" });
    store.update("import", (s) => importW3CTokens(s, edited).state);
    const radius = findTokenVariable(store.getState(), "radius")!;
    expect(radius.id).toBe(before.variables[1].id);
    const coll = store.getState().collections[0];
    expect(coll.modes).toHaveLength(3);
    expect(radius.valuesByMode[coll.modes[0].id]).toBe(12);
    expect(radius.valuesByMode[coll.modes[2].id]).toBe(1);
    expect(Object.keys(findTokenVariable(store.getState(), "on")!.valuesByMode)).toHaveLength(3);
    store.undo();
    expect(store.getState()).toBe(before);
    expect(c.id).toBe(coll.id);
  });

  it("imports plain W3C files: group types, references, dimensions, one mode per file", () => {
    const light = {
      color: {
        $type: "color",
        bg: { $value: "#ffffff" },
        fg: { $value: "#111111", $description: "Text" },
        link: { $value: "{color.fg}" },
      },
      space: { md: { $type: "dimension", $value: "16px" }, lg: { $type: "dimension", $value: { value: 1.5, unit: "rem" } } },
      motion: { fast: { $type: "duration", $value: "120ms" } },
      font: { body: { $type: "fontFamily", $value: ["Inter", "sans-serif"] }, bold: { $type: "fontWeight", $value: "bold" } },
      shadow: { $type: "shadow", $value: { color: "#000", offsetX: "0px" } },
    };
    const dark = { color: { $type: "color", bg: { $value: "#000000" }, fg: { $value: "#eeeeee" } } };
    let state: TokenState = { collections: [], variables: [] };
    const first = importW3CTokens(state, light, { collection: "Theme", mode: "Light", createId: counterIds() });
    state = first.state;
    expect(first.report.warnings).toEqual(["`Theme.shadow` has an unsupported type `shadow`; skipped"]);
    const second = importW3CTokens(state, dark, { collection: "Theme", mode: "Dark" });
    state = second.state;
    expect(second.report).toMatchObject({ collectionsAdded: 0, modesAdded: 1, variablesUpdated: 2 });
    const c = state.collections[0];
    expect(c.modes.map((m) => m.name)).toEqual(["Light", "Dark"]);
    const [l, d] = c.modes.map((m) => ({ [c.id]: m.id }));
    const link = findTokenVariable(state, "color/link")!;
    expect(resolveTokenValue(state, link.id, l)).toBe("#111111");
    expect(resolveTokenValue(state, link.id, d)).toBe("#eeeeee");
    expect(findTokenVariable(state, "color/fg")!.description).toBe("Text");
    expect(findTokenVariable(state, "space/md")).toMatchObject({ type: "number", unit: "px", valuesByMode: { [c.modes[0].id]: 16 } });
    expect(findTokenVariable(state, "space/lg")).toMatchObject({ unit: "rem" });
    expect(findTokenVariable(state, "motion/fast")).toMatchObject({ unit: "ms" });
    expect(resolveTokenValue(state, findTokenVariable(state, "font/body")!.id)).toBe("Inter, sans-serif");
    expect(resolveTokenValue(state, findTokenVariable(state, "font/bold")!.id)).toBe(700);
  });

  it("checks what it reads: junk is skipped with warnings, type clashes and alias loops don't get in", () => {
    const store = createTokenStore({ createId: counterIds() });
    const c = store.createCollection("Theme");
    store.createVariable({ collectionId: c.id, name: "size", type: "color", value: "#000000" });
    const before = store.getState();
    for (const bad of ["{", 3, [], null]) expectCode(() => importW3CTokens(before, bad), "invalid-input");
    const junk = {
      size: { $type: "number", $value: 3 },
      a: { $type: "number", $value: "{b}" },
      b: { $type: "number", $value: "{a}" },
      w: { $type: "weird", $value: 1 },
      n: { $type: "number", $value: "NaN" },
      g: 5,
      "bad.name": { x: { $value: 1 } },
      missing: { $type: "color", $value: "{nope.nothing}" },
    };
    const { state, report } = importW3CTokens(before, junk, { collection: "Theme" });
    const warnings = report.warnings.join("\n");
    expect(warnings).toContain("`size` is a color variable");
    expect(warnings).toContain("would create a cycle");
    expect(warnings).toContain("unsupported type `weird`");
    expect(warnings).toContain("invalid number value");
    expect(warnings).toContain("not a token or group");
    expect(warnings).toContain("doesn't exist");
    expect(state.collections).toHaveLength(1);
    expect(findTokenVariable(state, "size")!.type).toBe("color");
    const a = findTokenVariable(state, "a")!;
    expect(resolveToken(state, a.id).ok).toBe(true);
    expect(store.getState()).toBe(before);
  });

  it("import runs in linear time on long malformed references and measures", () => {
    const time = (n: number) => {
      const doc: Record<string, unknown> = {};
      for (let i = 0; i < 50; i++) {
        doc[`r${i}`] = { $type: "number", $value: "{" + "a".repeat(n) };
        doc[`d${i}`] = { $type: "dimension", $value: "1".repeat(Math.min(n, 99)) + "e" };
      }
      const start = performance.now();
      importW3CTokens({ collections: [], variables: [] }, doc);
      return performance.now() - start;
    };
    time(500);
    const small = time(500);
    const large = time(4000);
    expect(large).toBeLessThan(Math.max(small * 30, 200));
  });
});
