import type { ArrowHead, EdgePattern } from "../types.js";
import type { LineGrammar, LineStatement, NodeDecl, EdgeSpec } from "./engine.js";
import { joinBraceBlocks } from "./engine.js";

/**
 * classDiagram grammar.
 *
 * Supported: `class A`, `class A["Label"]`, `class A:::cls`, `class A { … }`
 * bodies (kept verbatim and parsed into members), `A : member`, relations
 * with cardinalities and labels, `namespace N { … }`, `direction`, `classDef`,
 * `cssClass`, `style`. `<<annotation>> A`, notes, `click`, `link`, `callback`
 * stay as passthrough.
 *
 * @module
 */

const ID = String.raw`[A-Za-z0-9_À-￿.~-]+`;

/** Relation syntax → arrow heads. Order matters: longer tokens first. */
export interface ClassRelation {
  token: string;
  arrowStart: ArrowHead;
  arrowEnd: ArrowHead;
  pattern: EdgePattern;
  title: string;
}

export const CLASS_RELATIONS: ClassRelation[] = [
  {
    token: "<|--",
    arrowStart: "extension",
    arrowEnd: "none",
    pattern: "solid",
    title: "Inheritance",
  },
  {
    token: "--|>",
    arrowStart: "none",
    arrowEnd: "extension",
    pattern: "solid",
    title: "Inheritance (reversed)",
  },
  {
    token: "<|..",
    arrowStart: "extension",
    arrowEnd: "none",
    pattern: "dotted",
    title: "Realization",
  },
  {
    token: "..|>",
    arrowStart: "none",
    arrowEnd: "extension",
    pattern: "dotted",
    title: "Realization (reversed)",
  },
  {
    token: "*--",
    arrowStart: "composition",
    arrowEnd: "none",
    pattern: "solid",
    title: "Composition",
  },
  {
    token: "--*",
    arrowStart: "none",
    arrowEnd: "composition",
    pattern: "solid",
    title: "Composition (reversed)",
  },
  {
    token: "o--",
    arrowStart: "aggregation",
    arrowEnd: "none",
    pattern: "solid",
    title: "Aggregation",
  },
  {
    token: "--o",
    arrowStart: "none",
    arrowEnd: "aggregation",
    pattern: "solid",
    title: "Aggregation (reversed)",
  },
  {
    token: "<--",
    arrowStart: "dependency",
    arrowEnd: "none",
    pattern: "solid",
    title: "Association (reversed)",
  },
  {
    token: "-->",
    arrowStart: "none",
    arrowEnd: "dependency",
    pattern: "solid",
    title: "Association",
  },
  {
    token: "<..",
    arrowStart: "dependency",
    arrowEnd: "none",
    pattern: "dotted",
    title: "Dependency (reversed)",
  },
  {
    token: "..>",
    arrowStart: "none",
    arrowEnd: "dependency",
    pattern: "dotted",
    title: "Dependency",
  },
  { token: "()--", arrowStart: "lollipop", arrowEnd: "none", pattern: "solid", title: "Lollipop" },
  {
    token: "--()",
    arrowStart: "none",
    arrowEnd: "lollipop",
    pattern: "solid",
    title: "Lollipop (reversed)",
  },
  { token: "--", arrowStart: "none", arrowEnd: "none", pattern: "solid", title: "Link (solid)" },
  { token: "..", arrowStart: "none", arrowEnd: "none", pattern: "dotted", title: "Link (dashed)" },
];

const REL_TOKENS = CLASS_RELATIONS.map((r) => r.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(
  "|",
);
const RELATION = new RegExp(
  String.raw`^(${ID})(?:\["([^"]*)"\])?(?::::(${ID}))?\s*(?:"([^"]*)"\s*)?(${REL_TOKENS})\s*(?:"([^"]*)"\s*)?(${ID})(?:\["([^"]*)"\])?(?::::(${ID}))?\s*(?::\s*(.*))?$`,
);

export function relationFor(
  arrowStart: ArrowHead,
  arrowEnd: ArrowHead,
  pattern: EdgePattern,
): ClassRelation {
  return (
    CLASS_RELATIONS.find(
      (r) => r.arrowStart === arrowStart && r.arrowEnd === arrowEnd && r.pattern === pattern,
    ) ?? CLASS_RELATIONS.find((r) => r.token === "-->")!
  );
}

export interface ClassMember {
  raw: string;
  visibility?: "+" | "-" | "#" | "~";
  kind: "attribute" | "method";
}

export function parseMembers(bodyLines: string[]): ClassMember[] {
  const out: ClassMember[] = [];
  for (const line of bodyLines) {
    const t = line.trim();
    if (!t || t === "}" || t.startsWith("%%") || /^<<.*>>$/.test(t)) continue;
    const vis = /^[+\-#~]/.exec(t)?.[0] as ClassMember["visibility"] | undefined;
    out.push({ raw: t, visibility: vis, kind: /\(.*\)/.test(t) ? "method" : "attribute" });
  }
  return out;
}

function annotationsOf(bodyLines: string[]): string[] {
  return bodyLines
    .map((l) => l.trim())
    .filter((t) => /^<<.*>>$/.test(t))
    .map((t) => t.slice(2, -2));
}

export const classGrammar: LineGrammar = {
  family: "class",
  defaultShape: "classBox",
  directionAsStatement: true,
  defaultEdge: { arrowStart: "none", arrowEnd: "dependency", pattern: "solid" },

  joinLines(lines) {
    return joinBraceBlocks(lines, { open: /^\s*note\s+(for\s+\S+\s+)?"[^"]*$/i, close: /"\s*$/ });
  },

  parseLine(logical) {
    const [line, ...bodyRest] = logical.split("\n");
    const indent = line!.match(/^\s*/)![0];
    const text = line!.trim();
    if (text === "" || text.startsWith("%%") || /^(note|click|link|callback|<<)/.test(text))
      return { kind: "raw", raw: logical, indent };
    if (text === "}") return { kind: "groupClose", raw: line!, indent };
    let m: RegExpExecArray | null;

    if ((m = /^direction\s+(TB|TD|BT|LR|RL)\s*$/i.exec(text)))
      return { kind: "direction", raw: line!, indent, direction: m[1]!.toUpperCase() };
    if ((m = /^classDef\s+(\S+)\s+(.*)$/.exec(text)))
      return {
        kind: "classDef",
        raw: line!,
        indent,
        names: m[1]!.split(","),
        styles: m[2]!
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };
    if ((m = /^cssClass\s+"([^"]+)"\s+(\S+)\s*$/.exec(text)))
      return {
        kind: "class",
        raw: line!,
        indent,
        ids: m[1]!.split(",").map((s) => s.trim()),
        className: m[2]!,
      };
    if ((m = /^style\s+(\S+)\s+(.*)$/.exec(text)))
      return {
        kind: "style",
        raw: line!,
        indent,
        id: m[1]!,
        styles: m[2]!
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };

    if ((m = new RegExp(String.raw`^namespace\s+(${ID})\s*\{\s*$`).exec(text)))
      return { kind: "groupOpen", raw: line!, indent, id: m[1]! };

    // class A["Label"]:::cls {   (body joined)  |  class A
    if (
      (m = new RegExp(
        String.raw`^class\s+(${ID})(?:\["([^"]*)"\])?(?::::(${ID}))?\s*(\{)?\s*$`,
      ).exec(text))
    ) {
      const decl: NodeDecl = { id: m[1]!, label: m[2], classes: m[3] ? [m[3]] : [] };
      if (m[4] && bodyRest.length) {
        decl.data = { members: parseMembers(bodyRest), annotations: annotationsOf(bodyRest) };
        return { kind: "node", raw: line!, indent, decl, body: bodyRest };
      }
      if (m[4] && !bodyRest.length) {
        // `class A {` whose body contains statements → treat as a group-like raw.
        return { kind: "raw", raw: line!, indent };
      }
      return { kind: "node", raw: line!, indent, decl };
    }

    if ((m = RELATION.exec(text))) {
      const rel = CLASS_RELATIONS.find((r) => r.token === m![5])!;
      return {
        kind: "edge",
        raw: line!,
        indent,
        source: { id: m[1]!, label: m[2], classes: m[3] ? [m[3]] : [] },
        target: { id: m[7]!, label: m[8], classes: m[9] ? [m[9]] : [] },
        label: m[10]?.trim() || undefined,
        arrowStart: rel.arrowStart,
        arrowEnd: rel.arrowEnd,
        pattern: rel.pattern,
        data: { cardinalityStart: m[4], cardinalityEnd: m[6] },
      };
    }

    // A : +member
    if ((m = new RegExp(String.raw`^(${ID})\s*:\s*(.+)$`).exec(text))) {
      return {
        kind: "node",
        raw: line!,
        indent,
        decl: { id: m[1]!, classes: [], data: { members: parseMembers([m[2]!]) } },
      };
    }
    return { kind: "raw", raw: logical, indent };
  },

  formatStatement(stmt) {
    switch (stmt.kind) {
      case "node": {
        const d = stmt.decl;
        const members = d.data?.members as ClassMember[] | undefined;
        if (
          !stmt.body &&
          members?.length === 1 &&
          d.label === undefined &&
          !d.classes.length &&
          stmt.raw.includes(" : ")
        ) {
          return `${stmt.indent}${d.id} : ${members[0]!.raw}`;
        }
        let out = `${stmt.indent}class ${d.id}`;
        if (d.label !== undefined && d.label !== d.id) out += `["${d.label.replace(/"/g, "'")}"]`;
        for (const c of d.classes) out += `:::${c}`;
        if (stmt.body) out += " {";
        return out;
      }
      case "edge": {
        const rel = relationFor(stmt.arrowStart, stmt.arrowEnd, stmt.pattern);
        const cs = stmt.data?.cardinalityStart as string | undefined;
        const ce = stmt.data?.cardinalityEnd as string | undefined;
        const fmt = (n: NodeDecl) =>
          n.id +
          (n.label !== undefined ? `["${n.label}"]` : "") +
          n.classes.map((c) => `:::${c}`).join("");
        return `${stmt.indent}${fmt(stmt.source)} ${cs ? `"${cs}" ` : ""}${rel.token} ${ce ? `"${ce}" ` : ""}${fmt(stmt.target)}${stmt.label ? ` : ${stmt.label}` : ""}`;
      }
      case "groupOpen":
        return `${stmt.indent}namespace ${stmt.id} {`;
      case "groupClose":
        return `${stmt.indent}}`;
      case "direction":
        return `${stmt.indent}direction ${stmt.direction}`;
      case "classDef":
        return `${stmt.indent}classDef ${stmt.names.join(",")} ${stmt.styles.join(",")}`;
      case "class":
        return `${stmt.indent}cssClass "${stmt.ids.join(",")}" ${stmt.className}`;
      case "style":
        return `${stmt.indent}style ${stmt.id} ${stmt.styles.join(",")}`;
      default:
        return stmt.raw;
    }
  },

  nodeStatement(decl, indent) {
    const members = decl.data?.members as ClassMember[] | undefined;
    const body = members?.length
      ? [...members.map((m) => `${indent}  ${m.raw}`), `${indent}}`]
      : undefined;
    return {
      kind: "node",
      raw: "",
      indent,
      decl: { ...decl, classes: [...decl.classes] },
      body,
      dirty: true,
    };
  },

  edgeStatement(source, target, spec: EdgeSpec, indent) {
    return {
      kind: "edge",
      raw: "",
      indent,
      source: { id: source, classes: [] },
      target: { id: target, classes: [] },
      label: spec.label,
      arrowStart: spec.arrowStart,
      arrowEnd: spec.arrowEnd,
      pattern: spec.pattern,
      data: spec.data,
      dirty: true,
    };
  },

  groupStatements(id, _label, indent) {
    return {
      open: { kind: "groupOpen", raw: "", indent, id, dirty: true },
      close: { kind: "groupClose", raw: `${indent}}`, indent },
    };
  },

  headerDirection(_header, statements) {
    const top = statements.find((s) => s.kind === "direction");
    return top && top.kind === "direction" ? top.direction : "TB";
  },
};

export type { LineStatement };
